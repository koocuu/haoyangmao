const { parseDealV2, scoreQuoteV2, extractSkuFactsV2, normalizeForMatchV2, calculateNetProfit } = HymDealEngine;
const copy = {
  idle: "\u7c98\u8d34\u3001\u62d6\u5165\u6216\u70b9\u51fb\u9009\u56fe",
  uploading: "\u6b63\u5728\u4e0a\u4f20\u622a\u56fe...",
  parsing: "\u6b63\u5728\u5207\u56fe\u3001OCR\u3001\u89e3\u6790\u5c0f\u9e3d\u62a5\u4ef7...",
  done: (count) => `\u5bfc\u5165\u5b8c\u6210\uff1a\u65b0\u589e ${count} \u6761\u62a5\u4ef7`,
  failed: (message) => `\u5bfc\u5165\u5931\u8d25\uff1a${message}`,
  serviceDown: "\u670d\u52a1\u672a\u542f\u52a8\uff0c\u5148\u8fd0\u884c node automation-server.js",
  emptyQuotes: "\u6682\u65e0 AH \u62a5\u4ef7\uff0c\u7b49\u5f85\u6bcf\u65e5\u81ea\u52a8\u91c7\u96c6\u6216\u624b\u52a8\u91c7\u96c6\u4e00\u6b21",
  emptyHistory: "\u6682\u65e0\u5206\u6790\u8bb0\u5f55",
  openingKdocs: "\u6b63\u5728\u6253\u5f00 AH \u6388\u6743\u6d4f\u89c8\u5668...",
  collectingKdocs: "\u6b63\u5728\u91c7\u96c6 AH \u884c\u60c5\u8868...",
  kdocsOpened: "\u5df2\u6253\u5f00\uff0c\u786e\u8ba4\u9875\u9762\u80fd\u770b\u5230\u8868\u683c\u540e\u70b9\u91c7\u96c6",
  kdocsCollected: (count, textLength) => `\u91c7\u96c6\u5b8c\u6210\uff1a\u6587\u672c ${textLength} \u5b57\uff0c\u5165\u5e93 ${count} \u6761`,
  kdocsNeedsLogin: "\u53ea\u91c7\u5230 AH \u76ee\u5f55/\u8bbf\u5ba2\u58f3\uff1a\u8bf7\u5728\u6388\u6743\u6d4f\u89c8\u5668\u91cc\u767b\u5f55 WPS \u540e\u518d\u91c7\u96c6",
  kdocsNoQuotes: "\u91c7\u5230\u9875\u9762\u6587\u672c\uff0c\u4f46\u6ca1\u6709\u578b\u53f7+\u4ef7\u683c\u884c\uff1b\u4e0b\u4e00\u6b65\u6539\u8d70\u622a\u56fe OCR/\u5185\u90e8\u63a5\u53e3",
  xiaoge: "\u5c0f\u9e3d",
  readFailed: "\u8bfb\u53d6\u56fe\u7247\u5931\u8d25",
  categoryLabels: {
    phone: "\u624b\u673a",
    tablet: "\u5e73\u677f",
    console: "\u4e3b\u673a",
    earbuds: "\u8033\u673a",
    camera: "\u5f71\u50cf",
    watch: "\u624b\u8868",
    computer: "\u7535\u8111",
    accessory: "\u914d\u4ef6",
    other: "\u5176\u4ed6"
  }
};

const policy = {
  maxQuoteAgeMs: 30 * 60 * 1000,
  ahMaxQuoteAgeMs: 26 * 60 * 60 * 1000,
  shippingCost: 20,
  platformCost: 0,
  riskBuffer: 30,
  minimumQualityScore: 55
};

