"use strict";
const crypto = require("crypto");
const { tools, validate, validateArguments, quoteItem } = require("../mcp/remote-schema");
const { parseDealV2, extractSkuFactsV2, scoreQuoteV2, normalizeForMatchV2, normalizeSkuForMatchV2, legacySkuVariantsV2, calculateNetProfit } = require("./deal-engine");
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
function missingSpecs(sku) {
  const facts = extractSkuFactsV2(sku), missing = [];
  for (const key of ["family", "model", "condition"]) if (!facts[key]) missing.push(key);
  if (["iphone", "redmi", "xiaomi", "huawei", "oppo", "oneplus", "vivo", "samsung", "honor", "realme", "ipad", "mac"].includes(facts.family)) {
    for (const key of ["storage", "region", "activation"]) if (!facts[key]) missing.push(key);
    if (!["iphone", "mac"].includes(facts.family) && !facts.ram) missing.push("ram");
    if (facts.colors.length !== 1) missing.push("singleColor");
  }
  if (facts.family === "mac") {
    for (const key of ["chip", "unifiedMemory"]) if (!facts[key]) missing.push(key);
    if (/macbook/.test(facts.model) && !facts.screenSize) missing.push("screenSize");
  }
  if (facts.family === "ipad" && /ipad:(?:pro|air)m/.test(facts.model) && !facts.screenSize) missing.push("screenSize");
  for (const key of ["brandConflict", "unknownSpecs", "unsupportedVariant"]) if (facts[key]) missing.push(key);
  if (["switch", "ps5"].includes(facts.family) && !facts.region) missing.push("region");
  return missing;
}
function quoteDiagnostics(lead, quote, policy, now) {
  const a = extractSkuFactsV2(lead.sku), b = extractSkuFactsV2(quote.sku);
  const differences = ["family", "model", "ram", "storage", "colors", "region", "activation", "condition", "chip", "unifiedMemory", "screenSize", "brandConflict"].filter(key => JSON.stringify(a[key]) !== JSON.stringify(b[key]));
  if (normalizeSkuForMatchV2(lead.sku) !== normalizeSkuForMatchV2(quote.sku)) differences.push("fullSku");
  const reasons = [...conditionProblems(quote.conditions, "recycle"), ...quote.parseWarnings];
  if (!fresh(quote.evidence, policy.quoteMaxAgeMinutes, now)) reasons.push("回收报价过期");
  return { missingSpecs: missingSpecs(quote.sku), differences, reasons };
}
function authorizeEvidence(config, principal, args) {
  const workspace = config.workspaces[principal.workspace];
  if (!workspace || !workspace.sources.includes(args.evidence.source)) throw new Error("Source not authorized");
  if (!workspace.families.includes(extractSkuFactsV2(args.sku).family)) throw new Error("Product family not authorized");
}
function authorizeCall(config, principal, name, args) {
  if (!tools.some(tool => tool.name === name) || !principal.tools.includes(name)) throw new Error("Tool not authorized");
  validateArguments(name, args);
  if (["submit_lead", "submit_quote", "preview_check"].includes(name)) authorizeEvidence(config, principal, args);
}
function publicError(error) {
  const safe = /^(Invalid arguments(?:\.[a-zA-Z0-9]+)*$|Tool not authorized$|Check not found in authorized workspace$|Check is voided$|Idempotency conflict$|Recent (?:receipt|check|quote|lead revision) capacity reached$|Source not authorized$|Product family not authorized$|Opportunity identity cannot change$|Older lead cannot overwrite newer verification$|Invalid evidence time: future\/older than 7 days\/invalid expiry$|Notification capacity reached$)/.test(error.message || "");
  return safe ? error.message : "Processing unavailable; inspect service configuration";
}
function identityKeys(workspace, lead) {
  return legacySkuVariantsV2(lead.sku).map(sku => digest(`${workspace}:${lead.evidence.source}:${lead.evidence.reference}:${sku}`));
}
function canonicalIdentity(check) {
  return check.lead && digest(`${check.workspace}:${check.lead.evidence.source}:${check.lead.evidence.reference}:${normalizeSkuForMatchV2(check.lead.sku)}`);
}
function previousNotice(data, check) {
  const keys = new Set([check.identity, ...identityKeys(check.workspace, check.lead)]);
  const canonicalKey = canonicalIdentity(check);
  return data.notices.find(notice => keys.has(notice.identity) || notice.canonicalIdentity === canonicalKey);
}
function evaluate(check, policy, now = Date.now()) {
  if (check.voided) return { status: "voided", reasons: ["核验已作废"], netProfit: null, sellPrice: null, quoteId: null, validUntil: null };
  const lead = check.lead;
  const reasons = [];
  if (!lead) return { status: "pending_confirmation", reasons: ["需要提交购买线索与条件"], netProfit: null };
  const facts = extractSkuFactsV2(lead.sku);
  // Existing fuzzy matcher is useful for candidates, but cannot prove arbitrary variants equal.
  if (missingSpecs(lead.sku).length) reasons.push("SKU 规格不完整或暂不支持自动核实");
  if (!fresh(lead.evidence, policy.leadMaxAgeMinutes, now)) reasons.push("购买线索过期");
  reasons.push(...conditionProblems(lead.conditions, "purchase"));
  if (check.parseWarnings?.length) reasons.push(...check.parseWarnings);
  const latest = new Map();
  for (const quote of check.quotes) {
    const key = `${quote.evidence.source}:${normalizeSkuForMatchV2(quote.sku)}`;
    if (!latest.has(key) || Date.parse(latest.get(key).evidence.observedAt) <= Date.parse(quote.evidence.observedAt)) latest.set(key, quote);
  }
  const matched = [...latest.values()].filter((quote) => Number.isFinite(scoreQuoteV2(facts, { skuName: quote.sku })) && normalizeSkuForMatchV2(quote.sku) === normalizeSkuForMatchV2(lead.sku));
  const usable = matched.filter((quote) => !missingSpecs(quote.sku).length && fresh(quote.evidence, policy.quoteMaxAgeMinutes, now) && !quote.parseWarnings.length && !conditionProblems(quote.conditions, "recycle").length);
  if (!usable.length) reasons.push("缺少新鲜、规格一致且条件完整的回收报价");
  const floor = usable.sort((a, b) => a.price - b.price)[0];
  // An arithmetic margin is not a verified profit while any purchase/spec/time
  // requirement is unresolved. Keep source prices as evidence, never as approval.
  const netProfit = floor && !reasons.length ? calculateNetProfit(floor.price, lead.buyPrice, policy) : null;
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
    authorizeCall(this.config, principal, name, args);
    if (name === "preview_check") return previewCheck(this.config, principal, args, this.now());
    if (this.failed) throw new Error("Store unavailable");
    this.prune();
    this.importPending();
    if (name === "get_status" || name === "get_pending_checks") {
      if (args.checkId) return this.view(principal, this.find(principal, args.checkId));
      const items = this.data.checks.filter((check) => check.workspace === principal.workspace && (!check.voided || (name === "get_status" && args.includeVoided))).map((check) => this.view(principal, check)).filter((check) => name !== "get_pending_checks" || check.result.status === "pending_confirmation");
      const offset = args.offset || 0, limit = args.limit || 20;
      return { items: items.slice(offset, offset + limit), nextOffset: offset + limit < items.length ? offset + limit : null, total: items.length };
    }
    if (name === "void_check") {
      const check = this.find(principal, args.checkId), replayed = Boolean(check.voided);
      if (!replayed) {
        check.voided = { reason: args.reason, by: principal.id, at: new Date(this.now()).toISOString() };
        check.updatedAt = check.voided.at;
        await this.save();
      }
      return { ...this.view(principal, check), replayed };
    }
    if (name === "submit_quotes") {
      const check = this.find(principal, args.checkId);
      if (check.voided) throw new Error("Check is voided");
      const items = this.applyQuotes(principal, args.checkId, args.quotes);
      await this.save(); // One final commit; no intermediate notification.
      await this.maybeNotify(check);
      return { ...this.view(principal, check), items };
    }
    const result = this.applySubmission(principal, name, args);
    if (!result.replayed) await this.save();
    const check = this.find(principal, result.id);
    await this.maybeNotify(check);
    return { ...this.view(principal, check), submissionId: result.submissionId, replayed: result.replayed };
  }
  applyQuotes(principal, checkId, quotes) {
    return quotes.map((quote, index) => {
      const check = this.find(principal, checkId), before = structuredClone(check), receiptCount = this.data.receipts.length;
      try {
        validate(quote, quoteItem);
        const result = this.applySubmission(principal, "submit_quote", { ...quote, checkId });
        return { index, success: true, submissionId: result.submissionId, replayed: result.replayed };
      } catch (error) {
        // Roll back this item's bounded check/receipt snapshot, including a
        // parser/evaluation failure. Never catch an external storage write here.
        for (const key of Object.keys(check)) delete check[key];
        Object.assign(check, before);
        this.data.receipts.length = receiptCount;
        return { index, success: false, error: publicError(error) };
      }
    });
  }
  applySubmission(principal, name, args) {
    validateArguments(name, args);
    authorizeEvidence(this.config, principal, args);
    if (name === "submit_quote" && this.find(principal, args.checkId).voided) throw new Error("Check is voided");
    const requestHash = digest(canonical(args));
    const receiptKey = digest(`${principal.workspace}:${principal.id}:${name}:${args.idempotencyKey}`);
    const receipt = this.data.receipts.find((item) => item.key === receiptKey);
    if (receipt) {
      if (this.find(principal, receipt.checkId).voided) throw new Error("Check is voided");
      if (receipt.hash !== requestHash) throw new Error("Idempotency conflict");
      return { ...this.view(principal, this.find(principal, receipt.checkId)), replayed: true, submissionId: receipt.submissionId };
    }
    if (this.data.receipts.length >= 5000) throw new Error("Recent receipt capacity reached");
    evidenceCheck(args.evidence, this.now());
    const at = new Date(this.now()).toISOString();
    let check, submissionId;
    if (name === "submit_lead") {
      const rawIdentity = digest(`${principal.workspace}:${args.evidence.source}:${args.evidence.reference}:${normalizeForMatchV2(args.sku)}`);
      const id = `check-${digest(`${principal.workspace}:${args.opportunityKey}`).slice(0, 24)}`;
      const sameIdentity = item => item.lead && item.lead.evidence.source === args.evidence.source && item.lead.evidence.reference === args.evidence.reference && normalizeSkuForMatchV2(item.lead.sku) === normalizeSkuForMatchV2(args.sku);
      // Preserve existing legacy identity/key. Scan at most 200 recent checks;
      // never rewrite old records merely because normalization gained aliases.
      // Equivalent submissions may have reused a different opportunityKey while
      // retaining the original physical ID. Bind current AND retained historical
      // keys before identity lookup so a new receipt cannot repurpose those keys.
      const boundChecks = this.data.checks.filter(item => item.workspace === principal.workspace && (item.id === id
        || item.opportunityKey === args.opportunityKey || item.lead?.opportunityKey === args.opportunityKey
        || (item.leadHistory || []).some(lead => lead.opportunityKey === args.opportunityKey)));
      // If old state already contains duplicate key bindings, fail closed rather
      // than trusting whichever physical record happens to be first in the list.
      if (boundChecks.some(item => item.voided)) throw new Error("Check is voided");
      if (boundChecks.some(item => item.identity && !sameIdentity(item))) throw new Error("Opportunity identity cannot change");
      check = boundChecks[0]
        || this.data.checks.find(item => item.workspace === principal.workspace && (item.identity === rawIdentity || sameIdentity(item)));
      if (check?.voided) throw new Error("Check is voided");
      if (check?.identity && !sameIdentity(check)) throw new Error("Opportunity identity cannot change");
      if (check?.lead && Date.parse(check.lead.evidence.observedAt) > Date.parse(args.evidence.observedAt)) throw new Error("Older lead cannot overwrite newer verification");
      if (check?.lead && (check.leadHistory || []).length >= 10) throw new Error("Recent lead revision capacity reached");
      const identity = check?.identity || previousNotice(this.data, { workspace: principal.workspace, identity: rawIdentity, lead: args })?.identity || rawIdentity;
      const parsed = parseLeadLine(args.text, args.evidence.source);
      const parsedPrice = parseDealV2(args.text);
      const parseWarnings = parsedPrice.price && parsedPrice.price !== args.buyPrice ? ["购买文本与结构化价格冲突"] : [];
      if (!normalizeSkuForMatchV2(args.text).includes(normalizeSkuForMatchV2(args.sku))) parseWarnings.push("购买文本未包含完整结构化 SKU");
      if (!check) {
        if (this.data.checks.length >= 200) throw new Error("Recent check capacity reached");
        check = { id, identity, workspace: principal.workspace, createdAt: at, quotes: [], notification: { status: "not_sent" } };
        this.data.checks.unshift(check);
      }
      check.identity = identity;
      check.leadHistory = [...(check.leadHistory || []), ...(check.lead ? [check.lead] : [])];
      check.parseWarnings = parseWarnings;
      check.lead = { opportunityKey: args.opportunityKey, text: args.text, sku: args.sku, buyPrice: args.buyPrice, evidence: args.evidence, conditions: args.conditions, submittedBy: principal.id, parsedLeadId: parsed?.id || null };
      submissionId = crypto.randomUUID();
    } else {
      check = this.find(principal, args.checkId);
      if (check.quotes.length >= 20) throw new Error("Recent quote capacity reached");
      const parsedLine = args.text ? parseQuoteLine(args.text, args.evidence.source) : null;
      // For an exact single-SKU line, its full decimal amount is authoritative.
      // Legacy OCR candidates must not turn 7461.5 into a matching 7461 quote.
      const exactLine = parsedLine && normalizeSkuForMatchV2(parsedLine.skuName) === normalizeSkuForMatchV2(args.sku);
      const parsed = exactLine ? [parsedLine] : args.text ? [...parseRecyclerOcrText(args.text, { fallbackSource: args.evidence.source }), parsedLine].filter(Boolean) : [];
      const singleLineAmount = args.text && !/[\r\n]/.test(args.text) ? parseDealV2(args.text).price : 0;
      const matching = parsed.filter((quote) => Number.isFinite(scoreQuoteV2(extractSkuFactsV2(args.sku), quote)) && quote.price === args.price);
      submissionId = crypto.randomUUID();
      check.quotes.push({ id: submissionId, sku: args.sku, price: args.price, text: args.text || "", evidence: args.evidence, conditions: args.conditions, submittedBy: principal.id, receivedAt: at, parseWarnings: args.text && (!matching.length || (singleLineAmount && singleLineAmount !== args.price)) ? ["报价文本无法交叉验证结构化报价"] : [] });
    }
    check.updatedAt = at;
    this.data.receipts.push({ key: receiptKey, hash: requestHash, checkId: check.id, submissionId, at: this.now() });
    return { ...this.view(principal, check), submissionId, replayed: false };
  }
  async maybeNotify(check) {
    const result = evaluate(check, policyFor(this.config, check.workspace), this.now());
    if (result.status !== "eligible") return;
    const previous = previousNotice(this.data, check);
    if (previous) { check.notification = { status: previous.status, attemptedAt: new Date(previous.at).toISOString() }; return; }
    if (!this.notify) { check.notification = { status: "not_configured" }; await this.save(); return; }
    if (this.data.notices.length >= 10000) throw new Error("Notification capacity reached");
    const notice = { identity: check.identity, canonicalIdentity: canonicalIdentity(check), at: this.now(), status: "delivery_unknown" };
    this.data.notices.push(notice);
    check.notification = { status: notice.status, attemptedAt: new Date(notice.at).toISOString() };
    await this.save(); // At-most-once: crash/timeout is ambiguous and must not auto-retry.
    if (evaluate(check, policyFor(this.config, check.workspace), this.now()).status !== "eligible") return;
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

function previewCheck(config, principal, args, now = Date.now()) {
  authorizeCall(config, principal, "preview_check", args);
  const data = { version: 1, checks: [], receipts: [], notices: [] };
  const core = new CheckCore({ config, data, now: () => now });
  const { quotes, ...lead } = args;
  const saved = core.applySubmission(principal, "submit_lead", lead);
  const items = core.applyQuotes(principal, saved.id, quotes);
  const check = core.find(principal, saved.id), policy = policyFor(config, principal.workspace);
  return { preview: true, result: evaluate(check, policy, now), items, diagnostics: {
    missingSpecs: missingSpecs(check.lead.sku),
    quotes: items.map(item => item.success
      ? { index: item.index, ...quoteDiagnostics(check.lead, check.quotes.find(quote => quote.id === item.submissionId), policy, now) }
      : { index: item.index, error: item.error })
  } };
}
module.exports = { CheckCore, defaults, evaluate, project, policyFor, previewCheck, authorizeCall, publicError, previousNotice, canonicalIdentity };
