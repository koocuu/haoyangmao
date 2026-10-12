"use strict";
const assert = require("assert/strict");

// Runs against a separate cloud-handler process and the existing mock private
// Blob backend. All conditions, amounts and references below are test fixtures.
module.exports = async function run({ call, value, url, lead, quote, evidence, conditions, now }) {
  const sku = "华为 nova 15 Pro 12+256 国行 黑色 全新未激活";
  const purchase = () => conditions(["finalPrice", "eligibility", "stock", "purchaseRules"]);
  const makeLead = (key, overrides = {}) => lead(key, { sku, buyPrice: 1964, text: `${sku} 券后1964`, evidence: evidence("微信群", `fixture-only:${key}; original https://example.invalid/xhs-fixture`), ...overrides });
  const makeQuote = (id, key, overrides = {}) => quote(id, key, { sku, price: 2320, text: `${sku} 回收2320`, evidence: evidence("AH", `fixture-only:${key}`), ...overrides });

  for (const source of ["什么值得买", "小红书", "微信群"]) {
    const key = `source-${source}`;
    const saved = value(await call(url, "submit_lead", makeLead(key, { evidence: evidence(source, `fixture-only:${key}`) })));
    assert.equal(saved.lead.evidence.source, source); assert.equal(saved.result.status, "pending_confirmation");
  }

  for (const source of ["踏浪", "小鸽"]) {
    const record = value(await call(url, "submit_lead", makeLead(`miniapp-${source}`)));
    const saved = value(await call(url, "submit_quote", makeQuote(record.id, `miniapp-quote-${source}`, { evidence: evidence(source, `fixture-only:direct-miniapp:${source}`) })));
    assert.equal(saved.quotes[0].evidence.source, source);
    assert.deepEqual(saved.quotes[0].parseWarnings, []);
    assert.equal(saved.result.status, "eligible");
    assert.equal(saved.notification.status, "not_configured");
  }

  const unverified = makeLead("nova-unknown-conditions");
  unverified.conditions.eligibility = { status: "unknown", detail: "仅测试：国补资格尚未核实" };
  unverified.conditions.stock = { status: "unknown", detail: "仅测试：库存尚未核实" };
  const pending = value(await call(url, "submit_lead", unverified));
  let result = value(await call(url, "submit_quote", makeQuote(pending.id, "nova-initial-quote")));
  assert.equal(result.result.status, "pending_confirmation");
  assert.ok(result.result.reasons.includes("purchase.eligibility")); assert.ok(result.result.reasons.includes("purchase.stock"));
  assert.deepEqual(result.parseWarnings, []); assert.deepEqual(result.quotes[0].parseWarnings, []);
  const complete = { ...unverified, idempotencyKey: "nova-conditions-verified", conditions: purchase() };
  assert.equal((await call(url, "submit_lead", { ...complete, idempotencyKey: unverified.idempotencyKey })).body.result.isError, true);
  result = value(await call(url, "submit_lead", complete));
  assert.equal(result.id, pending.id); assert.equal(result.result.status, "eligible"); assert.equal(result.result.netProfit, 306);
  assert.equal(result.notification.status, "not_configured");
  assert.equal(value(await call(url, "submit_lead", complete)).replayed, true);

  const variants = [
    sku.replace("15 Pro", "15"), sku.replace("12+256", "16+256"), sku.replace("256", "512"),
    sku.replace("黑色", "白色"), sku.replace("国行", "港版"), sku.replace("未激活", "已激活")
  ];
  for (let index = 0; index < variants.length; index++) {
    const record = value(await call(url, "submit_lead", makeLead(`variant-lead-${index}`)));
    const variant = variants[index];
    const checked = value(await call(url, "submit_quote", makeQuote(record.id, `variant-quote-${index}`, { sku: variant, text: `${variant} 回收2320` })));
    assert.equal(checked.result.status, "pending_confirmation"); assert.equal(checked.result.quoteId, null); assert.equal(checked.result.netProfit, null);
  }
  const baseSku = sku.replace("15 Pro", "15");
  const base = value(await call(url, "submit_lead", makeLead("nova-base-model", { sku: baseSku, text: `${baseSku} 券后1964` })));
  assert.equal(value(await call(url, "submit_quote", makeQuote(base.id, "nova-base-model-q", { sku: baseSku, text: `${baseSku} 回收2320` }))).result.status, "eligible");

  const incomplete = [
    sku.replace("12+256", "256G"), sku.replace("12+256", "12G"), sku.replace(" 黑色", ""),
    sku.replace("黑色", "黑色 白色"), sku.replace(" 国行", ""), sku.replace("未激活", ""),
    sku.replace("全新", ""), "华为 nova 15 Pro 12+256GB 黑色 国行 全新 激活状态未知",
    sku.replace("15 Pro", "16 Pro"), sku.replace("15 Pro", "15 Pro Ultra"), sku.replace("12+256", "12+2560")
  ];
  for (let index = 0; index < incomplete.length; index++) {
    const candidate = incomplete[index];
    const record = value(await call(url, "submit_lead", makeLead(`incomplete-${index}`, { sku: candidate, text: `${candidate} 券后1964` })));
    const checked = value(await call(url, "submit_quote", makeQuote(record.id, `incomplete-q-${index}`, { sku: candidate, text: `${candidate} 回收2320` })));
    assert.equal(checked.result.status, "pending_confirmation", candidate);
    assert.ok(checked.result.reasons.includes("SKU 规格不完整或暂不支持自动核实"), candidate);
  }
  const partial = value(await call(url, "submit_lead", makeLead("partial-identity", { sku: "华为 nova 15 Pro 12+256", text: "华为 nova 15 Pro 12+256 券后1964" })));
  const attemptedChange = makeLead("partial-new-receipt", { opportunityKey: "partial-identity", evidence: partial.lead.evidence });
  assert.equal((await call(url, "submit_lead", attemptedChange)).body.result.isError, true, "completing SKU cannot mutate the existing opportunity identity");

  // Real parseWarnings path: decimal text agrees with decimal structured price,
  // and the truncated integer MUST instead remain a conflict/pending result.
  const iphone = "Apple iPhone 17 Pro 256GB 银色 国行 全新未激活";
  const decimalLead = (key, overrides = {}) => lead(key, { sku: iphone, buyPrice: 7461.5, text: `${iphone} 实付7461.5`, ...overrides });
  const decimal = value(await call(url, "submit_lead", decimalLead("decimal-agreement")));
  assert.deepEqual(decimal.parseWarnings, []);
  const truncatedArgs = decimalLead("decimal-truncation", { buyPrice: 7461 });
  const truncated = value(await call(url, "submit_lead", truncatedArgs));
  assert.deepEqual(truncated.parseWarnings, ["购买文本与结构化价格冲突"]);
  const iphoneQuote = (id, key, overrides = {}) => quote(id, key, { sku: iphone, price: 7720, text: `${iphone} 回收7720`, ...overrides });
  assert.equal(value(await call(url, "submit_quote", iphoneQuote(truncated.id, "truncated-buy-q"))).result.status, "pending_confirmation");
  assert.equal((await call(url, "submit_lead", { ...truncatedArgs, buyPrice: 7461.5 })).body.result.isError, true);
  const corrected = value(await call(url, "submit_lead", { ...truncatedArgs, idempotencyKey: "decimal-corrected", buyPrice: 7461.5 }));
  assert.deepEqual(corrected.parseWarnings, []); assert.equal(corrected.result.status, "eligible"); assert.equal(corrected.result.netProfit, 208.5);
  const fractionalQuote = value(await call(url, "submit_quote", iphoneQuote(decimal.id, "decimal-exit-price", { price: 7720.5, text: `${iphone} 回收7720.50` })));
  assert.deepEqual(fractionalQuote.quotes[0].parseWarnings, []); assert.equal(fractionalQuote.result.status, "eligible"); assert.equal(fractionalQuote.result.netProfit, 209);
  const quoteConflict = value(await call(url, "submit_lead", decimalLead("decimal-quote-conflict")));
  const mismatched = value(await call(url, "submit_quote", iphoneQuote(quoteConflict.id, "decimal-quote-conflict-q", { price: 7720, text: `${iphone} 回收7720.5` })));
  assert.deepEqual(mismatched.quotes[0].parseWarnings, ["报价文本无法交叉验证结构化报价"]); assert.equal(mismatched.result.quoteId, null); assert.equal(mismatched.result.status, "pending_confirmation");
  const missingApple = value(await call(url, "submit_lead", decimalLead("missing-full-sku", { text: `${iphone.replace("Apple ", "")} 实付7461.5` })));
  assert.deepEqual(missingApple.parseWarnings, ["购买文本未包含完整结构化 SKU"], "missing brand prefix is separate from amount parsing");

  // Source activity end cannot replace observedAt + server policy TTL.
  const day = 86400000;
  const timed = makeLead("long-source-expiry", { evidence: { ...evidence("小红书", "fixture-only:long-expiry"), validUntil: new Date(now + day).toISOString() } });
  const timedLead = value(await call(url, "submit_lead", timed));
  assert.equal(timedLead.result.validUntil, new Date(now + 60 * 60000).toISOString());
  const timedQuote = value(await call(url, "submit_quote", makeQuote(timedLead.id, "long-source-expiry-q", { evidence: { ...evidence("AH", "fixture-only:long-expiry-q"), validUntil: new Date(now + day).toISOString() } })));
  assert.equal(timedQuote.result.validUntil, new Date(now + 30 * 60000).toISOString());
  const short = value(await call(url, "submit_quote", makeQuote(timedLead.id, "short-source-expiry-q", { evidence: { ...evidence("AH", "fixture-only:short-expiry"), validUntil: new Date(now + 5 * 60000).toISOString() } })));
  assert.equal(short.result.validUntil, new Date(now + 5 * 60000).toISOString());
  const oldLead = value(await call(url, "submit_lead", makeLead("old-observed-lead", { evidence: { ...evidence("什么值得买", "fixture-only:old-observed", 61), validUntil: new Date(now + day).toISOString() } })));
  const oldResult = value(await call(url, "submit_quote", makeQuote(oldLead.id, "old-observed-lead-q")));
  assert.equal(oldResult.result.status, "pending_confirmation"); assert.ok(oldResult.result.reasons.includes("购买线索过期"));
  console.log("cloud business regressions ok: 3 evidence sources/Huawei exact models and variants/complete vs unknown specs/subsidy-stock pending/306 only eligible after mock verification/decimal parseWarnings/full SKU/identity/TTL; no real submissions or notifications");
};