const els = {
  statusLine: document.querySelector("#statusLine"),
  dropZone: document.querySelector("#dropZone"),
  dropIdle: document.querySelector("#dropIdle"),
  longImageInput: document.querySelector("#longImageInput"),
  ocrStatus: document.querySelector("#ocrStatus"),
  ocrPreview: document.querySelector("#ocrPreview"),
  dealInput: document.querySelector("#dealInput"),
  analyzeBtn: document.querySelector("#analyzeBtn"),
  judgeBadge: document.querySelector("#judgeBadge"),
  resultEmpty: document.querySelector("#resultEmpty"),
  resultCard: document.querySelector("#resultCard"),
  kdocsOpenBtn: document.querySelector("#kdocsOpenBtn"),
  kdocsCollectBtn: document.querySelector("#kdocsCollectBtn"),
  kdocsStatus: document.querySelector("#kdocsStatus"),
  kdocsEvidence: document.querySelector("#kdocsEvidence"),
  localSourceActions: document.querySelector("#localSourceActions"),
  resultSku: document.querySelector("#resultSku"),
  buyPrice: document.querySelector("#buyPrice"),
  sellPrice: document.querySelector("#sellPrice"),
  quickPrice: document.querySelector("#quickPrice"),
  profit: document.querySelector("#profit"),
  reasonText: document.querySelector("#reasonText"),
  quoteCount: document.querySelector("#quoteCount"),
  historyCount: document.querySelector("#historyCount"),
  quoteSearch: document.querySelector("#quoteSearch"),
  quoteTable: document.querySelector("#quoteTable"),
  historyList: document.querySelector("#historyList")
};

let quotes = [];
let history = loadHistory();
let lastSyncedQuoteSuccessAt = "";
let remoteChecksConnection = null;

init();

function init() {
  document.querySelector("#checksUrl").value = location.protocol === "https:"
    ? new URL("/api/mcp", location.origin).href : "http://127.0.0.1:8766/mcp";
  bindEvents();
  refreshState();
  refreshAutomationStatus();
  refreshChecks();
  if (typeof setInterval === "function") setInterval(() => { if (!document.hidden) refreshChecks(); }, 30000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshChecks(); });
  if (typeof setInterval === "function") setInterval(refreshAutomationStatus, 30000);
  renderHistory();
}

function bindEvents() {
  document.querySelector("#checksConnect").addEventListener("click", () => {
    try {
      const url = new URL(document.querySelector("#checksUrl").value);
      const loopback = url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname);
      if ((url.protocol !== "https:" && !loopback) || !["/mcp", "/api/mcp"].includes(url.pathname) || url.username || url.password || url.search || url.hash) throw new Error("请输入 HTTPS 的 /api/mcp 地址，或本机 loopback 的 /mcp 地址");
      const token = document.querySelector("#checksToken").value.trim();
      if (!token) throw new Error("请输入只读凭证");
      remoteChecksConnection = { url: url.href, token };
      document.querySelector("#checksToken").value = "";
      refreshChecks();
    } catch (error) { document.querySelector("#checksStatus").textContent = error.message; }
  });
  document.querySelector("#checksDisconnect").addEventListener("click", () => {
    remoteChecksConnection = null;
    document.querySelector("#checksToken").value = "";
    document.querySelector("#checksList").textContent = "";
    refreshChecks();
  });
  els.analyzeBtn.addEventListener("click", analyzeDeal);
  els.kdocsOpenBtn.addEventListener("click", openKdocsSource);
  els.kdocsCollectBtn.addEventListener("click", collectKdocsSource);
  els.dealInput.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") analyzeDeal();
  });
  els.quoteSearch.addEventListener("input", renderQuotes);
}

