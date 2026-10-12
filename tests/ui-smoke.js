"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert/strict"), crypto = require("crypto");
const { evaluate, defaults } = require("../lib/remote-core");
const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
const app = fs.readFileSync(path.join(__dirname, "../app.js"), "utf8");
const engine = fs.readFileSync(path.join(__dirname, "../lib/deal-engine.js"), "utf8");
class Element {
  constructor(tag = "div") { this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; this.dataset = {}; this.value = ""; this.hidden = false; this.disabled = false; this.listeners = {}; this._text = ""; this.className = ""; this.open = false; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(""); }
  set innerHTML(_) { throw new Error("unsafe HTML sink used"); }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...children) { this._text = ""; this.children = [...children]; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return this.attributes[key]; }
  addEventListener(key, fn) { (this.listeners[key] ||= []).push(fn); }
  async emit(key) { for (const fn of this.listeners[key] || []) await fn({ preventDefault() {}, target: this }); }
  querySelectorAll(selector) { return this.children.flatMap(child => [child, ...child.querySelectorAll(selector)]).filter(child => selector === "button" ? child.tagName === "BUTTON" : child.className.split(" ").includes(selector.slice(1))); }
  focus() { this.focused = true; }
  scrollIntoView() { this.scrolled = true; }
  showModal() { this.open = true; }
  close() { this.open = false; }
}
function harness(records = [], fetcher) {
  let clock = Date.now(), nextTimer = 0;
  const timers = new Map(), elements = new Map(), calls = [], created = [], listeners = {}, windowListeners = {};
  for (const match of html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"[^>]*>/gi)) elements.set(match[2], new Element(match[1]));
  elements.get("categoryFilter").value = "all"; elements.get("sortOrder").value = "profit";
  for (const state of ["all", "verified", "pending", "expired"]) { const button = new Element("button"); button.dataset.status = state; elements.get("statusFilters").appendChild(button); }
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [clock])); } static now() { return clock; } }
  const context = {
    console, Date: Clock, Intl, URL, AbortController, AbortSignal, DOMException,
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, delay, at: clock + delay }); return id; }, clearTimeout(id) { timers.delete(id); },
    localStorage: { getItem() { throw new Error("storage access forbidden"); }, setItem() { throw new Error("credential storage forbidden"); } },
    sessionStorage: { getItem() { throw new Error("storage access forbidden"); }, setItem() { throw new Error("credential storage forbidden"); } },
    location: { protocol: "https:", origin: "https://haoyangmao.koocuu.com" },
    document: { hidden: false, getElementById(id) { return elements.get(id) || null; }, createElement(tag) { created.push(tag); return new Element(tag); }, addEventListener(type, fn) { listeners[type] = fn; } },
    window: { matchMedia: () => ({ matches: false }), addEventListener(type, fn) { windowListeners[type] = fn; } },
    fetch: async (url, options) => {
      const message = JSON.parse(options.body); calls.push({ url, options, message });
      if (fetcher) return fetcher(message, options);
      if (message.method === "initialize") return response({ protocolVersion: "2025-11-25" });
      if (message.id === undefined) return { ok: true };
      assert.equal(message.params.name, "get_status");
      const { offset, limit } = message.params.arguments; assert.equal(limit, 50);
      return response({ structuredContent: { items: records.slice(offset, offset + limit), nextOffset: offset + limit < records.length ? offset + limit : null, total: records.length }, isError: false });
    }
  };
  vm.createContext(context); vm.runInContext(engine, context); vm.runInContext(app, context);
  return {
    context, elements, calls, timers, created, run: code => vm.runInContext(code, context), clock: () => clock,
    async connect() { elements.get("checksToken").value = crypto.randomBytes(32).toString("hex"); await vm.runInContext("connectChecks()", context); },
    async advance(ms) { clock += ms; const due = [...timers].filter(([, item]) => item.at <= clock); for (const [id, item] of due) { timers.delete(id); await item.fn(); } },
    async visibility(hidden) { context.document.hidden = hidden; await listeners.visibilitychange(); await Promise.resolve(); },
    cleanup() { vm.runInContext("disconnectChecks()", context); }
  };
}
function response(result) { return { ok: true, json: async () => ({ jsonrpc: "2.0", id: 1, result }) }; }
function fixtures(now = Date.now()) {
  const condition = { status: "verified", detail: "来源证据核实" };
  const conditions = keys => Object.fromEntries(keys.map(key => [key, { ...condition }]));
  const evidence = (source, at = now) => ({ source, reference: "fixture-reference", excerpt: "仅测试证据", observedAt: new Date(at).toISOString(), validUntil: new Date(at + 3600000).toISOString() });
  const make = (id, sku, buyPrice, price) => {
    const check = { id, workspace: "personal", updatedAt: new Date(now).toISOString(), lead: { sku, text: `${sku} 券后 ${buyPrice}`, buyPrice, evidence: evidence("PDD"), conditions: conditions(["finalPrice", "eligibility", "stock", "purchaseRules"]) }, quotes: [{ id: `${id}-quote`, sku, price, evidence: evidence("AH"), conditions: conditions(["specification", "acceptance", "deductions", "settlement"]), parseWarnings: [] }], notification: { status: "not_configured" } };
    check.result = evaluate(check, defaults, now); return check;
  };
  const a = make("151", "iPhone 16 256G 国行 黑色 全新未激活", 5599, 5800);
  const b = make("120", "Osmo Pocket 3 标准版 全新未拆", 1850, 2020);
  const c = make("61", "AirPods Pro 2 国行 全新未拆", 1399, 1510);
  const pending = make("pending", "Switch OLED 日版 白色 全新", 1499, 1660);
  pending.quotes[0].conditions.settlement = { status: "unknown", detail: "缺少结算时效依据" }; pending.result = evaluate(pending, defaults, now);
  const stale = make("stale", "iPhone 17 256G 国行 黑色 全新未激活", 5299, 5600);
  stale.lead.evidence = evidence("PDD", now - 61 * 60000); stale.result = evaluate(stale, defaults, now);
  return [a, b, c, pending, stale];
}
async function main() {
  const records = fixtures(), h = harness(records), e = h.elements;
  try {
    h.context.huaweiFixture = { lead: { sku: "华为 nova 15 Pro 12+256 国行 黑色 全新未激活" } };
    assert.equal(h.run("categoryOf(huaweiFixture)"), "phone", "existing Huawei UI classification needs no production change");
    assert.equal(h.calls.length, 0, "disconnected page must not call old/public APIs");
    assert.equal(e.get("checksUrl").value, "https://haoyangmao.koocuu.com/api/mcp");
    assert.equal(e.get("checksList").children.length, 0, "no automatic example data");
    await h.connect();
    assert.equal(e.get("checksToken").value, ""); assert.equal(h.run("pageState.phase"), "ready");
    assert.equal(e.get("checksList").children.length, 5); assert.equal(e.get("countVerified").textContent, "3"); assert.equal(e.get("countPending").textContent, "1"); assert.equal(e.get("countExpired").textContent, "1");
    const rows = e.get("checksList").children;
    assert.match(rows[0].textContent, /\+¥151/); assert.match(rows[1].textContent, /\+¥120/); assert.match(rows[2].textContent, /\+¥61.*低于门槛/);
    assert.doesNotMatch(rows[3].textContent, /¥1660|\+¥111/); assert.match(rows[3].textContent, /缺少新鲜、规格一致且条件完整的回收报价/);
    assert.doesNotMatch(rows[4].textContent, /\+¥251|¥5,600/);
    h.run('selectCheck("151")'); assert.equal(e.get("workspace").dataset.detailOpen, "true"); assert.match(e.get("detailContent").textContent, /\+¥151/);
    assert.equal(e.get("detailContent").querySelectorAll(".condition-row").length, 8);
    assert.match(e.get("detailContent").textContent, /扣费条件.*结算条件/);
    h.run('selectCheck("pending")'); assert.match(e.get("detailContent").textContent, /缺少结算时效依据/); assert.match(e.get("detailContent").textContent, /暂无服务端选定的有效回收报价/);
    await e.get("opportunitySearch").emit("input");
    e.get("opportunitySearch").value = "airpods"; await e.get("opportunitySearch").emit("input"); assert.equal(e.get("checksList").children.length, 1);
    h.run("resetFilters()"); e.get("categoryFilter").value = "phone"; await e.get("categoryFilter").emit("change"); assert.equal(e.get("checksList").children.length, 2);
    h.run("resetFilters()"); await e.get("statusFilters").children[2].emit("click"); assert.equal(e.get("checksList").children.length, 1);
    h.run("resetFilters()"); e.get("sortOrder").value = "price"; await e.get("sortOrder").emit("change"); assert.equal(e.get("checksList").children[0].dataset.checkId, "61");
    e.get("opportunitySearch").value = "missing"; await e.get("opportunitySearch").emit("input"); assert.equal(e.get("listState").hidden, false); assert.equal(e.get("stateTitle").textContent, "没有符合筛选的商品");
    await e.get("stateAction").emit("click"); assert.equal(e.get("checksList").children.length, 5);
    h.context.window.matchMedia = () => ({ matches: true }); h.run('selectCheck("151")'); assert.ok(e.get("detailBack").focused); await e.get("detailBack").emit("click"); assert.equal(e.get("workspace").dataset.detailOpen, "false");
    await h.visibility(true); assert.equal(h.timers.size, 0); const beforeHidden = h.calls.length; await h.run("refreshChecks()"); assert.equal(h.calls.length, beforeHidden);
    await h.visibility(false); await new Promise(resolve => setImmediate(resolve)); assert.ok([...h.timers.values()].some(timer => timer.delay === 30000));
    h.run("disconnectChecks()"); assert.equal(e.get("checksList").children.length, 0); assert.equal(h.run("pageState.connection"), null); assert.equal(h.timers.size, 0); assert.match(e.get("checksStatus").textContent, /未连接/);
  } finally { h.cleanup(); }

  // A still-valid purchase with old/unusable quotes is pending, not valid profit.
  const old = fixtures()[0]; old.id = "old-quote"; old.quotes[0].evidence.observedAt = new Date(Date.now() - 31 * 60000).toISOString(); old.result = evaluate(old, defaults);
  assert.equal(old.result.quoteId, null);
  const oldPage = harness([old]); await oldPage.connect(); assert.match(oldPage.elements.get("checksList").textContent, /待确认/); assert.doesNotMatch(oldPage.elements.get("checksList").textContent, /¥5,800|\+¥151/); oldPage.cleanup();

  // A pending server result cannot be upgraded just because it carries a profit.
  const unknown = fixtures()[3]; unknown.result.netProfit = 111;
  const unknownPage = harness([unknown]); await unknownPage.connect(); assert.doesNotMatch(unknownPage.elements.get("checksList").textContent, /\+¥111/); unknownPage.cleanup();

  // Expiry downgrades immediately without waiting for the next server poll.
  const expiring = fixtures()[0]; expiring.result.validUntil = new Date(Date.now() + 2000).toISOString();
  const expiry = harness([expiring]); await expiry.connect(); expiry.run('selectCheck("151")'); const beforeExpiry = expiry.calls.length; await expiry.advance(2100);
  assert.equal(expiry.calls.length, beforeExpiry); assert.match(expiry.elements.get("checksList").textContent, /已过期/); assert.doesNotMatch(expiry.elements.get("checksList").textContent, /\+¥151/); assert.doesNotMatch(expiry.elements.get("detailContent").textContent, /\+¥151/); expiry.cleanup();

  // All pages are read, including the backend's current 200-record bound.
  const many = Array.from({ length: 200 }, (_, index) => ({ ...fixtures()[0], id: `p-${index}` }));
  const paged = harness(many); await paged.connect(); assert.equal(paged.elements.get("checksList").children.length, 200); assert.equal(paged.calls.filter(call => call.message.method === "tools/call").length, 4); paged.cleanup();
  const incomplete = harness([], message => message.method === "initialize" ? response({ protocolVersion: "2025-11-25" }) : message.id === undefined ? { ok: true } : response({ structuredContent: { items: [], nextOffset: null, total: 51 }, isError: false }));
  await incomplete.connect(); assert.equal(incomplete.run("pageState.phase"), "error"); assert.equal(incomplete.elements.get("checksList").children.length, 0); incomplete.cleanup();

  // Evidence, references and product text are never HTML or clickable arbitrary URLs.
  const attack = fixtures()[0], payload = '<img src=x onerror="globalThis.pwned=1">'; attack.lead.sku += payload; attack.lead.evidence.reference = "javascript:alert(1)"; attack.lead.evidence.excerpt = payload;
  const xss = harness([attack]); await xss.connect(); xss.run('selectCheck("151")'); assert.ok(xss.elements.get("detailContent").textContent.includes(payload)); assert.ok(xss.elements.get("detailContent").textContent.includes("javascript:alert(1)")); assert.ok(!xss.created.some(tag => ["img", "script", "a"].includes(tag))); assert.equal(xss.context.pwned, undefined); xss.cleanup();

  // Empty/error/loading states are real; auth responses and provider text are not echoed.
  const empty = harness([]); await empty.connect(); assert.equal(empty.elements.get("stateTitle").textContent, "暂时没有商品机会"); empty.cleanup();
  const failed = harness([], () => ({ ok: false, json: async () => ({ secret: "never echo" }) })); await failed.connect(); assert.equal(failed.run("pageState.phase"), "error"); assert.doesNotMatch(failed.elements.get("listState").textContent, /never echo/); failed.cleanup();
  let resolveOld;
  const delayed = harness([], () => new Promise(resolve => { resolveOld = resolve; }));
  delayed.elements.get("checksToken").value = crypto.randomBytes(32).toString("hex"); const pendingRequest = delayed.run("connectChecks()");
  assert.equal(delayed.elements.get("checksToken").value, ""); assert.equal(delayed.run("pageState.phase"), "loading"); delayed.run("disconnectChecks()");
  resolveOld(response({ protocolVersion: "2025-11-25" })); await pendingRequest; assert.equal(delayed.run("pageState.connection"), null); assert.equal(delayed.elements.get("checksList").children.length, 0); assert.equal(delayed.calls.length, 1); delayed.cleanup();
  let resolvePrevious, initializations = 0;
  const replacement = fixtures()[1];
  const swapped = harness([], message => {
    if (message.method === "initialize") {
      if (++initializations === 1) return new Promise(resolve => { resolvePrevious = resolve; });
      return response({ protocolVersion: "2025-11-25" });
    }
    if (message.id === undefined) return { ok: true };
    return response({ structuredContent: { items: [replacement], total: 1, nextOffset: null }, isError: false });
  });
  swapped.elements.get("checksToken").value = crypto.randomBytes(32).toString("hex");
  const previousConnection = swapped.run("connectChecks()");
  await swapped.connect();
  resolvePrevious(response({ protocolVersion: "2025-11-25" })); await previousConnection;
  assert.equal(swapped.run("pageState.phase"), "ready"); assert.equal(swapped.elements.get("checksList").children[0].dataset.checkId, "120"); swapped.cleanup();
  const reentry = harness([]); await reentry.connect(); let resolveRefresh, refreshRequests = 0;
  reentry.context.fetch = async () => { refreshRequests++; return new Promise(resolve => { resolveRefresh = resolve; }); };
  const firstRefresh = reentry.run("refreshChecks()"); const controller = reentry.run("pageState.connection.controller"); await reentry.run("refreshChecks()"); assert.equal(controller, reentry.run("pageState.connection.controller"));
  assert.equal(refreshRequests, 1, "manual refresh cannot reenter a pending request");
  resolveRefresh(response({ structuredContent: { items: [], total: 0, nextOffset: null }, isError: false })); await firstRefresh; reentry.cleanup();

  const invalid = harness([]); invalid.elements.get("checksUrl").value = "https://user:pass@example.com/api/mcp"; invalid.elements.get("checksToken").value = crypto.randomBytes(32).toString("hex"); await invalid.run("connectChecks()"); assert.equal(invalid.calls.length, 0); assert.equal(invalid.elements.get("checksToken").value, ""); invalid.cleanup();
  assert.ok(!/localStorage|sessionStorage|innerHTML|api\/automation|api\/kdocs|submit_lead|submit_quote/.test(app), "front end must remain read only and have no legacy requests/storage/HTML sinks");
  console.log("opportunity UI smoke ok: real core fixtures/151/61/pending/stale/8 conditions/filter/sort/mobile detail/200 pagination/expiry/XSS/empty/error/loading/hidden/disconnect/reentry/token memory");
}
module.exports = main;
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
