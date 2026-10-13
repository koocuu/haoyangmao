"use strict";
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const crypto = require("crypto");
const { fork, spawnSync } = require("child_process");
const { once } = require("events");
const { createHandler } = require("../lib/remote-handler");
const { loadCloudConfig } = require("../lib/remote-config");
const { BlobStore, PATH, empty, Unavailable } = require("../lib/remote-blob");

async function main() {
  let now = Date.now(), state = null, revision = 0, fault = null, deliveries = 0, writes = 0, reads = 0;
  const workers = [];
  const token = crypto.randomBytes(32).toString("hex"), reader = crypto.randomBytes(32).toString("hex");
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, "../config/remote-mcp.example.json")));
  delete config.localImportWorkspace;
  config.allowedHosts = ["mcp.fixture.test"];
  config.allowedOrigins = ["https://dashboard.fixture.test"];
  const env = { HYM_GROK_TOKEN: token, HYM_DASHBOARD_TOKEN: reader, HYM_MCP_CONFIG_JSON: JSON.stringify(config), HYM_MCP_BLOB_READ_WRITE_TOKEN: "private-fixture-store", BLOB_READ_WRITE_TOKEN: "public-fixture-store" };
  const backend = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    if (req.url === "/notify") {
      assert.equal(req.method, "POST");
      const notice = JSON.parse(body);
      assert.ok(state.notices.some((n) => n.attemptId === notice.attemptId && n.status === "delivery_unknown"), "notification placeholder must already be durable before outbound attempt");
      deliveries++;
      res.writeHead(fault === "notifyLost" ? 503 : 200); res.end("fixture only"); return;
    }
    const options = JSON.parse(req.headers["x-options"]);
    assert.equal(options.path, PATH); assert.equal(options.access, "private"); assert.equal(options.token, env.HYM_MCP_BLOB_READ_WRITE_TOKEN);
    if (req.method === "GET") {
      reads++;
      assert.equal(options.useCache, false);
      assert.equal(options.headers["Accept-Encoding"], "identity");
      if (state === null) { res.writeHead(404); res.end(); return; }
      const value = typeof state === "string" ? state : JSON.stringify(state);
      res.writeHead(200, { etag: `"${revision}"`, "content-length": Buffer.byteLength(value) }); res.end(value); return;
    }
    writes++;
    assert.equal(options.addRandomSuffix, false); assert.equal(options.multipart, false);
    if (state === null) {
      assert.equal(options.allowOverwrite, false); assert.equal(options.ifMatch, undefined);
    } else {
      if (options.allowOverwrite === false) { res.writeHead(409); res.end(); return; }
      assert.ok(options.ifMatch, "every overwrite must be conditional");
      if (options.ifMatch !== `"${revision}"`) { res.writeHead(412); res.end(); return; }
    }
    const next = JSON.parse(body);
    const reserved = next.notices.length > (state?.notices?.length || 0);
    state = next; revision++;
    if (fault === "reservationLost" && reserved) { fault = null; res.writeHead(503); res.end("write committed but acknowledgement lost"); return; }
    res.writeHead(200, { etag: `"${revision}"` }); res.end();
  });
  await new Promise((resolve) => backend.listen(0, "127.0.0.1", resolve));
  async function worker(workspaceEnv = env, notifyEnabled = true) {
    const child = fork(path.join(__dirname, "cloud-mcp-worker.js"), [], {
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP,
        FIXTURE_ENV: JSON.stringify(workspaceEnv), FIXTURE_NOW: String(now), FIXTURE_BACKEND: `http://127.0.0.1:${backend.address().port}`, FIXTURE_NOTIFY: notifyEnabled ? "enabled" : "disabled" },
      stdio: ["ignore", "inherit", "inherit", "ipc"]
    });
    workers.push(child);
    const [message] = await once(child, "message");
    return message.url;
  }
  let rpcId = 0;
  async function rpc(url, method, params, key = token, extra = {}, options = {}) {
    const body = JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params });
    return new Promise((resolve, reject) => {
      const request = http.request(url, { method: "POST", headers: { Host: "mcp.fixture.test", Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25", ...extra }, ...options }, async (response) => {
        try {
          const chunks = []; for await (const chunk of response) chunks.push(chunk);
          resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")), headers: new Headers(response.headers) });
        } catch (error) { reject(error); }
      });
      request.on("error", reject); request.end(body);
    });
  }
  const call = (url, name, args = {}, key = token) => rpc(url, "tools/call", { name, arguments: args }, key);
  const value = (response) => { assert.equal(response.status, 200, JSON.stringify(response)); assert.equal(response.body.result.isError, false, JSON.stringify(response)); return response.body.result.structuredContent; };
  const sku = "iPhone 16 256G 国行 黑色 全新未激活";
  const conditions = (names) => Object.fromEntries(names.map((name) => [name, { status: "verified", detail: "仅测试证据，逐项核实" }]));
  const evidence = (source, reference, minutes = 0) => ({ source, reference, excerpt: "fixture 真实对应规格及金额", observedAt: new Date(now - minutes * 60000).toISOString(), validUntil: new Date(now + 3600000).toISOString() });
  const lead = (key, overrides = {}) => ({ idempotencyKey: key, opportunityKey: key, sku, buyPrice: 5599, text: `PDD ${sku} 券后 5599`, evidence: evidence("PDD", `fixture:${key}`), conditions: conditions(["finalPrice", "eligibility", "stock", "purchaseRules"]), ...overrides });
  const quote = (id, key, overrides = {}) => ({ idempotencyKey: key, checkId: id, sku, price: 5800, text: `${sku} 回收 5800`, evidence: evidence("小鸽", `fixture:${key}`), conditions: conditions(["specification", "acceptance", "deductions", "settlement"]), ...overrides });
  async function setClock(next) { now = next; await Promise.all(workers.map(async (child) => { const ack = once(child, "message"); child.send({ now }); await ack; })); }
  try {
    // The production export fails closed with missing env, before any SDK calls.
    const invalid = await worker({});
    assert.equal((await rpc(invalid, "ping", {})).status, 503);
    assert.throws(() => loadCloudConfig({ ...env, HYM_MCP_CONFIG_JSON: JSON.stringify({ ...config, localImportWorkspace: "personal" }) }));
    assert.throws(() => loadCloudConfig({ ...env, HYM_DASHBOARD_TOKEN: token }));
    assert.throws(() => loadCloudConfig({ ...env, HYM_MCP_CONFIG_JSON: JSON.stringify({ ...config, allowedHosts: [] }) }));
    const a = await worker(), b = await worker(), c = await worker();
    // Independent OS processes racing first creation must never overwrite one another.
    const initialized = await Promise.all([rpc(a, "initialize", { protocolVersion: "2025-11-25" }), rpc(b, "initialize", { protocolVersion: "2025-06-18" })]);
    initialized.forEach((result) => assert.equal(result.status, 200));
    assert.ok(state); assert.equal(state.rates.find((r) => r.key === "grok").count, 2);
    assert.equal((await rpc(a, "tools/list", {})).body.result.tools.length, 7);
    assert.deepEqual((await rpc(a, "tools/list", {}, reader)).body.result.tools.map((t) => t.name), ["get_status"]);
    const beforeAuth = { reads, writes };
    assert.equal((await rpc(a, "ping", {}, "wrong")).status, 401);
    assert.equal((await rpc(a, "ping", {}, token, { Host: "evil.test" })).status, 403);
    assert.equal((await rpc(a, "ping", {}, token, { Origin: "https://evil.test" })).status, 403);
    assert.equal((await rpc(a, "ping", {}, token, { "MCP-Protocol-Version": "wrong" })).status, 400);
    assert.deepEqual({ reads, writes }, beforeAuth, "Bearer/Host/Origin/protocol failures never access storage");
    const cors = await rpc(a, "ping", {}, reader, { Origin: config.allowedOrigins[0] });
    assert.equal(cors.headers.get("access-control-allow-origin"), config.allowedOrigins[0]);
    assert.equal(cors.headers.get("access-control-expose-headers"), "Retry-After");
    assert.equal(cors.headers.get("cache-control"), "no-store");
    const beforeScopes = { reads, writes };
    assert.equal((await call(a, "submit_lead", lead("reader"), reader)).body.result.isError, true);
    assert.equal((await call(a, "submit_lead", { ...lead("unknown-field"), userId: "fake" })).body.result.isError, true);
    assert.equal((await call(a, "submit_lead", lead("source", { evidence: evidence("unapproved", "x") }))).body.result.isError, true);
    assert.equal((await call(a, "submit_lead", lead("family", { sku: "UnknownBrand 全新" }))).body.result.isError, true);
    assert.deepEqual({ reads, writes }, beforeScopes, "tool/source/family and malformed arguments fail before storage");
    assert.equal((await call(a, "get_status", { limit: 51 })).body.result.isError, true);
    assert.equal((await rpc(a, "ping", { blob: "x".repeat(33000) })).status, 413);

    const beforeRead = writes;
    assert.equal(value(await call(a, "get_status", {}, reader)).total, 0);
    assert.equal(writes - beforeRead, 2, "unchanged status read writes only admission/release, preserving distributed limits");
    state.checks.push({ id: "stale-cleanup-fixture", workspace: "personal", updatedAt: new Date(now - 8 * 86400000).toISOString(), quotes: [] }); revision++;
    const beforeCleanup = writes;
    assert.equal(value(await call(a, "get_status", {}, reader)).total, 0);
    assert.equal(writes - beforeCleanup, 3, "retention cleanup still persists with conditional CAS");
    assert.equal(state.checks.length, 0);

    const pending = lead("main"); pending.conditions.eligibility.status = "unknown";
    const first = value(await call(a, "submit_lead", pending));
    const id = first.id;
    assert.equal(first.result.status, "pending_confirmation");
    const quoted = value(await call(b, "submit_quote", quote(id, "main-q")));
    assert.equal(quoted.result.netProfit, null); assert.equal(quoted.result.status, "pending_confirmation"); assert.equal(deliveries, 0);
    const completed = { ...pending, idempotencyKey: "verified", conditions: conditions(["finalPrice", "eligibility", "stock", "purchaseRules"]) };
    const raced = await Promise.all([call(a, "submit_lead", completed), call(b, "submit_lead", completed), call(c, "submit_lead", completed)]);
    raced.forEach(value);
    assert.equal(raced.filter((r) => !r.body.result.structuredContent.replayed).length, 1);
    assert.equal(state.receipts.filter((r) => r.checkId === id).length, 3);
    assert.equal(state.checks.find((r) => r.id === id).quotes.length, 1);
    assert.equal(deliveries, 1);
    assert.equal(value(await call(c, "get_status", { checkId: id }, reader)).notification.status, "sent");
    assert.equal((await call(a, "submit_lead", { ...completed, buyPrice: 1 })).body.result.isError, true);
    value(await call(b, "submit_lead", { ...completed, idempotencyKey: "alias", opportunityKey: "alias" }));
    assert.equal(deliveries, 1);

    // Two distinct submissions in different processes both persist (no lost update).
    const different = await Promise.all([call(a, "submit_lead", lead("independent-a")), call(b, "submit_lead", lead("independent-b"))]);
    different.forEach(value);
    assert.ok(state.checks.some((r) => r.lead.opportunityKey === "independent-a"));
    assert.ok(state.checks.some((r) => r.lead.opportunityKey === "independent-b"));
    const otherConfig = structuredClone(config); otherConfig.workspaces.other = otherConfig.workspaces.personal; otherConfig.clients[0].workspace = "other";
    const other = await worker({ ...env, HYM_MCP_CONFIG_JSON: JSON.stringify(otherConfig) });
    assert.equal(value(await call(other, "get_status")).total, 0);
    assert.equal((await call(other, "submit_quote", quote(id, "cross"))).body.result.isError, true);
    assert.equal((await call(other, "get_status", { checkId: id })).body.result.isError, true);

    const stale = value(await call(a, "submit_lead", lead("stale")));
    assert.equal(value(await call(b, "submit_quote", quote(stale.id, "stale-q", { evidence: evidence("小鸽", "stale", 31) }))).result.status, "pending_confirmation");
    const mismatch = value(await call(a, "submit_lead", lead("mismatch")));
    assert.equal(value(await call(b, "submit_quote", quote(mismatch.id, "mismatch-q", { sku: sku.replace("256G", "512G") }))).result.status, "pending_confirmation");
    assert.equal(deliveries, 1);

    // A committed reservation with a lost response never sends, even on replay/new instance.
    const lost = value(await call(a, "submit_lead", lead("lost-reservation")));
    const lostQuote = quote(lost.id, "lost-q"); fault = "reservationLost";
    assert.equal((await call(b, "submit_quote", lostQuote)).status, 503);
    assert.equal(deliveries, 1);
    assert.equal(value(await call(c, "submit_quote", lostQuote)).replayed, true);
    assert.equal(value(await call(a, "get_status", { checkId: lost.id })).notification.status, "delivery_unknown");
    assert.equal(deliveries, 1);

    const unknown = value(await call(a, "submit_lead", lead("unknown-delivery")));
    fault = "notifyLost";
    const unknownQuote = quote(unknown.id, "unknown-q");
    assert.equal(value(await call(b, "submit_quote", unknownQuote)).notification.status, "delivery_unknown");
    assert.equal(deliveries, 2);
    fault = null;
    value(await call(c, "submit_quote", unknownQuote)); value(await call(a, "get_pending_checks"));
    assert.equal(deliveries, 2);

    // Fresh window for bounded new business regressions; isolated process has
    // notifications disabled and writes only the shared mock private store.
    await setClock(now + 60000);
    const business = await worker(env, false);
    await require("./cloud-business-regressions")({ call, value, url: business, lead, quote, evidence, conditions, now });
    assert.equal(deliveries, 2);

    await setClock(now + 60000);
    // Actual independent OS handlers: previews cannot touch even lease/rate Blob
    // state. Different quote aliases agree without changing historical IDs.
    const aliasSku = "iPhone 17 Pro Max 256GB 深蓝 国行 全新未激活";
    const quoteAlias = aliasSku.replace("Pro Max", "PM").replace("深蓝", "deep blue");
    const { checkId: ignoredPreviewId, ...previewQuote } = quote("unused", "preview-q", { sku: quoteAlias, price: 7400, text: `${quoteAlias} 回收7400` });
    const previewArgs = { ...lead("cloud-preview", { sku: aliasSku, text: `${aliasSku} 实付7000`, buyPrice: 7000, evidence: evidence("酷安", "preview-fixture") }), quotes: [previewQuote] };
    const beforePreview = { reads, writes, deliveries, state: JSON.stringify(state) };
    const previews = await Promise.all([call(a, "preview_check", previewArgs), call(b, "preview_check", previewArgs)]);
    previews.forEach(response => { const p = value(response); assert.equal(p.result.netProfit, 350); assert.deepEqual(p.diagnostics.quotes[0].differences, []); });
    assert.deepEqual({ reads, writes, deliveries, state: JSON.stringify(state) }, beforePreview);

    const batchLead = value(await call(a, "submit_lead", lead("cloud-batch-final-price", { evidence: evidence("酷安", "cloud-batch-final-price") })));
    const item = (key, price, source = "小鸽") => { const { checkId, ...q } = quote(batchLead.id, key, { price, text: `${sku} 回收${price}`, evidence: evidence(source, key) }); return q; };
    const batchArgs = { checkId: batchLead.id, quotes: [item("batch-high", 5800), { ...item("batch-schema", 5800), price: "bad" }, item("batch-source", 5800, "unapproved"), item("batch-high", 5799), item("batch-low", 5650, "踏浪")] };
    const batchRace = await Promise.all([call(a, "submit_quotes", batchArgs), call(b, "submit_quotes", batchArgs), call(c, "submit_quotes", batchArgs)]);
    for (const response of batchRace) {
      const result = value(response); assert.deepEqual(result.items.map(item => item.success), [true, false, false, false, true]);
      assert.equal(result.result.status, "below_threshold"); assert.equal(result.result.netProfit, 1); assert.equal(result.id, batchLead.id);
    }
    assert.equal(state.checks.find(check => check.id === batchLead.id).quotes.length, 2);
    assert.equal(state.receipts.filter(receipt => receipt.checkId === batchLead.id).length, 3);
    assert.equal(deliveries, 2, "batch sends no intermediate high-price notification");
    assert.equal(value(await call(c, "submit_quote", { ...batchArgs.quotes[0], checkId: batchLead.id })).replayed, true);
    assert.equal((await call(other, "submit_quotes", batchArgs)).body.result.isError, true);
    // One CAS winner may accept a quote before void; nothing may revive after it.
    const voidRace = await Promise.all([call(a, "void_check", { checkId: batchLead.id, reason: "isolated production-handler fixture" }), call(b, "submit_quotes", { checkId: batchLead.id, quotes: [item("void-raced", 5650)] })]);
    assert.equal(value(voidRace[0]).result.status, "voided");
    const audit = value(await call(c, "get_status", { checkId: batchLead.id })).voided;
    assert.deepEqual(value(await call(b, "void_check", { checkId: batchLead.id, reason: "must not replace first" })).voided, audit);
    assert.equal(value(await call(a, "get_status", { limit: 50 })).items.some(check => check.id === batchLead.id), false);
    assert.equal(value(await call(a, "get_status", { includeVoided: true, limit: 50 })).items.some(check => check.id === batchLead.id), true);
    assert.equal((await call(other, "void_check", { checkId: batchLead.id, reason: "foreign" })).body.result.isError, true);
    assert.equal((await call(a, "submit_quotes", batchArgs)).body.result.isError, true);
    assert.equal((await call(a, "submit_quote", { ...batchArgs.quotes[0], checkId: batchLead.id })).body.result.isError, true);
    assert.equal(deliveries, 2);

    await setClock(now + 31 * 60000);
    assert.equal(value(await call(a, "get_status", { checkId: id })).result.status, "pending_confirmation");
    assert.equal(deliveries, 2);
    const unconfigured = await worker(env, false);
    const deferred = value(await call(unconfigured, "submit_lead", lead("unconfigured")));
    assert.equal(value(await call(unconfigured, "submit_quote", quote(deferred.id, "unconfigured-q"))).notification.status, "not_configured");
    assert.equal(deliveries, 2);
    // Read-only tools never deliver; a later submission replay may claim a fresh notice.
    value(await call(a, "get_status", { checkId: deferred.id })); assert.equal(deliveries, 2);
    value(await call(b, "get_pending_checks")); assert.equal(deliveries, 2);
    value(await call(a, "submit_quote", quote(deferred.id, "unconfigured-q"))); assert.equal(deliveries, 3);
    value(await call(b, "get_status", { checkId: deferred.id })); assert.equal(deliveries, 3);

    // Persisted limits are enforced across instances, never by process locks.
    const beforeLimit = structuredClone(state);
    state.rates = [{ key: "grok", start: now, count: 120 }]; revision++;
    assert.equal((await call(c, "get_status")).status, 429);
    state = structuredClone(beforeLimit); state.leases = Array.from({ length: 20 }, (_, i) => ({ id: String(i), until: now + 60000 })); revision++;
    assert.equal((await call(b, "get_status")).status, 429);
    state = beforeLimit; revision++;
    await setClock(now + 8 * 86400000);
    assert.equal(value(await call(a, "get_status")).total, 0);
    assert.equal(state.receipts.length, 0); assert.equal(state.notices.length, 4);
    await setClock(now + 23 * 86400000);
    value(await call(b, "get_status")); assert.equal(state.notices.length, 0);
    state = "corrupt private blob"; revision++;
    assert.equal((await call(c, "get_status")).status, 503);
    assert.equal(state, "corrupt private blob", "never reset corrupted state");
    assert.ok(writes > 20);
    console.log("cloud MCP multi-process e2e ok: 3 independent handlers, exclusive create/CAS/auth/scopes/151 profit/idempotency/stale quotes/retention/distributed limits; 3 mock attempts, no real notifications");
  } finally {
    for (const child of workers) if (child.connected) child.send({ stop: true });
    await Promise.all(workers.map((child) => child.exitCode === null ? once(child, "exit") : Promise.resolve()));
    backend.close(); backend.closeAllConnections();
  }
  await sdkContract();
  await boundedTransactions();
  await safeDiagnostics();
  await deploymentClosure();
}