async function refreshChecks() {
  const connection = remoteChecksConnection;
  const status = document.querySelector("#checksStatus");
  if (!connection) {
    document.querySelector("#checksList").textContent = "";
    status.textContent = "请展开连接设置，使用只读凭证读取核验";
    return;
  }
  if (connection.loading) return;
  connection.loading = true;
  try {
    let items = [];
    if (connection) {
      if (!connection.initialized) {
        const response = await fetch(connection.url, {
          method: "POST", redirect: "error", signal: AbortSignal.timeout(12000),
          headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
          body: JSON.stringify({ jsonrpc: "2.0", id: "init", method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "haoyangmao-dashboard", version: "1.0.0" } } })
        });
        if (!response.ok || !(await response.json()).result) throw new Error("初始化失败");
        const ready = await fetch(connection.url, {
          method: "POST", redirect: "error", signal: AbortSignal.timeout(12000),
          headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25" },
          body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })
        });
        if (!ready.ok) throw new Error("初始化失败");
        connection.initialized = true;
      }
      let offset = 0;
      do {
        const response = await fetch(connection.url, {
          method: "POST", redirect: "error", signal: AbortSignal.timeout(12000),
          headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_status", arguments: { offset, limit: 50 } } })
        });
        if (!response.ok) throw new Error(`连接失败 HTTP ${response.status}`);
        const rpc = await response.json();
        if (rpc.error || rpc.result?.isError) throw new Error("核验读取失败，请检查凭证权限");
        const result = rpc.result.structuredContent;
        items.push(...result.items);
        offset = result.nextOffset;
      } while (offset !== null && items.length < 200);
    }
    if (connection !== remoteChecksConnection) return;
    renderChecks(items);
    status.textContent = `${items.length} 条近期核验 · 每 30 秒刷新`;
  } catch {
    if (connection !== remoteChecksConnection) return;
    document.querySelector("#checksList").textContent = "";
    status.textContent = "读取失败，请检查地址、凭证及服务状态";
  } finally {
    connection.loading = false;
  }
}

function renderChecks(items) {
  const list = document.querySelector("#checksList");
  list.textContent = "";
  const labels = { eligible: "已核验 · 达到门槛", pending_confirmation: "待确认", below_threshold: "未达利润门槛" };
  const notices = { not_sent: "未发送", not_configured: "未配置提醒", sent: "已发送一次", delivery_unknown: "送达未确认，请人工核对（不自动重发）" };
  const conditionLabels = { finalPrice: "最终实付", eligibility: "购买资格", stock: "库存", purchaseRules: "购买限制", specification: "回收规格", acceptance: "收货条件", deductions: "扣费条件", settlement: "结算条件" };
  const conditionStates = { verified: "已核实", unknown: "待确认", failed: "不满足" };
  const describeEvidence = (item, kind) => [
    `${kind}：${item.sku}`,
    `来源：${item.evidence.source}；核验时间：${formatTime(item.evidence.observedAt)}`,
    `证据编号/引用：${item.evidence.reference}`,
    `原文：${item.text || item.evidence.excerpt}`,
    `证据摘要：${item.evidence.excerpt}`,
    ...Object.entries(item.conditions || {}).map(([key, value]) => `${conditionLabels[key] || "核验条件"}：${conditionStates[value.status] || "待确认"} — ${value.detail}`)
  ].join("\n");
  for (const check of items) {
    const row = document.createElement("article");
    const title = document.createElement("strong");
    const result = check.result;
    const expired = result.validUntil && Date.parse(result.validUntil) <= Date.now();
    title.textContent = `${expired ? "待确认 · 核验已过期" : labels[result.status] || "待确认"} — ${check.lead?.sku || check.pendingText || check.id}`;
    const detail = document.createElement("p");
    const reasons = (result.reasons || []).map((reason) => reason.startsWith("purchase.") ? `${conditionLabels[reason.slice(9)] || "购买条件"}尚未通过核验` : reason);
    detail.textContent = `${result.status === "pending_confirmation" ? "预估净利润" : "净利润"} ${expired || result.netProfit === null ? "待核验" : formatSignedMoney(result.netProfit)}；提醒：${notices[check.notification.status] || "待处理"}。${reasons.join("；")}`;
    row.appendChild(title); row.appendChild(detail);
    if (check.lead) {
      const source = document.createElement("p");
      const quote = check.quotes.find((item) => item.id === result.quoteId);
      source.textContent = `购买 ${check.lead.evidence.source} · ${formatTime(check.lead.evidence.observedAt)}${quote ? `；回收 ${quote.evidence.source} · ${formatTime(quote.evidence.observedAt)}` : ""}`;
      row.appendChild(source);
      const evidence = document.createElement("details");
      const summary = document.createElement("summary"); summary.textContent = "来源与核验证据";
      const text = document.createElement("pre");
      text.style.whiteSpace = "pre-wrap";
      text.textContent = [describeEvidence(check.lead, `购买实付 ${formatMoney(check.lead.buyPrice)}`),
        ...check.quotes.map((item) => describeEvidence(item, `净回收报价 ${formatMoney(item.price)}`)),
        `额外成本：运费 ${formatMoney(result.costs.shippingCost)}，平台费 ${formatMoney(result.costs.platformCost)}，风险预留 ${formatMoney(result.costs.riskBuffer)}\n核验有效至：${formatTime(result.validUntil)}`
      ].join("\n\n");
      evidence.appendChild(summary); evidence.appendChild(text); row.appendChild(evidence);
    }
    list.appendChild(row);
  }
}

