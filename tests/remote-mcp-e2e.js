"use strict";
const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { once } = require("events");
const { CheckService, evaluate } = require("../lib/remote-checks");
const { createRemoteServer, loadConfig, telegramNotifier } = require("../mcp/remote-server");
const { createServer } = require("../automation-server");
const { tools } = require("../mcp/remote-schema");

async function main() {
  await require("./remote-tools-regressions")();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hym-mcp-test-"));
  const file = path.join(dir, "checks.json");
  const token = crypto.randomBytes(32).toString("hex");
  const reader = crypto.randomBytes(32).toString("hex");
  const outsider = crypto.randomBytes(32).toString("hex");
  const rawConfig = JSON.parse(fs.readFileSync(path.join(__dirname, "../config/remote-mcp.example.json")));
  delete rawConfig.localImportWorkspace;
  rawConfig.workspaces.other = structuredClone(rawConfig.workspaces.personal);
  rawConfig.clients.push({ id: "other", workspace: "other", tokenEnv: "OTHER", tools: tools.map((tool) => tool.name) });
  const configFile = path.join(dir, "config.json"); fs.writeFileSync(configFile, JSON.stringify(rawConfig));
  const config = loadConfig(configFile, { HYM_GROK_TOKEN: token, HYM_DASHBOARD_TOKEN: reader, OTHER: outsider });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(__dirname, "../docs/remote-tools.schema.json"), "utf8")).tools, tools);
  assert.throws(() => loadConfig(configFile, {}), /credential/);
  let now = Date.now(), sent = [];
  let service = new CheckService({ config, file, now: () => now, notify: async (notice) => { sent.push(notice); } });
  assert.throws(() => new CheckService({ config, file }), /EEXIST/);
  let server = createRemoteServer({ config, service });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let url = `http://127.0.0.1:${server.address().port}/mcp`;
  const dashboard = createServer();
  await new Promise((resolve) => dashboard.listen(0, "127.0.0.1", resolve));
  const pageUrl = `http://127.0.0.1:${dashboard.address().port}`;
  config.allowedOrigins.push(pageUrl);
  const headers = (key = token) => ({ Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25" });
  let rpcId = 0;
  async function rpc(method, params, key = token, extra = {}) {
    const response = await fetch(url, { method: "POST", headers: { ...headers(key), ...extra }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) });
    return { status: response.status, body: await response.json() };
  }
  async function call(name, args = {}, key = token) {
    const response = await rpc("tools/call", { name, arguments: args }, key);
    assert.equal(response.status, 200);
    return response.body.result;
  }
  const verified = { status: "verified", detail: "模拟 Grok 已逐项检查页面证据；无额外条件" };
  const conditions = (keys) => Object.fromEntries(keys.map((key) => [key, { ...verified }]));
  const sku = "iPhone 16 256G 国行 黑色 全新未激活";
  function evidence(source, reference) { return { source, reference, excerpt: "模拟页面原文：对应规格、金额和条件已确认", observedAt: new Date(now).toISOString(), validUntil: new Date(now + 3600000).toISOString() }; }
  function lead(key, overrides = {}) {
    return { idempotencyKey: key, opportunityKey: key, sku, text: `PDD ${sku} 券后 5599`, buyPrice: 5599, evidence: evidence("PDD", `fixture:${key}`), conditions: conditions(["finalPrice", "eligibility", "stock", "purchaseRules"]), ...overrides };
  }
  function quote(checkId, key, overrides = {}) {
    return { idempotencyKey: key, checkId, sku, price: 5800, evidence: evidence("小鸽", `fixture:${key}`), conditions: conditions(["specification", "acceptance", "deductions", "settlement"]), ...overrides };
  }
  const value = (result) => { assert.equal(result.isError, false, JSON.stringify(result)); return result.structuredContent; };
  try {
    assert.equal((await rpc("initialize", { protocolVersion: "2025-11-25" })).body.result.protocolVersion, "2025-11-25");
    assert.equal((await rpc("tools/list", {})).body.result.tools.length, 7);
    assert.equal((await rpc("tools/list", {}, reader)).body.result.tools.length, 1);
    assert.equal((await rpc("tools/list", {}, "wrong")).status, 401);
    assert.equal((await rpc("tools/list", {}, token, { Origin: "https://evil.example" })).status, 403);
    const preflight = await fetch(url, { method: "OPTIONS", headers: { Origin: "https://haoyangmao.koocuu.com", "Access-Control-Request-Method": "POST" } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "https://haoyangmao.koocuu.com");
    const badHostStatus = await new Promise((resolve, reject) => {
      const request = require("http").request(url, { method: "POST", headers: { ...headers(), Host: "evil.example" } }, (response) => { response.resume(); resolve(response.statusCode); });
      request.on("error", reject); request.end("{}");
    });
    assert.equal(badHostStatus, 403);
    assert.equal((await rpc("tools/list", {}, token, { "MCP-Protocol-Version": "invalid" })).status, 400);
    assert.equal((await fetch(url, { headers: headers() })).status, 405);
    assert.equal((await fetch(url.replace("/mcp", "/api/automation/capture-screen"), { headers: headers() })).status, 404);
    assert.equal((await call("capture_screen")).isError, true);
    assert.equal((await call("submit_lead", lead("reader"), reader)).isError, true);
    assert.equal((await call("submit_lead", { ...lead("extra"), tenantId: "other" })).isError, true);
    assert.equal((await call("submit_lead", lead("future", { evidence: { ...evidence("PDD", "f"), observedAt: new Date(now + 1000).toISOString() } }))).isError, true);
    assert.equal((await call("submit_lead", lead("source", { evidence: evidence("unknown", "s") }))).isError, true);
    assert.equal((await fetch(url, { method: "POST", headers: headers(), body: " ".repeat(33000) })).status, 413);
    const notificationResponse = await fetch(url, { method: "POST", headers: headers(), body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
    assert.equal(notificationResponse.status, 202);

    const pending = lead("main"); pending.conditions.eligibility.status = "unknown";
    let record = value(await call("submit_lead", pending)); const id = record.id;
    assert.equal(record.result.status, "pending_confirmation");
    assert.equal(value(await call("get_pending_checks")).total, 1);
    assert.equal(value(await call("get_status", {}, outsider)).total, 0);
    assert.equal((await call("get_status", { checkId: id }, outsider)).isError, true);
    assert.equal((await call("submit_quote", quote(id, "cross"), outsider)).isError, true);
    record = value(await call("submit_quote", quote(id, "quote-1", { text: `${sku} 回收 5800` })));
    assert.equal(record.result.netProfit, null);
    assert.equal(record.result.status, "pending_confirmation"); assert.equal(sent.length, 0);
    const completed = { ...pending, idempotencyKey: "main-verified", conditions: conditions(["finalPrice", "eligibility", "stock", "purchaseRules"]) };
    const parallel = await Promise.all(Array.from({ length: 8 }, () => call("submit_lead", completed)));
    parallel.forEach(value);
    assert.equal(parallel.filter((result) => !result.structuredContent.replayed).length, 1);
    record = value(parallel[0]);
    assert.equal(record.result.status, "eligible"); assert.equal(record.notification.status, "sent"); assert.equal(sent.length, 1);
    assert.equal((await call("submit_lead", { ...completed, buyPrice: 1 })).isError, true);
    assert.equal(value(await call("submit_lead", { ...completed, idempotencyKey: "different", opportunityKey: "different" })).id, id);
    assert.equal(sent.length, 1);
    const pageData = value(await call("get_status", {}, reader));
    assert.equal(pageData.items.find((item) => item.id === id).result.netProfit, 151);
    assert.match(await (await fetch(pageUrl)).text(), /id="checksList"/); // Opportunity mount survives login/heading copy changes.
    assert.equal((await fetch(`${pageUrl}/data/private/remote-checks.json`)).status, 403);
    assert.equal((await fetch(`${pageUrl}/config/remote-mcp.local.json`)).status, 403);
    assert.equal((await fetch(`${pageUrl}/.git/config`)).status, 403);
    assert.equal((await fetch(`${pageUrl}/api/automation/checks`, { headers: { Origin: "https://evil.example" } })).status, 403);

    const mismatch = value(await call("submit_lead", lead("mismatch")));
    assert.equal(value(await call("submit_quote", quote(mismatch.id, "wrong-sku", { sku: sku.replace("256G", "512G") }))).result.status, "pending_confirmation");
    const stale = value(await call("submit_lead", lead("stale")));
    assert.equal(value(await call("submit_quote", quote(stale.id, "stale-quote", { evidence: { ...evidence("小鸽", "old"), observedAt: new Date(now - 31 * 60000).toISOString() } }))).result.status, "pending_confirmation");
    const below = value(await call("submit_lead", lead("below")));
    assert.equal(value(await call("submit_quote", quote(below.id, "below-quote", { price: 5650 }))).result.status, "below_threshold");
    const incomplete = value(await call("submit_lead", lead("incomplete", { sku: "iPhone 16 256G 全新" })));
    assert.equal(value(await call("submit_quote", quote(incomplete.id, "incomplete-quote", { sku: "iPhone 16 256G 全新" }))).result.status, "pending_confirmation");
    const conflict = value(await call("submit_lead", lead("price-conflict", { buyPrice: 5000 })));
    assert.equal(value(await call("submit_quote", quote(conflict.id, "conflict-quote"))).result.status, "pending_confirmation");
    const failed = value(await call("submit_lead", lead("failed")));
    const failedQuote = quote(failed.id, "failed-quote"); failedQuote.conditions.deductions.status = "unknown";
    assert.equal(value(await call("submit_quote", failedQuote)).result.status, "pending_confirmation");
    // A newer failed verification supersedes the older successful quote from that source.
    const revoked = quote(id, "revoked"); revoked.conditions.acceptance.status = "failed";
    assert.equal(value(await call("submit_quote", revoked)).result.status, "pending_confirmation");
    assert.equal(sent.length, 1);
    // Restore a valid observation for the preview without allowing a second notification.
    value(await call("submit_quote", quote(id, "restored")));

    if (process.argv.includes("--preview")) {
      const fixtureFile = path.join(dir, "browser-fixture.json");
      fs.writeFileSync(fixtureFile, JSON.stringify({ token: reader, mcpUrl: url, pageUrl }), { mode: 0o600 });
      console.log(`Preview fixture: ${pageUrl}; private fixture config: ${fixtureFile} (press Enter to finish tests and stop)`);
      await new Promise((resolve) => process.stdin.once("data", resolve));
      process.stdin.pause();
    }

    // Re-evaluation after time passes must never return old eligibility.
    now += 31 * 60000;
    assert.equal(value(await call("get_status", { checkId: id })).result.status, "pending_confirmation");
    // Persistence/restart and new idempotency key still cannot send twice.
    server.close(); await once(server, "close"); service.close();
    service = new CheckService({ config, file, now: () => now, notify: async (notice) => sent.push(notice) });
    server = createRemoteServer({ config, service });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${server.address().port}/mcp`;
    value(await call("submit_quote", quote(id, "after-restart")));
    assert.equal(value(await call("get_status", { checkId: id })).notification.status, "sent");
    assert.equal(sent.length, 1);

    // Ambiguous delivery remains at-most-once, including timer maintenance.
    service.notify = async () => { throw new Error("simulated timeout"); };
    const unknown = value(await call("submit_lead", lead("unknown")));
    assert.equal(value(await call("submit_quote", quote(unknown.id, "unknown-q"))).notification.status, "delivery_unknown");
    let retries = 0;
    service.notify = async () => { retries++; throw new Error("must not retry"); };
    await server.runMaintenance();
    assert.equal(retries, 0);
    assert.equal(value(await call("get_status", { checkId: unknown.id })).notification.status, "delivery_unknown");
    // Fixed notification endpoint; no real external message is sent by this test.
    let outbound;
    const fakeBotToken = `123:${crypto.randomBytes(16).toString("hex")}`;
    const notifier = telegramNotifier(config, { HYM_TELEGRAM_BOT_TOKEN: fakeBotToken, HYM_TELEGRAM_CHAT_ID: "123" }, async (url, options) => { outbound = { url, options }; return new Response('{"ok":true}', { status: 200 }); });
    await notifier(sent[0]);
    assert.equal(new URL(outbound.url).hostname, "api.telegram.org");
    assert.equal(outbound.options.redirect, "error");
    assert.equal(JSON.parse(outbound.options.body).chat_id, "123");
    assert.equal(fs.readFileSync(file, "utf8").includes(token), false);
    assert.equal(evaluate(record, { minimumProfit: 152, shippingCost: 20, platformCost: 0, riskBuffer: 30, quoteMaxAgeMinutes: 30, leadMaxAgeMinutes: 60 }, Date.parse(record.updatedAt)).status, "below_threshold");
    now += 31 * 86400000; await server.runMaintenance();
    assert.equal(service.data.checks.length, 0); assert.equal(service.data.receipts.length, 0); assert.equal(service.data.notices.length, 0);
    console.log("remote MCP e2e ok: protocol/auth/scope/idempotency/concurrency/restart/expiry/profit/evidence/dashboard/notification/retention; mock delivery count=1, net profit=151");
  } finally {
    server.close(); server.closeAllConnections();
    dashboard.close(); dashboard.closeAllConnections();
    service.close();
    // Only the uniquely created OS temporary fixture directory is removed.
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