async function safeDiagnostics() {
  const sdkTypes = require("@vercel/blob");
  const sdk = { ...sdkTypes };
  const store = new BlobStore({ token: "fixture", sdk });
  const snapshot = (text = JSON.stringify(empty()), etag = '"v1"') => ({ statusCode: 200, blob: { etag, size: 0 }, stream: new Response(text).body });
  const reason = (code) => (error) => error instanceof Unavailable && error.reason === code;
  sdk.get = async () => { throw new sdkTypes.BlobAccessError(); };
  await assert.rejects(store.read(), (e) => reason("read_sdk_failure")(e) && e.sdkClass === "BlobAccessError");
  sdk.get = async () => ({ statusCode: 304 });
  await assert.rejects(store.read(), reason("read_metadata_invalid"));
  sdk.get = async () => snapshot(undefined, "");
  await assert.rejects(store.read(), reason("read_etag_missing"));
  sdk.get = async () => snapshot("private-invalid-json");
  await assert.rejects(store.read(), reason("read_json_decode"));
  sdk.get = async () => snapshot("null");
  await assert.rejects(store.read(), reason("read_state_invalid"));
  sdk.put = async () => ({});
  await assert.rejects(store.write(empty(), '"v1"'), reason("write_etag_missing"));
  sdk.put = async () => { throw new sdkTypes.BlobServiceNotAvailable(); };
  await assert.rejects(store.write(empty(), '"v1"'), (e) => reason("write_sdk_failure")(e) && e.sdkClass === "BlobServiceNotAvailable");
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, "../config/remote-mcp.example.json")));
  delete config.localImportWorkspace; config.allowedHosts = ["mcp.fixture.test"];
  const env = { HYM_GROK_TOKEN: crypto.randomBytes(32).toString("hex"), HYM_DASHBOARD_TOKEN: crypto.randomBytes(32).toString("hex"), HYM_MCP_CONFIG_JSON: JSON.stringify(config), HYM_MCP_BLOB_READ_WRITE_TOKEN: "fixture" };
  const sensitive = "SENSITIVE_fixture_token https://private-fixture.invalid evidence_private";
  sdk.get = async () => { throw new sdkTypes.BlobError(sensitive); };
  const handler = createHandler({ env, storeFactory: () => store, notifyFactory: () => null });
  let body, status; const logs = [], previous = console.error;
  console.error = (...items) => logs.push(items);
  try {
    await handler({ method: "POST", headers: { host: "mcp.fixture.test", authorization: `Bearer ${env.HYM_GROK_TOKEN}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: { jsonrpc: "2.0", id: 1, method: "initialize" } }, { setHeader() {}, set statusCode(value) { status = value; }, end(value) { body = value; } });
  } finally { console.error = previous; }
  assert.equal(status, 503);
  assert.deepEqual(logs, [["MCP_STORAGE", "read_sdk_failure", "BlobError"]]);
  assert.ok(!JSON.stringify({ logs, body }).includes(sensitive));
  assert.ok(!body.includes("read_sdk_failure"), "diagnostic details must remain server-side");
  console.log("safe storage diagnostics ok: static reason codes and allowlisted SDK classes only; public 503 unchanged, no secret/message/URL/evidence logging");
}

async function boundedTransactions() {
  const sdkTypes = require("@vercel/blob");
  let attempts = 0, mode = "unknown";
  const sdk = {
    BlobError: sdkTypes.BlobError, BlobPreconditionFailedError: sdkTypes.BlobPreconditionFailedError,
    async get() { return { statusCode: 200, blob: { etag: '"v1"', size: 0 }, stream: new Response(JSON.stringify(empty())).body }; },
    async put() { attempts++; throw mode === "unknown" ? new sdkTypes.BlobUnknownError() : new sdkTypes.BlobPreconditionFailedError(); }
  };
  const store = new BlobStore({ token: "fixture", sdk });
  assert.equal(await store.transaction(() => "read-only", undefined, { skipUnchanged: true }), "read-only");
  assert.equal(attempts, 0, "unchanged read snapshot does not write business state");
  await assert.rejects(store.transaction(data => { data.checks.push({ id: "cleanup-change-fixture" }); }, undefined, { skipUnchanged: true }), Unavailable);
  assert.equal(attempts, 1, "changed reads still require acknowledged CAS and never retry unknown writes");
  attempts = 0;
  await assert.rejects(store.transaction(() => {}), Unavailable);
  assert.equal(attempts, 1, "unknown outcomes cannot retry whole business transactions");
  mode = "conflict"; attempts = 0;
  await assert.rejects(store.transaction(() => {}), Unavailable);
  assert.equal(attempts, 5, "definite CAS conflicts have a finite retry bound");
  console.log("transaction retry policy ok: unknown write 1 attempt, definite CAS conflict at most 5 attempts");
}

async function sdkContract() {
  const { MockAgent, setGlobalDispatcher, getGlobalDispatcher } = require("undici");
  const previous = getGlobalDispatcher(), mock = new MockAgent(); mock.disableNetConnect(); setGlobalDispatcher(mock);
  const store = new BlobStore({ token: "vercel_blob_rw_fixture_abcdefghijklmnopqrstuvwxyz" });
  assert.equal(process.env.VERCEL_BLOB_RETRIES, "0");
  const origin = mock.get("https://fixture.private.blob.vercel-storage.com");
  const api = mock.get("https://vercel.com");
  const putPath = `/api/blob/?${new URLSearchParams({ pathname: PATH })}`;
  try {
    origin.intercept({ path: `/${PATH}?cache=0`, method: "GET" }).reply(404);
    assert.equal((await store.read()).etag, null);
    const getPath = `/${PATH}?cache=0`;
    // Actual SDK transport must ask for identity and return the paired strong ETag.
    origin.intercept({ path: getPath, method: "GET", headers: { "accept-encoding": "identity" } }).reply(200, JSON.stringify(empty()), { headers: { etag: '"strong-origin"', "content-type": "application/json" } });
    assert.equal((await store.read()).etag, '"strong-origin"');
    // Even if a server ignores identity and serves compressed content, never
    // strip a weak ETag or submit it as a CAS validator. No Content-Length is OK.
    const compressed = require("node:zlib").gzipSync(JSON.stringify(empty()));
    origin.intercept({ path: getPath, method: "GET", headers: { "accept-encoding": "identity" } }).reply(200, compressed, { headers: { etag: 'W/"same-origin"', "content-encoding": "gzip", "content-type": "application/json" } });
    await assert.rejects(store.transaction(() => { throw new Error("weak response must stop before mutation/write"); }), (e) => e instanceof Unavailable && e.reason === "read_etag_weak");
    let headers;
    api.intercept({ path: putPath, method: "PUT" }).reply((options) => { headers = options.headers; return { statusCode: 200, data: { url: `https://fixture.private.blob.vercel-storage.com/${PATH}`, pathname: PATH, contentType: "application/json", contentDisposition: "attachment", etag: '"created"' } }; });
    await store.write(empty(), null);
    assert.equal(headers["x-allow-overwrite"], "0"); assert.equal(headers["x-if-match"], undefined);
    api.intercept({ path: putPath, method: "PUT" }).reply((options) => { headers = options.headers; return { statusCode: 412, data: { error: { code: "precondition_failed" } } }; });
    await assert.rejects(store.write(empty(), '"created"'), (e) => e.constructor.name === "Conflict");
    assert.equal(headers["x-if-match"], '"created"'); assert.equal(headers["x-allow-overwrite"], "1");
    api.intercept({ path: putPath, method: "PUT" }).reply(400, { error: { code: "bad_request", message: "This blob already exists, use `allowOverwrite: true` if you want to overwrite it. Or `addRandomSuffix: true` to generate a unique filename." } });
    await assert.rejects(store.write(empty(), null), (e) => e.constructor.name === "Conflict");
    let attempts = 0;
    api.intercept({ path: putPath, method: "PUT" }).reply(() => { attempts++; return { statusCode: 503, data: { error: { code: "service_unavailable" } } }; }).persist();
    await assert.rejects(store.write(empty(), '"created"'), Unavailable);
    assert.equal(attempts, 1, "SDK must not retry ambiguous writes internally");
    console.log("Blob SDK 2.6.1 mocked transport ok: private cache=0 and identity encoding, strong paired ETag, compressed weak ETag rejected before CAS, exclusive create, definite conflicts, ambiguous 503 exactly one attempt");
  } finally { setGlobalDispatcher(previous); await mock.close(); }
}

async function deploymentClosure() {
  const root = path.join(__dirname, "..");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hym-cloud-bundle-"));
  try {
    for (const file of ["api/mcp.js", "api/dashboard.js", "api/auth/session.js", "api/auth/login.js", "api/auth/callback.js", "api/auth/logout.js", "lib/github-store.js", "lib/github-auth.js", "lib/github-handler.js", "lib/dashboard-handler.js", "lib/remote-handler.js", "lib/remote-blob.js", "lib/remote-config.js", "lib/remote-core.js", "lib/remote-text.js", "lib/deal-engine.js", "lib/quote-ocr-parser.js", "mcp/remote-schema.js"]) {
      const target = path.join(dir, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(path.join(root, file), target);
    }
    const script = "const assert=require('assert/strict');const handler=require('./api/mcp');assert.equal(typeof handler,'function');assert.equal(typeof require('./api/dashboard'),'function');for(const action of ['session','login','callback','logout'])assert.equal(typeof require('./api/auth/'+action),'function');assert.ok(!Object.keys(require.cache).some(p=>/automation-server|remote-checks|remote-server|haoyangmao-mcp/.test(p)));let body;handler({headers:{}},{setHeader(){},end(b){body=b;}}).then(()=>assert.match(body,/configuration unavailable/));";
    const result = spawnSync(process.execPath, ["-e", script], { cwd: dir, env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const ignore = fs.readFileSync(path.join(root, ".vercelignore"), "utf8");
    assert.ok(!ignore.split(/\r?\n/).includes("mcp/"));
    assert.ok(ignore.includes("automation-server.js"));
    assert.ok(ignore.includes("lib/remote-checks.js"));
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json")));
    assert.equal(packageJson.dependencies["@vercel/blob"], "2.6.1");
    console.log("serverless bundle dependency closure ok: no Windows/local service dependency, helper modules outside API directory, SDK pinned 2.6.1");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