async function openKdocsSource() {
  try {
    setKdocsStatus(copy.openingKdocs);
    await callAutomation("/api/kdocs/open", {
      method: "POST",
      body: JSON.stringify({ id: "ah-kdocs" })
    });
    setKdocsStatus(copy.kdocsOpened);
  } catch (error) {
    console.error(error);
    setKdocsStatus(error.message);
  }
}

async function collectKdocsSource() {
  try {
    setKdocsStatus(copy.collectingKdocs);
    const result = await callAutomation("/api/kdocs/collect", {
      method: "POST",
      body: JSON.stringify({ id: "ah-kdocs" })
    });
    await refreshState();
    setKdocsStatus(formatKdocsResult(result));
    await refreshAutomationStatus();
  } catch (error) {
    console.error(error);
    setKdocsStatus(error.message);
  }
}

function formatKdocsResult(result) {
  const diagnostics = result.diagnostics || {};
  if (diagnostics.message) return diagnostics.message;
  if (diagnostics.level === "login") return copy.kdocsNeedsLogin;
  if (diagnostics.level === "no-quotes") return copy.kdocsNoQuotes;
  return copy.kdocsCollected(result.imported?.imported || 0, result.session?.textLength || 0);
}

async function importImageFile(file) {
  try {
    setUploadStatus(copy.uploading);
    const dataUrl = await readFileAsDataUrl(file);
    renderPreview(dataUrl);
    const uploaded = await callAutomation("/api/automation/upload-image", {
      method: "POST",
      body: JSON.stringify({ filename: file.name || "clipboard.png", dataUrl })
    });
    setUploadStatus(copy.parsing);
    const result = await callAutomation("/api/automation/import-xiaoge-long-screenshot", {
      method: "POST",
      body: JSON.stringify({ imagePath: uploaded.relativePath || uploaded.imagePath })
    });
    await refreshState();
    setUploadStatus(copy.done(result.imported || 0));
  } catch (error) {
    console.error(error);
    setUploadStatus(copy.failed(error.message));
  }
}

async function refreshState() {
  try {
    const state = await callAutomation("/api/automation/state");
    quotes = sanitizeQuotes(state.quotes || []);
    renderQuotes();
    renderStats();
  } catch (error) {
    quotes = [];
    renderQuotes();
    setUploadStatus(copy.serviceDown);
  }
}

