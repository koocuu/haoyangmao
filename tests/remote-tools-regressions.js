"use strict";
const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { CheckService } = require("../lib/remote-checks");
const { CloudChecks, Unavailable, empty } = require("../lib/remote-blob");
const { createHandler } = require("../lib/remote-handler");
const { loadCloudConfig } = require("../lib/remote-config");
const { tools, validate } = require("../mcp/remote-schema");
const engine = require("../lib/deal-engine");

module.exports = async function run() {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, "../config/remote-mcp.example.json"), "utf8"));
  delete config.localImportWorkspace;
  config.allowedHosts = ["mcp.fixture.test"];
  const env = { HYM_GROK_TOKEN: crypto.randomBytes(32).toString("hex"), HYM_DASHBOARD_TOKEN: crypto.randomBytes(32).toString("hex"), HYM_MCP_CONFIG_JSON: JSON.stringify(config), HYM_MCP_BLOB_READ_WRITE_TOKEN: "isolated-private-fixture" };
  const scoped = loadCloudConfig(env), principal = scoped.clients[0], reader = scoped.clients[1];
  const other = { ...principal, id: "other", workspace: "other" };
  scoped.workspaces.other = { ...scoped.workspaces.personal, policy: { minimumProfit: 1000, shippingCost: 333 } };
  let now = Date.now(), sent = [];
  const sku = "iPhone 17 Pro Max 256GB 银色 国行 全新未激活";
  const evidence = (source, ref) => ({ source, reference: `fixture-only:${ref}`, excerpt: "仅隔离测试，非真实核验", observedAt: new Date(now).toISOString(), validUntil: new Date(now + 3600000).toISOString() });
  const conditions = names => Object.fromEntries(names.map(name => [name, { status: "verified", detail: "模拟条件" }]));
  const lead = (key, extra = {}) => ({ idempotencyKey: key, opportunityKey: key, sku, text: `${sku} 实付7000`, buyPrice: 7000, evidence: evidence("酷安", key), conditions: conditions(["finalPrice", "eligibility", "stock", "purchaseRules"]), ...extra });
  const quote = (key, extra = {}) => ({ idempotencyKey: key, sku, price: 7400, text: `${sku} 回收7400`, evidence: evidence("小鸽", key), conditions: conditions(["specification", "acceptance", "deductions", "settlement"]), ...extra });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hym-new-tools-"));
  const file = path.join(dir, "checks.json");
  const service = new CheckService({ config: scoped, file, now: () => now, notify: async notice => { sent.push(notice); } });
  const call = (name, args, actor = principal) => service.call(actor, name, args);
  try {
    // Exact aliases without changing the historical identity normalizer.
    assert.notEqual(engine.normalizeForMatchV2(sku), engine.normalizeForMatchV2(sku.replace("Pro Max", "PM")));
    for (const [cn, english] of [["星宇橙", "cosmic orange"], ["深蓝", "deep blue"], ["银色", "silver"], ["勃艮第酒红", "burgundy"], ["冰川蓝", "glacier blue"]]) {
      const a = sku.replace("银色", cn), b = sku.replace("Pro Max", "PM").replace("银色", english);
      assert.equal(engine.normalizeSkuForMatchV2(a), engine.normalizeSkuForMatchV2(b));
      assert.deepEqual(engine.extractSkuFactsV2(a), engine.extractSkuFactsV2(b));
    }
    for (const replacement of ["冰川蓝", "蓝色", "勃艮第酒红", "红色"]) {
      const a = sku.replace("银色", "深蓝"), b = sku.replace("银色", replacement);
      assert.notEqual(engine.normalizeSkuForMatchV2(a), engine.normalizeSkuForMatchV2(b));
      assert.equal(Number.isFinite(engine.scoreQuoteV2(engine.extractSkuFactsV2(a), { skuName: b })), false);
    }
    assert.notEqual(engine.normalizeSkuForMatchV2(sku.replace("银色", "勃艮第酒红")), engine.normalizeSkuForMatchV2(sku.replace("银色", "红色")));
    assert.equal(engine.normalizeSkuForMatchV2("meeting PM"), engine.normalizeForMatchV2("meeting PM"));
    assert.equal(engine.extractSkuFactsV2(sku.replace("Pro Max", "PM Ultra")).model, "");
    assert.equal(engine.extractSkuFactsV2(sku.replace("未激活", "未激活 已激活")).activation, "");
    for (const variant of [sku.replace("Pro Max", "Pro"), sku.replace("256GB", "512GB"), sku.replace("未激活", "已激活"), sku.replace("未激活", "预激活")]) assert.equal(Number.isFinite(engine.scoreQuoteV2(engine.extractSkuFactsV2(sku), { skuName: variant })), false);

    // Even prune/import/save are forbidden on the local preview path.
    const original = { save: service.save, prune: service.prune, importPending: service.importPending };
    for (const method of Object.keys(original)) service[method] = () => { throw new Error(`preview called ${method}`); };
    const beforePreview = JSON.stringify(service.data);
    const pArgs = { ...lead("preview"), quotes: [quote("preview-q", { sku: sku.replace("Pro Max", "PM"), text: `${sku.replace("Pro Max", "PM")} 回收7400` })] };
    const preview = await call("preview_check", pArgs);
    assert.equal(preview.preview, true); assert.equal(preview.result.status, "eligible"); assert.equal(preview.result.netProfit, 350);
    assert.deepEqual(preview.diagnostics.missingSpecs, []); assert.deepEqual(preview.diagnostics.quotes[0].differences, []);
    assert.equal(JSON.stringify(service.data), beforePreview); assert.equal(fs.existsSync(file), false); assert.equal(sent.length, 0);
    const policyPreview = await call("preview_check", pArgs, other);
    assert.equal(policyPreview.result.netProfit, 37); assert.equal(policyPreview.result.minimumProfit, 1000); assert.equal(policyPreview.result.status, "below_threshold");
    const incompleteSku = "华为 nova 15 Pro 12+256GB 全新 激活状态未知";
    const incomplete = await call("preview_check", { ...lead("incomplete", { sku: incompleteSku, text: `${incompleteSku} 实付7000` }), quotes: [quote("mismatch", { sku: sku.replace("256GB", "512GB") })] });
    for (const field of ["singleColor", "region", "activation"]) assert.ok(incomplete.diagnostics.missingSpecs.includes(field));
    assert.ok(incomplete.diagnostics.quotes[0].differences.includes("model")); assert.ok(incomplete.diagnostics.quotes[0].differences.includes("storage"));
    assert.equal(incomplete.result.status, "pending_confirmation");
    // Even identical lead/quote text cannot certify a contradictory SKU.
    for (const [candidate, field] of [
      [sku.replace("256GB", "256GB 512GB"), "storage"],
      [sku.replace("国行", "国行 港版"), "region"],
      [sku.replace("全新", "全新 二手"), "condition"]
    ]) {
      const result = await call("preview_check", { ...lead("ambiguous", { sku: candidate, text: `${candidate} 实付7000` }), quotes: [quote("ambiguous-q", { sku: candidate, text: `${candidate} 回收7400` })] });
      assert.equal(result.result.status, "pending_confirmation"); assert.equal(result.result.netProfit, null);
      assert.ok(result.diagnostics.missingSpecs.includes(field));
    }
    const unknownPurchase = lead("unknown-profit"); unknownPurchase.conditions.stock.status = "unknown";
    const unknownProfit = await call("preview_check", { ...unknownPurchase, quotes: [quote("known-quote")] });
    assert.equal(unknownProfit.result.status, "pending_confirmation"); assert.equal(unknownProfit.result.netProfit, null);
    assert.equal(unknownProfit.result.sellPrice, 7400, "keep source price as evidence, not verified profit");
    const expiredBuy = lead("expired-profit"); expiredBuy.evidence.observedAt = new Date(now - 61 * 60000).toISOString();
    const expiredProfit = await call("preview_check", { ...expiredBuy, quotes: [quote("fresh-quote")] });
    assert.equal(expiredProfit.result.netProfit, null); assert.ok(expiredProfit.result.reasons.includes("购买线索过期"));
    await assert.rejects(call("preview_check", pArgs, reader), /Tool not authorized/);
    await assert.rejects(call("preview_check", { ...pArgs, quotes: Array(11).fill(quote("bound")) }), /Invalid arguments.quotes/);
    Object.assign(service, original);

    const saved = await call("submit_lead", lead("preview"));
    const submitted = await call("submit_quotes", { checkId: saved.id, quotes: pArgs.quotes });
    assert.deepEqual({ ...submitted.result, quoteId: null }, { ...preview.result, quoteId: null }, "preview and real evaluate share trusted policy/engine, with independent ephemeral IDs");
    assert.equal(sent.length, 1);

    // Partial schema/scope/key conflicts cannot erase earlier valid items or leave receipts.
    const batchLead = await call("submit_lead", lead("batch"));
    const high = quote("batch-high"), low = quote("batch-low", { price: 7050, text: `${sku} 回收7050`, evidence: evidence("踏浪", "low") });
    const batchArgs = { checkId: batchLead.id, quotes: [high, { ...quote("bad-schema"), price: "7400" }, quote("bad-source", { evidence: evidence("unapproved", "bad") }), { ...high, price: 7300 }, low] };
    const batch = await call("submit_quotes", batchArgs);
    assert.deepEqual(batch.items.map(item => item.success), [true, false, false, false, true]);
    assert.match(batch.items[3].error, /Idempotency conflict/);
    assert.equal(batch.quotes.length, 2); assert.equal(batch.result.status, "below_threshold"); assert.equal(batch.result.netProfit, 0); assert.equal(sent.length, 1, "no intermediate high-price notice");
    const count = service.data.receipts.length;
    const replay = await call("submit_quotes", batchArgs);
    assert.equal(replay.items[0].replayed, true); assert.equal(replay.items[4].replayed, true); assert.equal(service.data.receipts.length, count);
    assert.equal((await call("submit_quote", { ...high, checkId: batchLead.id })).replayed, true);
    await assert.rejects(call("submit_quote", { ...high, checkId: batchLead.id, price: 1 }), /Idempotency conflict/);
    const beforeCross = JSON.stringify(service.data);
    await assert.rejects(call("submit_quotes", batchArgs, other), /Check not found/);
    assert.equal(JSON.stringify(service.data), beforeCross);
    await assert.rejects(call("submit_quotes", batchArgs, reader), /Tool not authorized/);
    await assert.rejects(call("submit_quotes", { ...batchArgs, userId: "fake" }), /Invalid arguments/);
    const invalidPreview = await call("preview_check", { ...lead("invalid-row"), quotes: [high, { price: 1 }] });
    assert.deepEqual(invalidPreview.items.map(item => item.success), [true, false]);
    // Force a failure after quote+receipt mutation to verify per-item rollback.
    const originalApply = service.applySubmission;
    service.applySubmission = function(actor, name, args) {
      const result = originalApply.call(this, actor, name, args);
      if (args.idempotencyKey === "failure-after-staging") throw new Error("private parser error must not escape");
      return result;
    };
    const stagedBefore = JSON.stringify(service.data.checks.find(check => check.id === batchLead.id));
    const countBeforeFailure = service.data.receipts.length;
    const rolledBack = await call("submit_quotes", { checkId: batchLead.id, quotes: [quote("failure-after-staging")] });
    assert.equal(rolledBack.items[0].success, false); assert.equal(rolledBack.items[0].error.includes("private parser"), false);
    assert.equal(JSON.stringify(service.data.checks.find(check => check.id === batchLead.id)), stagedBefore); assert.equal(service.data.receipts.length, countBeforeFailure);
    service.applySubmission = originalApply;

    // Limit failure rolls back only that item, not the 20th accepted quote.
    const bounded = service.find(principal, batchLead.id);
    bounded.lead.conditions.stock = { status: "unknown", detail: "capacity fixture stays pending" };
    bounded.quotes = Array.from({ length: 19 }, (_, index) => ({ ...structuredClone(bounded.quotes[0]), id: `bounded-${index}` }));
    const capacity = await call("submit_quotes", { checkId: bounded.id, quotes: [quote("twentieth"), quote("twentyfirst")] });
    assert.deepEqual(capacity.items.map(item => item.success), [true, false]); assert.equal(capacity.quotes.length, 20); assert.match(capacity.items[1].error, /Recent quote capacity/);

    // Void preserves first audit, receipts/notices and blocks ALL replays/aliases.
    const auditsBefore = service.data.notices.length, receiptsBefore = service.data.receipts.length;
    const voided = await call("void_check", { checkId: saved.id, reason: "isolated fixture finished" });
    assert.equal(voided.result.status, "voided"); assert.equal(voided.result.netProfit, null);
    const audit = structuredClone(voided.voided); now += 1000;
    const repeated = await call("void_check", { checkId: saved.id, reason: "cannot overwrite first reason" });
    assert.equal(repeated.replayed, true); assert.deepEqual(repeated.voided, audit);
    assert.equal(service.data.notices.length, auditsBefore); assert.equal(service.data.receipts.length, receiptsBefore);
    assert.equal((await call("get_status", {})).items.some(check => check.id === saved.id), false);
    assert.equal((await call("get_pending_checks", {})).items.some(check => check.id === saved.id), false);
    assert.equal((await call("get_status", { includeVoided: true })).items.some(check => check.id === saved.id), true);
    assert.equal((await call("get_status", { checkId: saved.id })).result.status, "voided");
    for (const [name, args] of [["submit_lead", lead("preview")], ["submit_quote", { ...pArgs.quotes[0], checkId: saved.id }], ["submit_quotes", { checkId: saved.id, quotes: [high] }], ["submit_lead", lead("alias-void", { sku: sku.replace("Pro Max", "PM"), text: `${sku.replace("Pro Max", "PM")} 实付7000`, evidence: evidence("酷安", "preview") })]]) await assert.rejects(call(name, args), /Check is voided/);
    await assert.rejects(call("void_check", { checkId: saved.id, reason: "foreign" }, other), /Check not found/);
    assert.equal(sent.length, 1);

    // Old check identity is preserved through alias updates, even new opportunityKey.
    const oldSku = sku.replace("银色", "deep blue");
    const old = await call("submit_lead", lead("legacy", { sku: oldSku, text: `${oldSku} 实付7000`, evidence: evidence("酷安", "stable-ref") }));
    const legacyKey = old.identity;
    const aliasSku = sku.replace("银色", "深蓝").replace("Pro Max", "PM");
    const aliased = await call("submit_lead", lead("alias-new", { sku: aliasSku, text: `${aliasSku} 实付7000`, evidence: evidence("酷安", "stable-ref") }));
    assert.equal(aliased.id, old.id); assert.equal(aliased.identity, legacyKey);
    const aliasUpdate = lead("alias-new", { sku: aliasSku, text: `${aliasSku} 实付7000`, evidence: evidence("酷安", "stable-ref") });
    const beforeKeyConflicts = JSON.stringify(service.data);
    for (const [label, overrides] of [
      ["source", { evidence: evidence("AH", "stable-ref") }],
      ["reference", { evidence: evidence("酷安", "other-ref") }],
      ["sku", { sku: aliasSku.replace("256GB", "512GB"), text: `${aliasSku.replace("256GB", "512GB")} 实付7000` }]
    ]) await assert.rejects(call("submit_lead", { ...aliasUpdate, ...overrides, idempotencyKey: `reused-alias-${label}` }), /Opportunity identity cannot change/);
    assert.equal(JSON.stringify(service.data), beforeKeyConflicts, "rejected reuse leaves no record/revision/receipt");
    const nextAlias = await call("submit_lead", { ...aliasUpdate, opportunityKey: "alias-third", idempotencyKey: "alias-third" });
    assert.equal(nextAlias.id, old.id); assert.equal(nextAlias.identity, legacyKey);
    await assert.rejects(call("submit_lead", { ...aliasUpdate, idempotencyKey: "historical-alias-conflict", evidence: evidence("酷安", "changed-historical-ref") }), /Opportunity identity cannot change/);
    // Pre-fix state might already contain two conflicting bindings. Preserve
    // both records and refuse writes, regardless of their physical list order.
    const legacyDuplicate = structuredClone(service.find(principal, old.id));
    legacyDuplicate.id = "fixture-legacy-duplicate"; legacyDuplicate.identity = "fixture-conflicting-identity";
    legacyDuplicate.lead.evidence.source = "AH";
    service.data.checks.push(legacyDuplicate);
    const beforeDuplicate = JSON.stringify(service.data);
    await assert.rejects(call("submit_lead", { ...aliasUpdate, opportunityKey: "alias-third", idempotencyKey: "legacy-duplicate-attempt" }), /Opportunity identity cannot change/);
    assert.equal(JSON.stringify(service.data), beforeDuplicate);
    service.data.checks.pop();
    await assert.rejects(call("submit_lead", lead("legacy", { idempotencyKey: "bad-identity", evidence: evidence("酷安", "changed-reference") })), /Opportunity identity/);
    const quoteOld = quote("legacy-q", { sku: oldSku, text: `${oldSku} 回收7400` });
    await call("submit_quote", { ...quoteOld, checkId: old.id }); assert.equal(sent.length, 2);
    const legacyNotice = service.data.notices.find(notice => notice.identity === legacyKey);
    delete legacyNotice.canonicalIdentity; // Exactly the old 30-day hash-only shape.
    now += 8 * 86400000;
    const afterPrune = await call("submit_lead", lead("after-seven-days", { sku: aliasSku, text: `${aliasSku} 实付7000`, evidence: evidence("酷安", "stable-ref") }));
    assert.equal(afterPrune.identity, legacyKey, "legacy notice hash survives alias and 7-day check cleanup");
    await call("submit_quote", { ...quote("alias-after-prune", { sku: aliasSku, text: `${aliasSku} 回收7400` }), checkId: afterPrune.id });
    assert.equal(sent.length, 2, "30-day old notice prevents alias re-notification");
    assert.equal(service.data.notices.some(notice => notice.identity === legacyKey), true);
  } finally { service.close(); fs.rmSync(dir, { recursive: true, force: true }); }

  // Production handler preview bypasses store construction, notify factory and
  // acquire/release, even if storage would be unavailable.
  let storageCalls = 0, notifyCalls = 0;
  const handler = createHandler({ env, now: () => now, storeFactory: () => { storageCalls++; throw new Error("must never construct storage for preview"); }, notifyFactory: () => { notifyCalls++; throw new Error("must not construct notifier"); } });
  async function request(tool, args, key = env.HYM_GROK_TOKEN, chosen = handler) {
    let status, body;
    await chosen({ method: "POST", headers: { host: "mcp.fixture.test", authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } } }, { setHeader() {}, set statusCode(value) { status = value; }, end(value) { body = JSON.parse(value); } });
    return { status, body };
  }
  const args = { ...lead("handler-preview"), quotes: [quote("handler-preview-q")] };
  assert.equal((await request("preview_check", args)).body.result.structuredContent.result.netProfit, 350);
  assert.equal((await request("preview_check", args, env.HYM_DASHBOARD_TOKEN)).body.result.isError, true);
  const legacyConfig = structuredClone(config); legacyConfig.clients[0].tools = ["submit_lead", "submit_quote", "get_status", "get_pending_checks"];
  const legacyHandler = createHandler({ env: { ...env, HYM_MCP_CONFIG_JSON: JSON.stringify(legacyConfig) }, storeFactory: () => { storageCalls++; } });
  assert.equal((await request("preview_check", args, env.HYM_GROK_TOKEN, legacyHandler)).body.result.isError, true);
  assert.equal((await request("preview_check", { ...args, evidence: evidence("unapproved", "preview") })).body.result.isError, true);
  assert.equal((await request("preview_check", { ...args, text: "x".repeat(33000) })).status, 413);
  for (let index = 1; index < 120; index++) assert.equal((await request("preview_check", args)).status, 200);
  assert.equal((await request("preview_check", args)).status, 429);
  assert.equal(storageCalls, 0); assert.equal(notifyCalls, 0);
  assert.throws(() => validate({ checkId: "x", quotes: [{ price: "not-number" }] }, tools.find(tool => tool.name === "submit_quotes").inputSchema), /Invalid/);

  // Acknowledgement loss after a batch CAS cannot report success or send/retry.
  let state = empty(), lose = false, cloudSent = 0;
  const store = {
    async transaction(mutate) { const next = structuredClone(state); const value = await mutate(next); state = next; if (lose) { lose = false; throw new Unavailable("write_sdk_failure"); } return value; },
    async read() { return { data: structuredClone(state), etag: '"fixture"' }; }
  };
  const notify = async () => { cloudSent++; }; notify.available = () => true;
  const cloud = new CloudChecks({ config: scoped, store, notify, now: () => now });
  const cloudLead = await cloud.call(principal, "submit_lead", lead("cloud-unknown"));
  lose = true;
  const cArgs = { checkId: cloudLead.id, quotes: [quote("cloud-q")] };
  await assert.rejects(cloud.call(principal, "submit_quotes", cArgs), Unavailable);
  assert.equal(cloudSent, 0); assert.equal(state.checks[0].quotes.length, 1); assert.equal(state.notices[0].status, "delivery_unknown");
  assert.equal((await cloud.call(principal, "submit_quotes", cArgs)).items[0].replayed, true); assert.equal(cloudSent, 0);

  // Void wins before the final pre-send read: reservation remains audited, no send.
  const raced = await cloud.call(principal, "submit_lead", lead("void-before-send"));
  const read = store.read;
  store.read = async () => { store.read = read; await cloud.call(principal, "void_check", { checkId: raced.id, reason: "void won before final check" }); return read(); };
  const skipped = await cloud.call(principal, "submit_quotes", { checkId: raced.id, quotes: [quote("void-before-q")] });
  assert.equal(skipped.result.status, "voided"); assert.equal(cloudSent, 0); assert.equal(skipped.items[0].success, true);
  // Once external sending starts, void cannot promise to retract it.
  const started = await cloud.call(principal, "submit_lead", lead("void-after-send-start"));
  cloud.notify = async () => { cloudSent++; await cloud.call(principal, "void_check", { checkId: started.id, reason: "send already started" }); };
  cloud.notify.available = () => true;
  const completed = await cloud.call(principal, "submit_quotes", { checkId: started.id, quotes: [quote("void-after-q")] });
  assert.equal(completed.result.status, "voided"); assert.equal(completed.notification.status, "sent"); assert.equal(cloudSent, 1);
  const noStorePreview = await cloud.call(principal, "preview_check", args); assert.equal(noStorePreview.preview, true);
  console.log("new MCP tools regressions ok: bounded partial batch/replay/rollback/final notice; zero-storage preview/policy/diagnostics/rate; void audit/workspace/replay/send race; exact aliases/old 30-day notice; 酷安; no real data or notifications");
};
if (require.main === module) module.exports().catch(error => { console.error(error); process.exitCode = 1; });
