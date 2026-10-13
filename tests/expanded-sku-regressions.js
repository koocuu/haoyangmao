"use strict";
const assert = require("assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const engine = require("../lib/deal-engine");
const { parseLeadLine, parseQuoteLine } = require("../lib/remote-text");
const { CheckService } = require("../lib/remote-checks");
const { loadCloudConfig } = require("../lib/remote-config");
const { createHandler } = require("../lib/remote-handler");
const { CloudChecks, empty } = require("../lib/remote-blob");

module.exports = async function run() {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, "../config/remote-mcp.example.json"), "utf8"));
  delete config.localImportWorkspace;
  const newFamilies = ["oppo", "oneplus", "vivo", "samsung", "mac", "honor", "realme"];
  config.workspaces.personal.families = [...new Set([...config.workspaces.personal.families, ...newFamilies])];
  config.allowedHosts = ["sku.fixture.test"];
  const token = crypto.randomBytes(32).toString("hex");
  const env = { HYM_GROK_TOKEN: token, HYM_DASHBOARD_TOKEN: crypto.randomBytes(32).toString("hex"), HYM_MCP_CONFIG_JSON: JSON.stringify(config), HYM_MCP_BLOB_READ_WRITE_TOKEN: "isolated-sku-fixture" };
  const scoped = loadCloudConfig(env), principal = scoped.clients[0];
  const now = Date.now();
  let seq = 0;
  const evidence = source => ({ source, reference: `fixture-only:${++seq}`, excerpt: "纯模拟规格，不代表真实核验", observedAt: new Date(now).toISOString(), validUntil: new Date(now + 3600000).toISOString() });
  const conditions = keys => Object.fromEntries(keys.map(key => [key, { status: "verified", detail: "隔离模拟" }]));
  const lead = sku => ({ idempotencyKey: `sku-l-${++seq}`, opportunityKey: `sku-o-${seq}`, sku, text: `${sku} 实付2000`, buyPrice: 2000, evidence: evidence("PDD"), conditions: conditions(["finalPrice", "eligibility", "stock", "purchaseRules"]) });
  const quote = sku => ({ idempotencyKey: `sku-q-${++seq}`, sku, text: `${sku} 回收2400`, price: 2400, evidence: evidence("小鸽"), conditions: conditions(["specification", "acceptance", "deductions", "settlement"]) });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hym-sku-expanded-")), file = path.join(dir, "checks.json");
  const service = new CheckService({ config: scoped, file, now: () => now });
  let state = empty(), transactions = 0, constructed = 0, reads = 0;
  const store = { read: async () => { reads++; return { data: structuredClone(state) }; }, transaction: async fn => {
    transactions++;
    const next = structuredClone(state);
    const result = await fn(next);
    state = next;
    return result;
  } };
  const handler = createHandler({ env, now: () => now, storeFactory: () => { constructed++; return store; }, notifyFactory: () => null });
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  async function rpc(name, args, expectedError = false) {
    const response = await new Promise((resolve, reject) => {
      const request = http.request(`http://127.0.0.1:${server.address().port}/api/mcp`, { method: "POST", headers: { Host: "sku.fixture.test", Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" } }, async res => {
        try {
          const chunks = []; for await (const chunk of res) chunks.push(chunk);
          resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
        } catch (error) { reject(error); }
      });
      request.on("error", reject);
      request.end(JSON.stringify({ jsonrpc: "2.0", id: ++seq, method: "tools/call", params: { name, arguments: args } }));
    });
    assert.equal(response.status, 200);
    const body = response.body.result;
    assert.equal(body.isError, expectedError, JSON.stringify(body));
    return expectedError ? body.content[0].text : body.structuredContent;
  }
  const cases = [
    ["oppo", "OPPO Find X8 12+256GB 黑色 国行 全新未激活"],
    ["oppo", "OPPO Reno14 12+256GB 白色 国行 全新未激活"],
    ["oneplus", "一加 Ace 5 12+256GB 黑色 国行 全新未激活"],
    ["vivo", "vivo X200 12+256GB 黑色 国行 全新未激活"],
    ["vivo", "iQOO 13 12+256GB 黑色 国行 全新未激活"],
    ["samsung", "三星 Galaxy S25 12+256GB 银色 国行 全新未激活"],
    ["samsung", "Samsung Galaxy Z Fold6 12+256GB 黑色 国行 全新未激活"],
    ["samsung", "三星 Galaxy Z Flip6 12+256GB 蓝色 国行 全新未激活"],
    ["samsung", "三星 Galaxy A56 8+256GB 黑色 国行 全新未激活"],
    ["honor", "荣耀 Magic7 12+256GB 黑色 国行 全新未激活"],
    ["realme", "真我 GT7 12+256GB 黑色 国行 全新未激活"],
    ["xiaomi", "小米 平板7 8+256GB 黑色 国行 全新未激活"],
    ["xiaomi", "Xiaomi Pad 7 8+256GB 黑色 国行 全新未激活"],
    ["ipad", "Apple iPad 9 8+256GB 银色 国行 全新未激活"],
    ["ipad", "iPad 10 8+256GB 银色 国行 全新未激活"],
    ["ipad", "iPad Air 5 8+256GB 银色 国行 全新未激活"],
    ["ipad", "iPad Pro 11 8+256GB 银色 国行 全新未激活"],
    ["ipad", "Apple iPad Pro M4 11英寸 8+256GB 银色 国行 全新未激活"],
    ["mac", "Apple Mac mini M4 统一内存16GB SSD256GB 银色 国行 全新未激活"],
    ["mac", "Apple MacBook Air M4 13英寸 统一内存16GB SSD256GB 银色 国行 全新未激活"],
    ["mac", "Apple MacBook Pro M4 Pro 14英寸 统一内存24GB SSD1TB 黑色 国行 全新未激活"]
  ];
  const preview = async (sku, qSku = sku) => {
    const args = { ...lead(sku), quotes: [quote(qSku)] };
    const snapshot = JSON.stringify(service.data);
    const result = await service.call(principal, "preview_check", args);
    assert.equal(JSON.stringify(service.data), snapshot);
    return result;
  };
  try {
    for (const [family, sku] of cases) {
      const facts = engine.extractSkuFactsV2(sku);
      assert.equal(facts.family, family, sku);
      assert.equal(facts.storage, sku.includes("SSD1TB") ? "1tb" : "256gb", sku);
      assert.ok(facts.model, sku);
      assert.ok(Number.isFinite(engine.scoreQuoteV2(facts, { skuName: sku, normalizedSku: sku })), sku);
      assert.ok(parseLeadLine(`${sku} 实付2000`), sku);
      assert.equal(parseQuoteLine(`${sku} 回收2400`).skuName, sku);
      const args = { ...lead(sku), quotes: [quote(sku)] };
      // The HTTP preview path must not even construct a Blob adapter.
      const before = { constructed, transactions, reads, state: JSON.stringify(state), local: JSON.stringify(service.data) };
      const p = await rpc("preview_check", args);
      assert.deepEqual({ constructed, transactions, reads, state: JSON.stringify(state), local: JSON.stringify(service.data) }, before);
      assert.equal(p.result.status, "eligible", `${sku}: ${JSON.stringify(p.diagnostics)}`);
      assert.equal(p.result.netProfit, 350);
      assert.deepEqual(p.diagnostics.missingSpecs, []);
      assert.deepEqual(p.diagnostics.quotes[0].differences, []);
      assert.equal(p.items[0].success, true);
      const saved = await rpc("submit_lead", (({ quotes, ...l }) => l)(args));
      assert.equal(saved.result.netProfit, null);
      const submitted = await rpc("submit_quote", { ...args.quotes[0], checkId: saved.id });
      assert.equal(submitted.result.status, "eligible", `${sku}: ${JSON.stringify(submitted)}`);
      assert.deepEqual({ ...submitted.result, quoteId: null }, { ...p.result, quoteId: null });
      assert.equal(submitted.notification.status, "not_configured");
      assert.deepEqual(submitted.quotes[0].parseWarnings, []);
    }
    assert.equal(state.notices.length, 0, "no real notifier configured");
    assert.equal(fs.existsSync(file), false, "local previews never saved");
    const noStore = new CloudChecks({ config: scoped, now: () => now, store: { transaction: () => { throw new Error("preview touched Blob"); } }, notify: () => { throw new Error("preview notified"); } });
    assert.equal((await noStore.call(principal, "preview_check", { ...lead(cases[0][1]), quotes: [quote(cases[0][1])] })).result.netProfit, 350);

    // Family authorization is independent of recognizing a supported model.
    const deniedConfig = structuredClone(scoped);
    deniedConfig.workspaces.personal.families = deniedConfig.workspaces.personal.families.filter(f => !newFamilies.includes(f));
    const denied = new CloudChecks({ config: deniedConfig, store: { transaction: () => { throw new Error("scope touched storage"); } }, now: () => now });
    for (const [family, sku] of cases.filter(([f]) => newFamilies.includes(f))) {
      await assert.rejects(denied.call(principal, "preview_check", { ...lead(sku), quotes: [quote(sku)] }), /Product family not authorized/, family);
    }
    for (const sku of ["UnknownBrand Phone 12+256GB 黑色 国行 全新未激活", "品牌 unknown iPhone 17 256GB 黑色 国行 全新未激活"]) {
      assert.equal(await rpc("submit_lead", lead(sku), true), "Product family not authorized");
    }
    // Authorized new/unknown series are accepted, but never certified by an
    // arbitrary number, unknown suffix, or identical malformed quote.
    for (const sku of [
      "OPPO Find X999 12+256GB 黑色 国行 全新未激活", "OPPO Reno999 12+256GB 黑色 国行 全新未激活",
      "一加 Ace999 12+256GB 黑色 国行 全新未激活", "iQOO 999 12+256GB 黑色 国行 全新未激活",
      "三星 Galaxy S999 12+256GB 黑色 国行 全新未激活", "三星 Galaxy Z Fold999 12+256GB 黑色 国行 全新未激活", "三星 Galaxy A999 12+256GB 黑色 国行 全新未激活",
      "荣耀 Magic999 12+256GB 黑色 国行 全新未激活", "realme GT999 12+256GB 黑色 国行 全新未激活",
      "小米 平板999 8+256GB 黑色 国行 全新未激活", "iPad 999 8+256GB 银色 国行 全新未激活",
      cases[0][1].replace("Find X8", "Find X8 Ultra"), cases[0][1] + " 未知版", cases[0][1] + " Limited",
      cases[18][1].replace("Mac mini", "Mac mini Ultra"), cases[18][1].replace("M4", "M999")
    ]) {
      const p = await preview(sku);
      assert.equal(p.result.status, "pending_confirmation", sku); assert.equal(p.result.netProfit, null, sku);
      const saved = await service.call(principal, "submit_lead", lead(sku));
      assert.equal(saved.result.status, "pending_confirmation", sku);
      assert.equal(saved.result.netProfit, null);
    }
    for (const [, complete] of cases) {
      for (const [sku, field] of [
        [complete.replace(/(?:\d+\+)?(?:256GB|1TB)/, "容量 unknown"), "storage"],
        [complete.replace(/黑色|白色|银色|蓝色/, "颜色 unknown"), "singleColor"],
        [complete.replace("国行", "地区 unknown"), "region"],
        [complete.replace("未激活", "激活 unknown 未激活"), "activation"],
        [complete.replace("全新", "成色 unknown 全新"), "condition"]
      ]) {
        const p = await preview(sku);
        assert.equal(p.result.netProfit, null, sku); assert.equal(p.result.status, "pending_confirmation", sku);
        assert.ok(p.diagnostics.missingSpecs.includes(field), `${sku}: ${p.diagnostics.missingSpecs}`);
      }
      if (engine.extractSkuFactsV2(complete).family !== "mac") {
        const p = await preview(complete.replace(/\d+\+/, "RAM unknown "));
        assert.ok(p.diagnostics.missingSpecs.includes("ram"), complete);
      }
    }
    const mac = cases[18][1], book = cases[20][1];
    for (const [sku, field] of [
      [mac.replace("M4", "芯片 unknown M4"), "chip"], [mac.replace("M4", ""), "chip"],
      [mac.replace("统一内存16GB", "统一内存 unknown 统一内存16GB"), "unifiedMemory"],
      [mac.replace("统一内存16GB", ""), "unifiedMemory"],
      [mac.replace("SSD256GB", ""), "storage"],
      [mac.replace("SSD256GB", "SSD256GB SSD512GB"), "storage"],
      [book.replace("14英寸", ""), "screenSize"], [book.replace("14英寸", "14英寸 16英寸"), "screenSize"],
      [mac.replace("M4", "M4 Max"), "chip"], [book.replace("M4 Pro", "M4 Pro M4 Max"), "chip"]
    ]) {
      const p = await preview(sku);
      assert.equal(p.result.netProfit, null, sku); assert.ok(p.diagnostics.missingSpecs.includes(field), sku);
    }
    for (const memory of ["64", "128"]) {
      const sku = book.replace("统一内存24GB", `统一内存${memory}GB`).replace("SSD1TB", "SSD2TB");
      const facts = engine.extractSkuFactsV2(sku);
      assert.equal(facts.unifiedMemory, memory); assert.equal(facts.storage, "2tb");
      assert.equal((await preview(sku)).result.netProfit, 350);
      assert.equal(engine.extractSkuFactsV2(sku.replace("SSD2TB", "")).storage, "");
    }
    assert.equal(engine.extractSkuFactsV2(book).storage, "1tb");
    for (const [sku, field] of [
      [book.replace("M4 Pro", "M4 Max"), "chip"], [book.replace("统一内存24GB", "统一内存64GB"), "unifiedMemory"],
      [book.replace("SSD1TB", "SSD2TB"), "storage"], [book.replace("14英寸", "16英寸"), "screenSize"],
      [book.replace("MacBook Pro", "MacBook Air").replace("M4 Pro", "M4"), "model"]
    ]) {
      const p = await preview(book, sku);
      assert.equal(p.result.netProfit, null); assert.ok(p.diagnostics.quotes[0].differences.includes(field), field);
      assert.equal(Number.isFinite(engine.scoreQuoteV2(engine.extractSkuFactsV2(book), { skuName: sku })), false);
    }
    for (const sku of [cases[0][1].replace("12+", "16+"), cases[0][1].replace("256GB", "512GB"), cases[0][1].replace("黑色", "白色"), cases[0][1].replace("未激活", "已激活")]) {
      assert.equal((await preview(cases[0][1], sku)).result.netProfit, null);
    }
    for (const sku of ["iPhone 17 256GB 黑色 国行 全新未激活 OPPO Find X8", "Apple Mac mini M4 统一内存16GB SSD256GB 银色 国行 全新未激活 三星"]) {
      const p = await preview(sku);
      assert.ok(p.diagnostics.missingSpecs.includes("brandConflict")); assert.equal(p.result.netProfit, null);
    }
    // The old identity vocabulary has not changed during family expansion.
    assert.equal(engine.normalizeForMatchV2("iPhone 17 Pro Max 256GB 银色 国行 全新未激活"), "iphone17promax256gb银色国行全新未激活");
    assert.equal(engine.normalizeSkuForMatchV2("iPhone 17 PM 256GB silver 国行 全新未激活"), "iphone17promax256gb银色国行全新未激活");
    assert.equal((await preview("iPhone 17 256GB 黑色 国行 全新未激活")).result.netProfit, 350, "iPhone still requires no fabricated RAM");
    assert.equal((await preview("iPad 10 256GB 银色 国行 全新未激活")).result.netProfit, null, "iPad RAM is now explicit");
    assert.equal(service.data.notices.length, 0);
    console.log("expanded SKU regressions ok: 21 family/subseries HTTP preview-submit parity; no preview storage/notification; unknown/conflicting specs; strict Mac chip/memory/SSD/screen; legacy identity/iPad models");
  } finally {
    await new Promise(resolve => server.close(resolve));
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
};
if (require.main === module) module.exports().catch(error => { console.error(error); process.exitCode = 1; });