async function refreshAutomationStatus() {
  try {
    const status = await callAutomation("/api/automation/status");
    const scheduler = status.scheduler || {};
    const cloudMode = status.mode === "cloud";
    if (els.localSourceActions) {
      if (cloudMode) els.localSourceActions.classList.add("hidden");
      else els.localSourceActions.classList.remove("hidden");
    }
    if (scheduler.lastSuccessAt && scheduler.lastSuccessAt !== lastSyncedQuoteSuccessAt) {
      await refreshState();
      lastSyncedQuoteSuccessAt = scheduler.lastSuccessAt;
    }
    if (cloudMode && scheduler.lastSuccessAt) {
      const imported = Number(scheduler.lastImported || 0);
      setKdocsStatus(`AH 云端快照，上次同步 ${formatRelativeTime(status.syncedAt || scheduler.lastCloudSyncAt || scheduler.lastSuccessAt)}，报价 ${imported} 条`);
    } else if (cloudMode && scheduler.lastError) {
      setKdocsStatus(scheduler.lastError);
    } else if (scheduler.lastSuccessAt) {
      const imported = Number(scheduler.lastImported || 0);
      setKdocsStatus(`AH 自动监控中，上次成功 ${formatRelativeTime(scheduler.lastSuccessAt)}，入库 ${imported} 条`);
    } else if (scheduler.lastError) {
      setKdocsStatus(`AH 自动监控已开启，等待授权浏览器：${scheduler.lastError}`);
    } else if (status.running) {
      setKdocsStatus("AH 自动监控已开启，等待首次采集");
    }

    if (els.kdocsEvidence) {
      if (scheduler.lastEvidencePath) {
        els.kdocsEvidence.href = scheduler.lastEvidencePath;
        els.kdocsEvidence.classList.remove("hidden");
      } else {
        els.kdocsEvidence.classList.add("hidden");
      }
    }
  } catch (error) {
    console.error(error);
  }
}

function analyzeDeal() {
  const rawText = els.dealInput.value.trim();
  const deal = parseDealV2(rawText);
  if (!deal.price) {
    showResult({
      label: "\u2445\u5f85\u786e\u8ba4".replace("\u2445", ""),
      className: "wait",
      reason: "\u6ca1\u8bc6\u522b\u5230\u5238\u540e\u4ef7\u6216\u5230\u624b\u4ef7\u3002",
      rawText
    });
    return;
  }

  const matches = matchQuotesV2(rawText);
  if (!matches.length) {
    showResult({
      label: "\u65e0\u62a5\u4ef7",
      className: "wait",
      buyPrice: deal.price,
      reason: "\u62a5\u4ef7\u5e93\u91cc\u8fd8\u6ca1\u6709\u5339\u914d\u5230\u8fd9\u4e2a\u578b\u53f7\uff0c\u7b49\u5f85 AH \u4e0b\u4e00\u6b21\u91c7\u96c6\u6216\u5728\u884c\u60c5\u8868\u4e2d\u786e\u8ba4\u8be5\u578b\u53f7\u3002",
      rawText
    });
    return;
  }

  const usableMatches = matches.filter((quote) => isQuoteFresh(quote) && Number(quote.qualityScore || 0) >= policy.minimumQualityScore);
  if (!usableMatches.length) {
    const latest = [...matches].sort((a, b) => new Date(b.observedAt || 0) - new Date(a.observedAt || 0))[0];
    showResult({
      label: "\u62a5\u4ef7\u8fc7\u671f",
      className: "wait",
      skuName: quoteDisplayName(latest),
      buyPrice: deal.price,
      sellPrice: latest.price,
      quickPrice: latest.price,
      reason: `\u5339\u914d\u5230 ${matches.length} \u6761\u62a5\u4ef7\uff0c\u4f46\u6700\u65b0\u4e00\u6761\u5df2\u662f ${formatQuoteAge(latest.observedAt)}\u3002\u8be5\u6765\u6e90\u7684\u6709\u6548\u671f\u662f ${formatMaxQuoteAge(latest)}\uff0c\u8fc7\u671f\u62a5\u4ef7\u4e0d\u53c2\u4e0e\u53ef\u51b2\u5224\u65ad\u3002`,
      rawText
    });
    return;
  }

  const ordered = [...usableMatches].sort((a, b) => a.price - b.price);
  const floorQuote = ordered[0];
  const quickQuote = ordered[ordered.length - 1];
  const floorPrice = floorQuote.price;
  const quickPrice = quickQuote.price;
  const floorProfit = calculateNetProfit(floorPrice, deal.price, policy);
  const quickProfit = calculateNetProfit(quickPrice, deal.price, policy);
  const verdict = buildVerdictV2(floorProfit, quickProfit);
  const warnings = getVariantWarningsV2(rawText);
  const warningText = warnings.length ? `\u89c4\u683c\u672a\u5b8c\u6574\uff08${warnings.join("\u3001")}\uff09\uff0c\u5df2\u6309\u6700\u4f4e\u5339\u914d\u4ef7\u4fdd\u5e95\u3002` : "\u989c\u8272\u3001\u7248\u672c\u548c\u72b6\u6001\u5df2\u6309\u8f93\u5165\u7ea6\u675f\u3002";
  showResult({
    ...verdict,
    skuName: quoteDisplayName(floorQuote),
    buyPrice: deal.price,
    sellPrice: floorPrice,
    quickPrice,
    profit: floorProfit,
    quickProfit,
    reason: `\u6709\u6548\u5339\u914d ${usableMatches.length} \u6761\uff0c\u4fdd\u5e95 ${formatMoney(floorPrice)}\uff0c\u5feb\u51fa ${formatMoney(quickPrice)}\u3002\u5df2\u6263\u8fd0\u8d39 ${formatMoney(policy.shippingCost)} + \u5e73\u53f0 ${formatMoney(policy.platformCost)} + \u98ce\u9669\u7f13\u51b2 ${formatMoney(policy.riskBuffer)}\u3002${warningText}`,
    rawText
  });
}

