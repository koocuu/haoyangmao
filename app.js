"use strict";
const ui = Object.fromEntries(["settingsOpen", "settingsClose", "settingsDialog", "connectionForm", "checksUrl", "checksToken", "checksConnect", "checksDisconnect", "settingsMessage", "checksStatus", "refreshBtn", "countAll", "countVerified", "countPending", "countExpired", "workspace", "opportunitySearch", "categoryFilter", "statusFilters", "sortOrder", "checksList", "listState", "stateTitle", "stateDescription", "stateAction", "listCount", "detailPanel", "detailContent", "detailClose", "detailBack"].map(id => [id, document.getElementById(id)]));
const conditionLabels = { finalPrice: "最终实付", eligibility: "购买资格", stock: "库存与地区", purchaseRules: "购买限制", specification: "回收规格", acceptance: "收货条件", deductions: "扣费条件", settlement: "结算条件" };
const categoryLabels = { phone: "手机", tablet: "平板", console: "主机", earbuds: "耳机", camera: "影像", other: "其他" };
const pageState = { connection: null, items: [], phase: "disconnected", selectedId: null, detailOpen: false, search: "", category: "all", status: "all", sort: "profit", syncedAt: null, error: "", pollTimer: null, expiryTimer: null };
const moneyFormat = new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

