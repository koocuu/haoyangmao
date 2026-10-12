"use strict";
const crypto = require("crypto");
const { tools, validate } = require("../mcp/remote-schema");
const { parseDealV2, extractSkuFactsV2, scoreQuoteV2, normalizeForMatchV2, calculateNetProfit } = require("./deal-engine");
const { parseLeadLine, parseQuoteLine } = require("./remote-text");
const { parseRecyclerOcrText } = require("./quote-ocr-parser");
const DAY = 86400000;
const defaults = { minimumProfit: 80, shippingCost: 20, platformCost: 0, riskBuffer: 30, quoteMaxAgeMinutes: 30, leadMaxAgeMinutes: 60 };
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
function canonical(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return JSON.stringify(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return JSON.stringify(value);
}
function policyFor(config, workspace) {
  return { ...defaults, ...config.workspaces[workspace].policy };
}
function fresh(evidence, maxMinutes, now) {
  const observed = Date.parse(evidence?.observedAt);
  return observed <= now && now < Math.min(Date.parse(evidence?.validUntil), observed + maxMinutes * 60000);
}
function conditionProblems(conditions, prefix) {
  return Object.entries(conditions).filter(([, value]) => value.status !== "verified").map(([key]) => `${prefix}.${key}`);
}
function expiry(evidence, minutes) {
  return new Date(Math.min(Date.parse(evidence.validUntil), Date.parse(evidence.observedAt) + minutes * 60000)).toISOString();
}
function evaluate(check, policy, now = Date.now()) {
  const lead = check.lead;
  const reasons = [];
  if (!lead) return { status: "pending_confirmation", reasons: ["需要提交购买线索与条件"], netProfit: null };
  const facts = extractSkuFactsV2(lead.sku);
  // Existing fuzzy matcher is useful for candidates, but cannot prove arbitrary variants equal.
  const phone = ["iphone", "redmi", "xiaomi"].includes(facts.family);
  if (!facts.family || !facts.model || !facts.condition
    || (phone && (!facts.storage || facts.colors.length !== 1 || !facts.region || !facts.activation))
    || (facts.family === "ipad" && (!facts.storage || !facts.region))
    || (["switch", "ps5"].includes(facts.family) && !facts.region)) reasons.push("SKU 规格不完整或暂不支持自动核实");
  if (!fresh(lead.evidence, policy.leadMaxAgeMinutes, now)) reasons.push("购买线索过期");
  reasons.push(...conditionProblems(lead.conditions, "purchase"));
  if (check.parseWarnings?.length) reasons.push(...check.parseWarnings);
  const latest = new Map();
  for (const quote of check.quotes) {
    const key = `${quote.evidence.source}:${normalizeForMatchV2(quote.sku)}`;
    if (!latest.has(key) || Date.parse(latest.get(key).evidence.observedAt) <= Date.parse(quote.evidence.observedAt)) latest.set(key, quote);
  }
  const matched = [...latest.values()].filter((quote) => Number.isFinite(scoreQuoteV2(facts, { skuName: quote.sku })) && normalizeForMatchV2(quote.sku) === normalizeForMatchV2(lead.sku));
  const usable = matched.filter((quote) => fresh(quote.evidence, policy.quoteMaxAgeMinutes, now) && !quote.parseWarnings.length && !conditionProblems(quote.conditions, "recycle").length);
  if (!usable.length) reasons.push("缺少新鲜、规格一致且条件完整的回收报价");
  const floor = usable.sort((a, b) => a.price - b.price)[0];
  const netProfit = floor ? calculateNetProfit(floor.price, lead.buyPrice, policy) : null;
  return {
    status: reasons.length ? "pending_confirmation" : netProfit >= policy.minimumProfit ? "eligible" : "below_threshold",
    reasons, netProfit, buyPrice: lead.buyPrice, sellPrice: floor?.price ?? null,
    quoteId: floor?.id ?? null, minimumProfit: policy.minimumProfit,
    costs: { shippingCost: policy.shippingCost, platformCost: policy.platformCost, riskBuffer: policy.riskBuffer },
    validUntil: floor ? [expiry(lead.evidence, policy.leadMaxAgeMinutes), expiry(floor.evidence, policy.quoteMaxAgeMinutes)].sort()[0] : expiry(lead.evidence, policy.leadMaxAgeMinutes)
  };
}
function project(check, policy, now) {
  return { ...check, result: evaluate(check, policy, now) };
}
function evidenceCheck(evidence, now) {
  if (Date.parse(evidence.observedAt) > now || Date.parse(evidence.observedAt) < now - 7 * DAY || Date.parse(evidence.validUntil) <= Date.parse(evidence.observedAt)) throw new Error("Invalid evidence time: future/older than 7 days/invalid expiry");
  // References are opaque evidence identifiers, never fetched or embedded as HTML/links.
}

// Storage adapters commit the complete mutation and receipt before external effects.
class CheckCore {
  constructor({ config, data, notify = null, now = Date.now }) {
    this.config = config; this.data = data; this.notify = notify; this.now = now;
  }
  save() { throw new Error("Storage adapter required"); }
  prune() {
    const now = this.now();
    this.data.checks = this.data.checks.filter((item) => Date.parse(item.updatedAt) > now - 7 * DAY
      && (!item.lead || Date.parse(item.lead.evidence.observedAt) > now - 7 * DAY));
    this.data.receipts = this.data.receipts.filter((item) => item.at > now - 7 * DAY);
    this.data.notices = this.data.notices.filter((item) => item.at > now - 30 * DAY);
    for (const check of this.data.checks) {
      check.quotes = check.quotes.filter((quote) => Date.parse(quote.evidence.observedAt) > now - 7 * DAY);
      check.leadHistory = (check.leadHistory || []).filter((lead) => Date.parse(lead.evidence.observedAt) > now - 7 * DAY);
    }
  }
  importPending() {}
  find(principal, id) {
    const check = this.data.checks.find((item) => item.workspace === principal.workspace && item.id === id);
    if (!check) throw new Error("Check not found in authorized workspace");
    return check;
  }
  view(principal, check) { return project(check, policyFor(this.config, principal.workspace), this.now()); }
  async call(principal, name, args) {
    if (this.failed) throw new Error("Store unavailable");
    const tool = tools.find((item) => item.name === name);
    if (!tool || !principal.tools.includes(name)) throw new Error("Tool not authorized");
    validate(args, tool.inputSchema);
    this.prune();
    this.importPending();
    if (name === "get_status" || name === "get_pending_checks") {
      if (args.checkId) return this.view(principal, this.find(principal, args.checkId));
      const items = this.data.checks.filter((check) => check.workspace === principal.workspace).map((check) => this.view(principal, check)).filter((check) => name !== "get_pending_checks" || check.result.status === "pending_confirmation");
      const offset = args.offset || 0, limit = args.limit || 20;
      return { items: items.slice(offset, offset + limit), nextOffset: offset + limit < items.length ? offset + limit : null, total: items.length };
    }
    const requestHash = digest(canonical(args));
    const receiptKey = digest(`${principal.workspace}:${principal.id}:${name}:${args.idempotencyKey}`);
    const receipt = this.data.receipts.find((item) => item.key === receiptKey);
    if (receipt) {
      if (receipt.hash !== requestHash) throw new Error("Idempotency conflict");
      return { ...this.view(principal, this.find(principal, receipt.checkId)), replayed: true, submissionId: receipt.submissionId };
    }
    if (this.data.receipts.length >= 5000) throw new Error("Recent receipt capacity reached");
    evidenceCheck(args.evidence, this.now());
    const workspace = this.config.workspaces[principal.workspace];
    if (!workspace.sources.includes(args.evidence.source)) throw new Error("Source not authorized");
    if (!workspace.families.includes(extractSkuFactsV2(args.sku).family)) throw new Error("Product family not authorized");
    const at = new Date(this.now()).toISOString();
    let check, submissionId;
    if (name === "submit_lead") {
      const identity = digest(`${principal.workspace}:${args.evidence.source}:${args.evidence.reference}:${normalizeForMatchV2(args.sku)}`);
      const id = `check-${digest(`${principal.workspace}:${args.opportunityKey}`).slice(0, 24)}`;
      check = this.data.checks.find((item) => item.workspace === principal.workspace && (item.id === id || item.identity === identity));
      if (check?.identity && check.identity !== identity) throw new Error("Opportunity identity cannot change");
      if (check?.lead && Date.parse(check.lead.evidence.observedAt) > Date.parse(args.evidence.observedAt)) throw new Error("Older lead cannot overwrite newer verification");
      if (!check) {
        if (this.data.checks.length >= 200) throw new Error("Recent check capacity reached");
        check = { id, identity, workspace: principal.workspace, createdAt: at, quotes: [], notification: { status: "not_sent" } };
        this.data.checks.unshift(check);
      }
      const parsed = parseLeadLine(args.text, args.evidence.source);
      const parsedPrice = parseDealV2(args.text);
      if (check.lead && (check.leadHistory || []).length >= 10) throw new Error("Recent lead revision capacity reached");
      check.identity = identity;
      check.leadHistory = [...(check.leadHistory || []), ...(check.lead ? [check.lead] : [])];
      check.parseWarnings = parsedPrice.price && parsedPrice.price !== args.buyPrice ? ["购买文本与结构化价格冲突"] : [];
      if (!normalizeForMatchV2(args.text).includes(normalizeForMatchV2(args.sku))) check.parseWarnings.push("购买文本未包含完整结构化 SKU");
      check.lead = { opportunityKey: args.opportunityKey, text: args.text, sku: args.sku, buyPrice: args.buyPrice, evidence: args.evidence, conditions: args.conditions, submittedBy: principal.id, parsedLeadId: parsed?.id || null };
      submissionId = crypto.randomUUID();
    } else {
      check = this.find(principal, args.checkId);
      if (check.quotes.length >= 20) throw new Error("Recent quote capacity reached");
      const parsed = args.text ? [...parseRecyclerOcrText(args.text, { fallbackSource: args.evidence.source }), parseQuoteLine(args.text, args.evidence.source)].filter(Boolean) : [];
      const matching = parsed.filter((quote) => Number.isFinite(scoreQuoteV2(extractSkuFactsV2(args.sku), quote)) && quote.price === args.price);
      submissionId = crypto.randomUUID();
      check.quotes.push({ id: submissionId, sku: args.sku, price: args.price, text: args.text || "", evidence: args.evidence, conditions: args.conditions, submittedBy: principal.id, receivedAt: at, parseWarnings: args.text && !matching.length ? ["报价文本无法交叉验证结构化报价"] : [] });
    }
    check.updatedAt = at;
    this.data.receipts.push({ key: receiptKey, hash: requestHash, checkId: check.id, submissionId, at: this.now() });
    await this.save(); // Submission + receipt are committed together, before external effects.
    await this.maybeNotify(check);
    return { ...this.view(principal, check), submissionId, replayed: false };
  }
  async maybeNotify(check) {
    const result = evaluate(check, policyFor(this.config, check.workspace), this.now());
    if (result.status !== "eligible") return;
    const previous = this.data.notices.find((item) => item.identity === check.identity);
    if (previous) { check.notification = { status: previous.status, attemptedAt: new Date(previous.at).toISOString() }; return; }
    if (!this.notify) { check.notification = { status: "not_configured" }; await this.save(); return; }
    if (this.data.notices.length >= 10000) throw new Error("Notification capacity reached");
    const notice = { identity: check.identity, at: this.now(), status: "delivery_unknown" };
    this.data.notices.push(notice);
    check.notification = { status: notice.status, attemptedAt: new Date(notice.at).toISOString() };
    await this.save(); // At-most-once: crash/timeout is ambiguous and must not auto-retry.
    try { await this.notify({ id: check.id, workspace: check.workspace, sku: check.lead.sku, result }); notice.status = "sent"; }
    catch { notice.status = "delivery_unknown"; }
    check.notification.status = notice.status;
    await this.save();
  }
  async tick() {
    if (this.failed) throw new Error("Store unavailable");
    this.prune();
    this.importPending();
    for (const check of this.data.checks) await this.maybeNotify(check);
    await this.save();
  }
}

module.exports = { CheckCore, defaults, evaluate, project, policyFor };