function parseDeal(rawText) {
  const prices = [...String(rawText || "").matchAll(/\b(\d{3,5})\b/g)]
    .map((match) => Number(match[1]))
    .filter((price) => price >= 100 && price <= 30000);
  return { price: prices.length ? prices[prices.length - 1] : 0 };
}

function matchQuotes(rawText) {
  const normalizedDeal = normalizeForMatch(rawText);
  return quotes
    .map((quote) => ({ quote, score: scoreQuote(normalizedDeal, quote) }))
    .filter((item) => item.score >= 4)
    .sort((a, b) => b.quote.price - a.quote.price || b.score - a.score)
    .map((item) => item.quote);
}

function scoreQuote(normalizedDeal, quote) {
  const tokens = tokenizeSku(`${quote.normalizedSku || ""} ${quote.skuName || ""}`);
  let score = 0;
  for (const token of tokens) {
    if (normalizedDeal.includes(normalizeForMatch(token))) {
      score += Math.min(8, token.length);
    }
  }
  return score;
}

function tokenizeSku(skuName) {
  return String(skuName || "")
    .replace(/\b(全新|国行|海外版|标准|套装)\b/g, " ")
    .split(/[\s/()（）,，]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !["全新", "国行"].includes(token));
}

function normalizeForMatch(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/（|）|\(|\)|,|，|\.|。|-/g, "");
}

function matchQuotesV2(rawText) {
  const dealFacts = extractSkuFactsV2(rawText);
  return quotes
    .map((quote) => ({ quote, score: scoreQuoteV2(dealFacts, quote) }))
    .filter((item) => Number.isFinite(item.score) && item.score >= 20)
    .sort((a, b) => b.score - a.score || Number(b.quote.qualityScore || 0) - Number(a.quote.qualityScore || 0) || b.quote.price - a.quote.price)
    .map((item) => item.quote);
}

function isQuoteFresh(quote, now = Date.now()) {
  const observedAt = new Date(quote?.observedAt || 0).getTime();
  return Number.isFinite(observedAt) && observedAt > 0 && now - observedAt <= quoteMaxAgeMs(quote);
}

function quoteMaxAgeMs(quote) {
  return /AH\s*\u6536\u8d27\u884c\u60c5\u8868/i.test(String(quote?.sourceName || ""))
    ? policy.ahMaxQuoteAgeMs
    : policy.maxQuoteAgeMs;
}

function formatMaxQuoteAge(quote) {
  return quoteMaxAgeMs(quote) === policy.ahMaxQuoteAgeMs ? "26 \u5c0f\u65f6" : "30 \u5206\u949f";
}