function node(tag, className = "", text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = String(text);
  return element;
}
function formatMoney(value) { return typeof value === "number" && Number.isFinite(value) ? `¥${moneyFormat.format(value)}` : "—"; }
function formatSignedMoney(value) { return `${value >= 0 ? "+" : "−"}${formatMoney(Math.abs(value))}`; }
function formatTime(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "未提供";
}
function relativeTime(value) {
  const time = Date.parse(value), minutes = Math.floor((Date.now() - time) / 60000);
  if (!Number.isFinite(time) || minutes < 0) return "时间待确认";
  if (minutes < 1) return "刚刚更新";
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前`;
  return `${Math.floor(minutes / 1440)} 天前`;
}
function categoryOf(check) {
  const family = HymDealEngine.extractSkuFactsV2(check.lead?.sku || check.pendingText || "").family;
  if (["iphone", "redmi", "xiaomi", "oneplus", "huawei", "honor", "oppo", "vivo"].includes(family)) return "phone";
  if (family === "ipad") return "tablet";
  if (["switch", "ps5"].includes(family)) return "console";
  if (family === "airpods") return "earbuds";
  if (["osmo", "insta360"].includes(family)) return "camera";
  return "other";
}
function effectiveQuote(check) { return (check.quotes || []).find(quote => quote.id === check.result?.quoteId) || null; }
function checkView(check, now = Date.now()) {
  const result = check.result || {}, deadline = Date.parse(result.validUntil);
  const expired = (Number.isFinite(deadline) && deadline <= now) || result.status === "expired" || (result.reasons || []).some(reason => ["购买线索过期", "报价过期", "核验已过期"].includes(reason));
  const verified = !expired && Number.isFinite(deadline) && ["eligible", "below_threshold"].includes(result.status) && Number.isFinite(result.netProfit) && !!effectiveQuote(check);
  return { kind: expired ? "expired" : verified ? "verified" : "pending", label: expired ? "已过期" : verified ? "已核实" : "待确认", profit: verified ? result.netProfit : null, below: verified && result.status === "below_threshold" };
}
function reasonText(reason) {
  const match = String(reason).match(/^(purchase|recycle)\.([a-zA-Z]+)$/);
  return match ? `${conditionLabels[match[2]] || "核验条件"}尚未通过核验` : String(reason);
}
function reasonsFor(check, view = checkView(check)) {
  if (view.kind === "expired") return ["核验依据已过期，等待新的有效核验"];
  const reasons = (check.result?.reasons || []).map(reasonText);
  return reasons.length ? reasons : view.kind === "pending" ? ["等待完整的价格与条件依据"] : [];
}
function filteredItems() {
  const query = pageState.search.normalize("NFKC").toLowerCase().trim();
  const items = pageState.items.filter(check => {
    const view = checkView(check);
    const text = `${check.lead?.sku || check.pendingText || ""} ${check.lead?.evidence?.source || ""} ${(check.quotes || []).map(q => q.evidence?.source || "").join(" ")}`.normalize("NFKC").toLowerCase();
    return (!query || text.includes(query)) && (pageState.category === "all" || categoryOf(check) === pageState.category) && (pageState.status === "all" || view.kind === pageState.status);
  });
  return items.sort((a, b) => {
    const recent = (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0);
    if (pageState.sort === "recent") return recent;
    if (pageState.sort === "price") return (a.lead?.buyPrice ?? Infinity) - (b.lead?.buyPrice ?? Infinity) || recent;
    const ap = checkView(a).profit, bp = checkView(b).profit;
    if (ap === null && bp !== null) return 1;
    if (bp === null && ap !== null) return -1;
    return (bp ?? 0) - (ap ?? 0) || recent;
  });
}
function valueCell(label, value, className = "") {
  const cell = node("span", `money-cell ${className}`);
  cell.appendChild(node("span", "cell-label", label));
  cell.appendChild(node("span", "cell-value", value));
  return cell;
}
function renderRow(check) {
  const view = checkView(check), quote = effectiveQuote(check), category = categoryOf(check);
  const row = node("button", "opportunity-row"); row.type = "button";
  row.dataset.checkId = check.id; row.setAttribute("aria-pressed", String(pageState.selectedId === check.id));
  const product = node("span", "product-cell"), copy = node("span", "product-copy");
  const icon = node("span", "category-icon", categoryLabels[category]); icon.setAttribute("aria-hidden", "true");
  product.appendChild(icon);
  copy.appendChild(node("strong", "product-name", check.lead?.sku || check.pendingText || "待补充商品规格"));
  const sources = [check.lead?.evidence?.source, quote?.evidence?.source].filter(Boolean);
  copy.appendChild(node("span", "product-meta", `${categoryLabels[category]}${sources.length ? ` · ${sources.join(" → ")}` : ""}`)); product.appendChild(copy); row.appendChild(product);
  row.appendChild(valueCell("购买价", formatMoney(check.lead?.buyPrice ?? check.result?.buyPrice)));
  const sell = view.kind === "expired" ? "已过期" : quote && Number.isFinite(check.result?.sellPrice) ? formatMoney(check.result.sellPrice) : "待核验";
  row.appendChild(valueCell("回收价", sell, view.kind === "expired" ? "expired-text" : ""));
  const profit = valueCell("净利润", view.profit === null ? "—" : formatSignedMoney(view.profit), `profit-cell${view.kind === "verified" && !view.below ? " positive" : ""}`);
  if (view.below) profit.appendChild(node("span", "sub-label", "低于门槛")); row.appendChild(profit);
  const status = node("span", "state-cell"); status.appendChild(node("span", `badge ${view.kind}`, view.label));
  status.appendChild(node("span", "sub-label", relativeTime(check.updatedAt)));
  if (view.kind !== "verified") status.appendChild(node("span", "row-reason", reasonsFor(check, view)[0]));
  row.appendChild(status);
  row.addEventListener("click", () => selectCheck(check.id));
  return row;
}
function section(title) { const element = node("section", "detail-section"); element.appendChild(node("h3", "", title)); return element; }
function renderConditions(title, names, conditions) {
  const group = section(title), list = node("div", "condition-list");
  for (const key of names) {
    const condition = conditions?.[key], state = ["verified", "unknown", "failed"].includes(condition?.status) ? condition.status : "unknown";
    const row = node("div", "condition-row"); row.appendChild(node("span", "", conditionLabels[key]));
    row.appendChild(node("span", `condition-state ${state}`, { verified: "已核实", unknown: "待确认", failed: "不满足" }[state]));
    row.appendChild(node("span", "condition-note", condition?.detail || "未提供核验依据")); list.appendChild(row);
  }
  group.appendChild(list); return group;
}
function renderEvidence(item, title) {
  const details = node("details", "evidence-item");
  details.appendChild(node("summary", "", `${title} · ${item.evidence?.source || "来源未提供"} · ${formatTime(item.evidence?.observedAt)}`));
  details.appendChild(node("p", "evidence-body", [`规格：${item.sku || "未提供"}`, `核验时间：${formatTime(item.evidence?.observedAt)}`, `来源有效至：${formatTime(item.evidence?.validUntil)}`, `证据引用：${item.evidence?.reference || "未提供"}`, `原文：${item.text || item.evidence?.excerpt || "未提供"}`, `摘要：${item.evidence?.excerpt || "未提供"}`].join("\n")));
  return details; // All evidence references remain plain text, never fetched or interpreted as URLs/HTML.
}
function renderDetail() {
  ui.detailContent.replaceChildren();
  const check = pageState.items.find(item => item.id === pageState.selectedId);
  if (!check) {
    pageState.detailOpen = false; ui.workspace.dataset.detailOpen = "false";
    const empty = node("div", "detail-placeholder"); empty.appendChild(node("span", "", "↗")); empty.appendChild(node("h3", "", "选择一件商品")); empty.appendChild(node("p", "", "查看价格依据、购买条件与回收规格。")); ui.detailContent.appendChild(empty); return;
  }
  ui.workspace.dataset.detailOpen = String(pageState.detailOpen);
  const view = checkView(check), result = check.result || {}, quote = effectiveQuote(check);
  const product = node("div", "detail-product"); product.appendChild(node("h3", "", check.lead?.sku || check.pendingText || "待补充商品规格")); product.appendChild(node("span", `badge ${view.kind}`, view.label)); product.appendChild(node("p", "", `最近核验 ${formatTime(check.updatedAt)}`)); ui.detailContent.appendChild(product);
  const box = node("div", `profit-box ${view.kind}`); box.appendChild(node("span", "", "净利润")); box.appendChild(node("strong", "detail-profit", view.profit === null ? view.kind === "expired" ? "核验已过期" : "待核验" : formatSignedMoney(view.profit)));
  if (view.profit !== null) {
    const costs = result.costs || {};
    box.appendChild(node("p", "", `${formatMoney(result.sellPrice)} − ${formatMoney(result.buyPrice)} − 运费/平台费/风险缓冲`));
    const tags = node("div", "costs"); for (const [key, label] of [["shippingCost", "运费"], ["platformCost", "平台费"], ["riskBuffer", "风险缓冲"]]) tags.appendChild(node("span", "", `${label} ${formatMoney(costs[key])}`)); box.appendChild(tags);
    box.appendChild(node("p", "", `${view.below ? "低于门槛 · " : ""}利润门槛 ${formatMoney(result.minimumProfit)} · 核验有效至 ${formatTime(result.validUntil)}`));
  } else { const list = node("ul", "reason-list"); for (const reason of reasonsFor(check, view)) list.appendChild(node("li", "", reason)); box.appendChild(list); }
  ui.detailContent.appendChild(box);
  ui.detailContent.appendChild(renderConditions("购买条件", ["finalPrice", "eligibility", "stock", "purchaseRules"], check.lead?.conditions));
  const recentQuote = quote || [...(check.quotes || [])].sort((a, b) => (Date.parse(b.evidence?.observedAt) || 0) - (Date.parse(a.evidence?.observedAt) || 0))[0];
  ui.detailContent.appendChild(renderConditions("回收条件", ["specification", "acceptance", "deductions", "settlement"], recentQuote?.conditions));
  if (!quote) ui.detailContent.appendChild(node("p", "expiry-note", "暂无服务端选定的有效回收报价；以下回收信息仅作为来源证据展示。"));
  const evidence = section("来源与证据");
  if (check.lead) evidence.appendChild(renderEvidence(check.lead, `购买实付 ${formatMoney(check.lead.buyPrice)}`));
  for (const item of check.quotes || []) evidence.appendChild(renderEvidence(item, `回收报价记录 ${formatMoney(item.price)}`));
  ui.detailContent.appendChild(evidence);
  ui.detailContent.appendChild(node("p", "expiry-note", "结果反映证据时间。来源条件声明仅作为依据；过期或关键条件未核实，不提供有效净利润。"));
}
function selectCheck(id) {
  pageState.selectedId = id; pageState.detailOpen = true; render();
  if (window.matchMedia("(max-width: 900px)").matches) { ui.detailBack.focus(); ui.detailPanel.scrollIntoView({ block: "start", behavior: "smooth" }); }
}
function closeDetail() {
  const id = pageState.selectedId; pageState.selectedId = null; pageState.detailOpen = false; render();
  const row = [...ui.checksList.children].find(item => item.dataset.checkId === id); row?.focus();
}
function render() {
  const counts = { verified: 0, pending: 0, expired: 0 }; for (const item of pageState.items) counts[checkView(item).kind]++;
  ui.countAll.textContent = String(pageState.items.length); ui.countVerified.textContent = String(counts.verified); ui.countPending.textContent = String(counts.pending); ui.countExpired.textContent = String(counts.expired);
  const items = filteredItems();
  if (!items.some(check => check.id === pageState.selectedId)) { pageState.selectedId = null; pageState.detailOpen = false; }
  ui.checksList.replaceChildren(...items.map(renderRow)); ui.checksList.setAttribute("aria-busy", String(pageState.phase === "loading"));
  ui.listState.hidden = items.length > 0; ui.stateAction.hidden = false;
  if (!pageState.connection) { ui.stateTitle.textContent = "连接后查看商品机会"; ui.stateDescription.textContent = "在设置中填写只读凭证，读取 Bot 提交的核验记录。这里不会生成示例机会。"; ui.stateAction.textContent = "打开设置"; }
  else if (pageState.phase === "loading") { ui.stateTitle.textContent = "正在读取核验记录"; ui.stateDescription.textContent = "完整读取商品与来源证据，请稍候。"; ui.stateAction.hidden = true; }
  else if (pageState.phase === "error") { ui.stateTitle.textContent = "暂时无法读取记录"; ui.stateDescription.textContent = pageState.error; ui.stateAction.textContent = "重新读取"; }
  else if (!pageState.items.length) { ui.stateTitle.textContent = "暂时没有商品机会"; ui.stateDescription.textContent = "接口已连接，尚未读到核验记录。网页连接不代表 Grok Bot 已接入。"; ui.stateAction.hidden = true; }
  else { ui.stateTitle.textContent = "没有符合筛选的商品"; ui.stateDescription.textContent = "试试其他关键词、品类或核验状态。"; ui.stateAction.textContent = "清除筛选"; }
  ui.listCount.textContent = `${items.length} / ${pageState.items.length} 条记录`;
  ui.refreshBtn.disabled = !pageState.connection || pageState.connection.loading || document.hidden;
  ui.checksDisconnect.disabled = !pageState.connection;
  ui.checksStatus.textContent = !pageState.connection ? "接口未连接" : pageState.phase === "loading" ? "正在同步核验记录…" : pageState.phase === "error" ? "接口读取失败" : pageState.syncedAt ? `接口已连接 · ${formatTime(pageState.syncedAt)} 同步` : "等待接口响应";
  renderDetail(); scheduleExpiry();
}
function scheduleExpiry() {
  clearTimeout(pageState.expiryTimer); pageState.expiryTimer = null;
  if (document.hidden || !pageState.items.length) return;
  const now = Date.now(), future = pageState.items.map(item => Date.parse(item.result?.validUntil)).filter(time => Number.isFinite(time) && time > now);
  if (future.length) pageState.expiryTimer = setTimeout(render, Math.min(2147483647, Math.max(25, Math.min(...future) - now + 1)));
}
function schedulePoll() {
  clearTimeout(pageState.pollTimer); pageState.pollTimer = null;
  if (pageState.connection && !document.hidden) pageState.pollTimer = setTimeout(refreshChecks, 30000);
}
function disconnectChecks() {
  const old = pageState.connection; pageState.connection = null; old?.controller?.abort(); if (old) old.token = "";
  clearTimeout(pageState.pollTimer); clearTimeout(pageState.expiryTimer);
  pageState.items = []; pageState.phase = "disconnected"; pageState.selectedId = null; pageState.detailOpen = false; pageState.syncedAt = null; pageState.error = "";
  ui.checksToken.value = ""; ui.settingsMessage.textContent = "已断开，凭证与记录已从当前页面清除。"; render();
}
async function connectChecks() {
  const token = ui.checksToken.value.trim(); ui.checksToken.value = "";
  try {
    const url = new URL(ui.checksUrl.value);
    const loopback = url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname);
    if ((url.protocol !== "https:" && !loopback) || !["/mcp", "/api/mcp"].includes(url.pathname) || url.username || url.password || url.search || url.hash) throw new Error("请输入 HTTPS 的 /api/mcp 地址，或本机 loopback 的 /mcp 地址。");
    if (!/^[\x21-\x7e]{32,256}$/.test(token)) throw new Error("请输入有效的只读凭证（32–256 个字符）。");
    disconnectChecks(); pageState.connection = { url: url.href, token, loading: false, initialized: false, controller: null };
    ui.settingsMessage.textContent = "凭证仅在本页内存中使用，输入框已清空。"; ui.settingsDialog.close(); await refreshChecks();
  } catch (error) { ui.settingsMessage.textContent = error.message; }
}
function assertCurrent(connection, signal) {
  if (connection !== pageState.connection || signal.aborted || document.hidden) throw new DOMException("Cancelled", "AbortError");
}
async function requestRpc(connection, method, params, id, controller) {
  assertCurrent(connection, controller.signal);
  const headers = { Authorization: `Bearer ${connection.token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25" };
  const message = { jsonrpc: "2.0", method }; if (params !== undefined) message.params = params; if (id !== undefined) message.id = id;
  const response = await fetch(connection.url, { method: "POST", redirect: "error", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]), headers, body: JSON.stringify(message) });
  assertCurrent(connection, controller.signal);
  if (!response.ok) throw new Error("无法读取接口，请检查地址、只读凭证及服务状态。");
  if (id === undefined) return null;
  const data = await response.json(); assertCurrent(connection, controller.signal);
  if (data.error || !data.result || data.result.isError) throw new Error("核验读取失败，请检查只读权限及服务状态。");
  return data.result;
}
async function refreshChecks() {
  const connection = pageState.connection;
  if (!connection || connection.loading || document.hidden) return;
  clearTimeout(pageState.pollTimer); connection.loading = true; pageState.phase = "loading"; pageState.error = ""; render();
  const controller = new AbortController(); connection.controller = controller;
  try {
    if (!connection.initialized) {
      const result = await requestRpc(connection, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "haoyangmao-dashboard", version: "2.0.0" } }, "init", controller);
      if (result.protocolVersion !== "2025-11-25") throw new Error("接口协议不兼容，请检查连接地址。");
      await requestRpc(connection, "notifications/initialized", undefined, undefined, controller); connection.initialized = true;
    }
    const items = [], ids = new Set(); let offset = 0, total = null;
    for (let page = 0; page < 4; page++) {
      const rpc = await requestRpc(connection, "tools/call", { name: "get_status", arguments: { offset, limit: 50 } }, page + 1, controller);
      const result = rpc.structuredContent;
      if (!result || !Array.isArray(result.items) || result.items.length > 50 || !Number.isInteger(result.total) || result.total < 0 || result.total > 200 || (total !== null && total !== result.total)) throw new Error("分页记录发生变化或不完整，请重新读取。");
      total = result.total;
      for (const item of result.items) {
        if (!item || typeof item.id !== "string" || !item.result || !Array.isArray(item.quotes) || ids.has(item.id)) throw new Error("分页记录不完整，请重新读取。");
        ids.add(item.id); items.push(item);
      }
      if (result.nextOffset === null) { if (items.length !== total) throw new Error("分页记录不完整，请重新读取。"); break; }
      if (!Number.isInteger(result.nextOffset) || result.nextOffset <= offset || result.nextOffset !== items.length || items.length >= total || page === 3) throw new Error("分页记录不完整，请重新读取。");
      offset = result.nextOffset;
    }
    assertCurrent(connection, controller.signal);
    pageState.items = items; pageState.phase = "ready"; pageState.syncedAt = new Date().toISOString(); pageState.error = "";
  } catch (error) {
    if (connection !== pageState.connection) return;
    if (controller.signal.aborted || document.hidden) { pageState.phase = pageState.syncedAt ? "ready" : "paused"; }
    else { pageState.items = []; pageState.selectedId = null; pageState.detailOpen = false; pageState.phase = "error"; pageState.error = "读取失败，请检查设置中的地址、只读凭证及服务状态后重试。"; }
  } finally {
    connection.loading = false; connection.controller = null;
    if (connection === pageState.connection) { render(); schedulePoll(); }
  }
}
function resetFilters() { pageState.search = ""; pageState.category = "all"; pageState.status = "all"; ui.opportunitySearch.value = ""; ui.categoryFilter.value = "all"; updateStatusFilters(); render(); }
function updateStatusFilters() { for (const button of ui.statusFilters.querySelectorAll("button")) button.setAttribute("aria-pressed", String(button.dataset.status === pageState.status)); }
function openSettings() { ui.settingsMessage.textContent = pageState.connection ? "当前网页持有只读连接，凭证不会回填或保存。" : "刷新页面后需重新填写只读凭证。"; ui.settingsDialog.showModal(); }
function init() {
  ui.checksUrl.value = location.protocol === "https:" ? new URL("/api/mcp", location.origin).href : "http://127.0.0.1:8766/mcp";
  ui.settingsOpen.addEventListener("click", openSettings); ui.settingsClose.addEventListener("click", () => ui.settingsDialog.close());
  ui.connectionForm.addEventListener("submit", event => { event.preventDefault(); connectChecks(); }); ui.checksDisconnect.addEventListener("click", disconnectChecks); ui.refreshBtn.addEventListener("click", refreshChecks);
  ui.detailClose.addEventListener("click", closeDetail); ui.detailBack.addEventListener("click", closeDetail);
  ui.opportunitySearch.addEventListener("input", () => { pageState.search = ui.opportunitySearch.value; render(); });
  ui.categoryFilter.addEventListener("change", () => { pageState.category = ui.categoryFilter.value; render(); });
  ui.sortOrder.addEventListener("change", () => { pageState.sort = ui.sortOrder.value; render(); });
  for (const button of ui.statusFilters.querySelectorAll("button")) button.addEventListener("click", () => { pageState.status = button.dataset.status; updateStatusFilters(); render(); });
  ui.stateAction.addEventListener("click", () => { if (!pageState.connection) openSettings(); else if (pageState.phase === "error") refreshChecks(); else resetFilters(); });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { clearTimeout(pageState.pollTimer); clearTimeout(pageState.expiryTimer); pageState.connection?.controller?.abort(); }
    else { render(); refreshChecks(); }
  });
  window.addEventListener("pagehide", disconnectChecks);
  render();
}
init();