function formatQuoteAge(value) {
  const timestamp = new Date(value || 0).getTime();
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "\u672a\u77e5\u65f6\u95f4";
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
  if (minutes < 1) return "\u521a\u521a";
  if (minutes < 60) return `${minutes} \u5206\u949f\u524d`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} \u5c0f\u65f6\u524d`;
  return `${Math.floor(hours / 24)} \u5929\u524d`;
}

function formatRelativeTime(value) {
  return formatQuoteAge(value);
}

function getVariantWarningsV2(rawText) {
  const facts = extractSkuFactsV2(rawText);
  const warnings = [];
  if (!facts.colors.length) warnings.push("\u989c\u8272");
  if (!facts.region) warnings.push("\u7248\u672c");
  if (!facts.activation) warnings.push("\u6fc0\u6d3b\u72b6\u6001");
  return warnings;
}

function buildVerdictV2(floorProfit, quickProfit) {
  if (floorProfit >= 80) return { label: "\u53ef\u51b2", className: "go" };
  if (floorProfit >= 0 && quickProfit >= 120) return { label: "\u53ef\u5173\u6ce8", className: "watch" };
  if (floorProfit >= 0) return { label: "\u5229\u6da6\u8584", className: "wait" };
  return { label: "\u522b\u78b0", className: "stop" };
}

function buildVerdict(profit) {
  if (profit >= 150) return { label: "\u53ef\u51b2", className: "go" };
  if (profit >= 50) return { label: "\u53ef\u5173\u6ce8", className: "watch" };
  if (profit >= 0) return { label: "\u5229\u6da6\u8584", className: "wait" };
  return { label: "\u522b\u78b0", className: "stop" };
}

function showResult(result) {
  els.judgeBadge.textContent = result.label;
  els.judgeBadge.className = `badge ${result.className}`;
  els.resultEmpty.classList.add("hidden");
  els.resultCard.classList.remove("hidden");
  els.resultSku.textContent = result.skuName || "-";
  els.buyPrice.textContent = formatMoney(result.buyPrice);
  els.sellPrice.textContent = formatMoney(result.sellPrice);
  if (els.quickPrice) els.quickPrice.textContent = formatMoney(result.quickPrice);
  els.profit.textContent = typeof result.profit === "number" ? formatSignedMoney(result.profit) : "-";
  els.profit.className = typeof result.profit === "number" ? result.profit >= 0 ? "positive" : "negative" : "";
  els.reasonText.textContent = result.reason;

  const record = {
    ...result,
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    createdAt: new Date().toISOString()
  };
  history.unshift(record);
  history = history.slice(0, 20);
  localStorage.setItem("haoyangmao_history_v3", JSON.stringify(history));
  renderHistory();
  renderStats();
}

function sanitizeQuotes(items) {
  const seen = new Set();
  const clean = [];
  for (const quote of items) {
    const text = `${quote.normalizedSku || ""} ${quote.skuName || ""} ${quote.rawText || ""}`;
    if (hasBrokenText(text)) continue;
    if (Number(quote.qualityScore || 0) < policy.minimumQualityScore) continue;
    const key = `${quote.sourceName || ""}:${quote.normalizedSku || quote.skuName || ""}:${quote.price || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    clean.push(quote);
  }
  return clean;
}

function renderQuotes() {
  const query = normalizeForMatch(els.quoteSearch.value);
  const sorted = [...quotes]
    .filter((quote) => !query || normalizeForMatch(`${quoteDisplayName(quote)} ${quote.skuName || ""}`).includes(query))
    .sort((a, b) => new Date(b.observedAt || 0) - new Date(a.observedAt || 0));

  els.quoteTable.innerHTML = "";
  if (!sorted.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 6;
    cell.className = "empty-row";
    cell.textContent = copy.emptyQuotes;
    row.appendChild(cell);
    els.quoteTable.appendChild(row);
    return;
  }

  for (const quote of sorted.slice(0, 300)) {
    const row = document.createElement("tr");
    row.appendChild(makeCell(quoteDisplayName(quote), "sku-cell", quote.skuName || quote.rawText || ""));
    row.appendChild(makeCell(categoryLabel(quote.category), "muted-cell"));
    row.appendChild(makeCell(formatMoney(quote.price), "price"));
    row.appendChild(makeCell(qualityLabel(quote), qualityClass(quote)));
    row.appendChild(makeCell(quote.sourceName || copy.xiaoge));
    row.appendChild(makeCell(`${formatTime(quote.observedAt)} · ${formatQuoteAge(quote.observedAt)}`, isQuoteFresh(quote) ? "fresh-time" : "stale-time"));
    els.quoteTable.appendChild(row);
  }
}

function quoteDisplayName(quote) {
  const base = quote.displaySku || quote.normalizedSku || quote.skuName || "-";
  const condition = String(quote.conditionNote || "").trim();
  if (!condition || normalizeForMatch(base).includes(normalizeForMatch(condition))) return base;
  return `${base} \u00b7 ${condition}`;
}

function renderHistory() {
  els.historyList.innerHTML = "";
  if (!history.length) {
    const empty = document.createElement("div");
    empty.className = "empty-history";
    empty.textContent = copy.emptyHistory;
    els.historyList.appendChild(empty);
    return;
  }
  for (const item of history.slice(0, 8)) {
    const card = document.createElement("article");
    card.className = "history-item";
    card.innerHTML = `
      <strong>${escapeHtml(item.label || "-")} · ${escapeHtml(item.skuName || item.rawText || "-")}</strong>
      <span>${formatMoney(item.buyPrice)} -> ${formatMoney(item.sellPrice)} / ${typeof item.profit === "number" ? formatSignedMoney(item.profit) : "-"}</span>
    `;
    els.historyList.appendChild(card);
  }
}

function renderStats() {
  els.quoteCount.textContent = quotes.length;
  els.historyCount.textContent = history.length;
}

function makeCell(value, className = "", title = "") {
  const cell = document.createElement("td");
  cell.textContent = value;
  if (className) cell.className = className;
  if (title) cell.title = title;
  return cell;
}

function categoryLabel(category) {
  return copy.categoryLabels[category] || copy.categoryLabels.other;
}

function qualityLabel(quote) {
  const score = Number(quote.qualityScore || 0);
  if (!score) return "-";
  return `${score}`;
}

function qualityClass(quote) {
  const score = Number(quote.qualityScore || 0);
  if (score >= 75) return "quality quality-good";
  if (score >= 55) return "quality quality-warn";
  return "quality quality-bad";
}

function renderPreview(dataUrl) {
  els.ocrPreview.src = dataUrl;
  els.ocrPreview.classList.remove("hidden");
  els.dropIdle.classList.add("hidden");
}

function setUploadStatus(message) {
  if (els.ocrStatus) els.ocrStatus.textContent = message;
  els.statusLine.textContent = message;
}

function setKdocsStatus(message) {
  els.kdocsStatus.textContent = message;
  els.statusLine.textContent = message;
}

function formatMoney(value) {
  const number = Number(value || 0);
  return number ? `\u00a5${number}` : "-";
}

function formatSignedMoney(value) {
  const number = Number(value || 0);
  return `${number >= 0 ? "+" : "-"}\u00a5${Math.abs(number)}`;
}

function formatTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function hasBrokenText(value) {
  return /[\uFFFD]/.test(String(value || ""));
}

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem("haoyangmao_history_v3") || "[]");
  } catch (error) {
    return [];
  }
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error(copy.readFailed));
    reader.readAsDataURL(file);
  });
}

async function callAutomation(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const data = await response.json();
  if (!response.ok || data.error) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data;
}

globalThis.__setQuotesForTest = (items) => {
  quotes = sanitizeQuotes(items || []);
  renderQuotes();
  renderStats();
};
