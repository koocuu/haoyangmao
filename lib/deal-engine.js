(function (root) {
"use strict";
function parseDealV2(rawText) {
  const text = String(rawText || "").normalize("NFKC");
  // Consume the complete monetary token, including decimals/grouping. Never
  // accept the integer prefix or a fractional tail as a separate amount.
  const amount = "(?<![\\d.,])(\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?)(?![\\d.,])";
  const numeric = (value) => Number(value.replace(/,/g, ""));
  const explicitPatterns = [
    new RegExp(`(?:券后|到手|实付|成交|最终(?:价|价格)?|价格|售价|购入价?|买入价?)[^\\d]{0,8}[¥￥]?\\s*${amount}`, "gi"),
    new RegExp(`[¥￥]\\s*${amount}`, "g")
  ];

  for (const pattern of explicitPatterns) {
    const matches = [...text.matchAll(pattern)]
      .map((match) => numeric(match[1]))
      .filter(isPlausibleDealPriceV2);
    if (matches.length) return { price: matches[matches.length - 1], explicit: true };
  }

  const candidates = [...text.matchAll(new RegExp(`\\b${amount}\\b`, "g"))]
    .filter((match) => isPlausibleDealPriceV2(numeric(match[1])) && !isLikelySpecNumberV2(text, match))
    .map((match) => numeric(match[1]));
  return { price: candidates.length ? candidates[candidates.length - 1] : 0, explicit: false };
}

function scoreQuoteV2(dealFacts, quote) {
  const same = normalizeSkuForMatchV2(quote.normalizedSku) === normalizeSkuForMatchV2(quote.skuName);
  const quoteFacts = extractSkuFactsV2(same || !quote.normalizedSku ? quote.skuName : !quote.skuName ? quote.normalizedSku : `${quote.normalizedSku} ${quote.skuName}`);
  if (dealFacts.brandConflict || quoteFacts.brandConflict) return -Infinity;
  if (!dealFacts.family || !quoteFacts.family || dealFacts.family !== quoteFacts.family) return -Infinity;
  if (dealFacts.model && quoteFacts.model && dealFacts.model !== quoteFacts.model) return -Infinity;
  if (dealFacts.model && !quoteFacts.model) return -Infinity;
  if (dealFacts.ram && (!quoteFacts.ram || dealFacts.ram !== quoteFacts.ram)) return -Infinity;
  if (dealFacts.storage && (!quoteFacts.storage || dealFacts.storage !== quoteFacts.storage)) return -Infinity;
  if (dealFacts.colors.length && !dealFacts.colors.some((color) => quoteFacts.colors.includes(color))) return -Infinity;
  if (dealFacts.region && dealFacts.region !== quoteFacts.region) return -Infinity;
  if (dealFacts.activation && dealFacts.activation !== quoteFacts.activation) return -Infinity;
  if (dealFacts.condition && dealFacts.condition !== quoteFacts.condition) return -Infinity;
  for (const key of ["chip", "unifiedMemory", "screenSize"]) if (dealFacts[key] && dealFacts[key] !== quoteFacts[key]) return -Infinity;

  let score = 20;
  if (dealFacts.model && dealFacts.model === quoteFacts.model) score += 40;
  if (dealFacts.ram && dealFacts.ram === quoteFacts.ram) score += 15;
  if (dealFacts.storage && dealFacts.storage === quoteFacts.storage) score += 15;
  if (dealFacts.colors.length) score += 8;
  if (dealFacts.region) score += 8;
  if (dealFacts.activation) score += 8;
  return score;
}

function isPlausibleDealPriceV2(value) {
  return Number(value) >= 100 && Number(value) <= 30000;
}

function isLikelySpecNumberV2(text, match) {
  const value = String(match[1]);
  const index = match.index || 0;
  const before = text.slice(Math.max(0, index - 8), index);
  const after = text.slice(index + value.length, index + value.length + 8);
  if (/\+\s*$/.test(before) || /^\s*(?:G|GB|TB)\b/i.test(after)) return true;
  if (["128", "256", "512", "1024"].includes(value)) return true;
  if (/[-/.年]\s*$/.test(before) || /^\s*[-/.月日]/.test(after)) return true;
  if (/^\s*款/.test(after) && Number(value) >= 2000 && Number(value) <= 2099) return true;
  return false;
}

function extractSkuFactsV2(value) {
  const compact = normalizeSkuForMatchV2(value);
  const original = String(value || "").normalize("NFKC").trim();
  const pairs = [...original.matchAll(/(?<!\d)([1-9]\d?)\s*\+\s*(?:(64|128|256|512|1024|2048)(?:gb|g)?|([12](?:\.0)?)t(?:b)?)(?!\d)/gi)];
  // Enriched quotes repeat normalizedSku/skuName. Only DIFFERENT pairs are ambiguous.
  const distinctPairs = new Map(pairs.map(match => [`${match[1]}:${match[2] ? `${match[2]}gb` : `${Number(match[3])}tb`}`, match]));
  const pair = distinctPairs.size === 1 ? distinctPairs.values().next().value : null;
  // Keep the model/storage separator: compacting "iPhone 16 256G" produces "16256g".
  const storageMatches = [...original.matchAll(/(?<!\d)(?:(64|128|256|512|1024|2048)(?:gb|g)|([12](?:\.\d+)?)t(?:b)?)\b/gi)];
  const storageValues = new Set([
    ...storageMatches.map(match => match[1] ? `${match[1]}gb` : `${Number(match[2])}tb`),
    ...pairs.map(match => match[2] ? `${match[2]}gb` : `${Number(match[3])}tb`)
  ]);
  const facts = {
    family: detectProductFamilyV2(compact),
    model: "",
    ram: pair ? pair[1] : "",
    storage: storageValues.size === 1 ? [...storageValues][0] : "",
    colors: extractColorsV2(compact),
    region: extractRegionV2(compact),
    activation: extractActivationV2(compact),
    condition: extractConditionV2(compact)
  };
  const modelText = compact.replace(/\d{1,2}\+(?:(?:64|128|256|512|1024|2048)(?:g|gb)?|\d+(?:\.\d+)?t(?:b)?)/gi, "");
  const modelPatterns = {
    iphone: /iphone(\d{1,2}(?:promax|pro|air|e)?)/,
    ipad: /ipad((?:mini|air|pro)?\d*)/,
    redmi: /(?:红米|redmi)((?:turbo|note|k|mix)?\d+(?:proplus|promax|pro|max|ultra)?)/,
    xiaomi: /(?:小米|xiaomi)((?:mix|civi)?\d+(?:promax|pro|max|ultra)?)/,
    ps5: /(ps5(?:pro|slim)?)/,
    switch: /(ns2|switch(?:oled|lite)?)/,
    airpods: /(airpods(?:pro)?\d*)/,
    osmo: /(osmo(?:pocket|action)?\d+(?:pro)?)/,
    insta360: /(insta360[a-z]*\d*[a-z]*)/
  };
  const pattern = modelPatterns[facts.family];
  const modelMatch = pattern ? modelText.match(pattern) : null;
  facts.model = modelMatch ? `${facts.family}:${modelMatch[1] || modelMatch[0]}` : "";
  if (facts.family === "iphone" && /iphone1\dpm/.test(compact)) facts.model = ""; // unresolved PM suffix is not a base iPhone
  if (facts.family === "huawei") {
    // Incremental allowlist: nova 15 / nova 15 Pro only. Require an explicit
    // model-to-spec boundary; Plus/Ultra/Pro Max/new generations stay unknown.
    const nova = original.match(/^(?:华为|huawei)\s*(nova\s*15(?:\s*pro)?)(?=\s+(?:[1-9]\d?\s*\+|(?:64|128|256|512|1024|2048)\s*(?:gb|g)\b|[12]tb\b|国行|港版|日版|美版|海外版|外版|黑色|白色|蓝色|绿色|紫色|橙色|金色|银色|红色|粉色|灰色|全新|未拆|未激活|已激活|预激活|二手)|$)/i);
    facts.model = nova ? `huawei:${nova[1].toLowerCase().replace(/\s+/g, "")}` : "";
  }
  extendExplicitModelsV2(facts, original);
  const families = detectedFamiliesV2(compact);
  if (families.length > 1) facts.brandConflict = true;
  // Explicit uncertainty always wins over another apparently complete token.
  // This applies to legacy products too, without changing their identity keys.
  if (/unknown|未知|不明|不详|不确定|待确认|待核实|未确认/i.test(original)) {
    facts.unknownSpecs = true;
    const fields = [["ram", "ram|内存"], ["storage", "容量|存储|ssd|硬盘"], ["colors", "颜色|配色"], ["region", "地区|版本"], ["activation", "激活(?:状态|情况)?"], ["condition", "成色"], ["chip", "芯片|chip"], ["unifiedMemory", "统一内存"]];
    for (const [key, label] of fields) {
      if (new RegExp(`(?:${label})(?:unknown|未知|不明|不详|不确定|待确认|待核实|未确认)`, "i").test(compact)) facts[key] = key === "colors" ? [] : "";
    }
    if (/(?:品牌|brand)(?:unknown|未知|不明|不详|不确定|待确认|待核实|未确认)/i.test(compact)) facts.family = "";
  }
  return facts;
}

// A small explicit model allowlist, not a guessed generation/suffix catalogue.
// Other models in an authorized family can be submitted, but remain pending.
const explicitModelsV2 = {
  oppo: /^(?:oppo)\s*(find\s*x8|reno\s*14)/i,
  oneplus: /^(?:一加|oneplus)\s*(ace\s*5)/i,
  vivo: /^(?:vivo\s*)?(iqoo\s*13)|^vivo\s*(x200)/i,
  samsung: /^(?:三星|samsung)\s*(galaxy\s*(?:s25|z\s*fold\s*6|z\s*flip\s*6|a56))/i,
  honor: /^(?:荣耀|honor)\s*(magic\s*7)/i,
  realme: /^(?:真我|realme)\s*(gt\s*7)/i,
  xiaomi: /^(?:小米|xiaomi)\s*((?:平板|pad)\s*7)/i,
  // Preserve explicit legacy numeric iPad/Air/Pro/mini names; don't let a
  // prefix-only match turn an unknown suffix into that older model.
  ipad: /^(?:apple\s*|苹果\s*)?ipad\s*((?:pro|air)\s*m[1-4]|(?:mini|air|pro)\s*\d{1,2}(?:\.\d)?|\d{1,2})/i,
  mac: /^(?:apple\s*|苹果\s*)?(mac\s*mini|macbook\s*air|macbook\s*pro)/i
};
function uniqueValueV2(values) {
  const distinct = [...new Set(values)];
  return distinct.length === 1 ? distinct[0] : "";
}
function extendExplicitModelsV2(facts, original) {
  const isTablet = facts.family === "xiaomi" && /(?:小米|xiaomi)\s*(?:平板|pad)/i.test(original);
  const pattern = facts.family === "xiaomi" && !isTablet ? null : explicitModelsV2[facts.family];
  if (!pattern) return;
  const model = original.match(pattern);
  facts.model = "";
  if (!model || (original.slice(model[0].length) && !/^\s/.test(original.slice(model[0].length)))) return;
  facts.model = `${facts.family}:${(model[1] || model[2]).toLowerCase().replace(/\s/g, "")}`;
  let rest = original.slice(model[0].length);
  if (["mac", "ipad"].includes(facts.family)) {
    facts.screenSize = uniqueValueV2([...rest.matchAll(/(?<!\d)(\d{1,2}(?:\.\d)?)\s*(?:英寸|寸|inch(?:es)?|in\b)/gi)].map(m => m[1]));
  }
  if (facts.family === "mac") {
    facts.chip = uniqueValueV2([...rest.matchAll(/(?:^|\s)(m[1-4](?:\s*(?:pro|max|ultra))?)(?=\s|$)/gi)].map(m => m[1].toLowerCase().replace(/\s/g, "")));
    facts.unifiedMemory = uniqueValueV2([...rest.matchAll(/(?:统一内存\s*(\d{1,3})\s*(?:gb|g)\b|(\d{1,3})\s*(?:gb|g)\s*统一内存)/gi)].map(m => m[1] || m[2]));
    facts.ram = facts.unifiedMemory;
    // Only explicitly labelled SSD/storage is disk capacity. 64/128GB memory
    // must never become a disk or a plausible substitute for missing storage.
    const diskText = rest.replace(/统一内存\s*\d{1,3}\s*(?:gb|g)\b|\d{1,3}\s*(?:gb|g)\s*统一内存/gi, " ");
    facts.storage = uniqueValueV2([...diskText.matchAll(/(?:ssd|存储|硬盘)\s*(\d{2,4}|[1-8])\s*(gb|g|tb|t)\b|(\d{2,4}|[1-8])\s*(gb|g|tb|t)\s*(?:ssd|存储|硬盘)/gi)].map(m => `${Number(m[1] || m[3])}${/t/i.test(m[2] || m[4]) ? "tb" : "gb"}`));
    const chips = { "mac:macmini": ["m1", "m2", "m2pro", "m4", "m4pro"], "mac:macbookair": ["m1", "m2", "m3", "m4"], "mac:macbookpro": ["m1pro", "m1max", "m2", "m2pro", "m2max", "m3", "m3pro", "m3max", "m4", "m4pro", "m4max"] };
    if (!chips[facts.model].includes(facts.chip)) facts.chip = "";
    if (/统一内存\s*(?:unknown|未知|待确认)/i.test(rest)) facts.unifiedMemory = facts.ram = "";
    if (/(?:芯片|chip)\s*(?:unknown|未知|待确认)/i.test(rest)) facts.chip = "";
    if (/(?:ssd|存储|硬盘)\s*(?:unknown|未知|待确认)/i.test(rest)) facts.storage = "";
    rest = rest.replace(/(?:^|\s)m[1-4](?:\s*(?:pro|max|ultra))?(?=\s|$)/gi, " ")
      .replace(/统一内存\s*\d{1,3}\s*(?:gb|g)\b|\d{1,3}\s*(?:gb|g)\s*统一内存/gi, " ")
      .replace(/(?:ssd|存储|硬盘)\s*(?:\d{2,4}|[1-8])\s*(?:gb|g|tb|t)\b|(?:\d{2,4}|[1-8])\s*(?:gb|g|tb|t)\s*(?:ssd|存储|硬盘)/gi, " ");
  }
  // Unknown suffixes and unparsed variants are retained as diagnostics, not
  // silently interpreted as the base model. Exact full-SKU matching stays on.
  rest = rest.replace(/\d{1,2}\s*\+\s*(?:\d{2,4}\s*(?:gb|g)?|[12]\s*tb)\b/gi, " ")
    .replace(/\d{1,2}(?:\.\d)?\s*(?:英寸|寸|inch(?:es)?|in\b)/gi, " ")
    .replace(/\d{2,4}\s*(?:gb|g)\b|[12]\s*tb\b/gi, " ")
    .replace(/国行|港版|日版|美版|海外版|外版|全新|未拆|二手|使用过|未激活|已激活|预激活/gi, " ")
    .replace(/星宇橙|深蓝色?|银色?|勃艮第酒红|冰川蓝|cosmic\s*orange|deep\s*blue|silver|burgundy|glacier\s*blue|(?:黑|白|蓝|绿|紫|橙|金|红|粉|灰)色|black|white|blue|green|purple|orange|gold|red|pink|gray|grey/gi, " ")
    .replace(/[\s,，()（）-]/g, "");
  if (rest) facts.unsupportedVariant = true;
}

function extractColorsV2(compact) {
  let text = compact.replace(/\u7ea2\u7c73|redmi/g, "");
  const colors = [];
  // Specific named finishes remain distinct from generic blue/red/orange.
  for (const [name, token] of [["cosmic_orange", "星宇橙"], ["deep_blue", "深蓝"], ["burgundy", "勃艮第酒红"], ["glacier_blue", "冰川蓝"]]) {
    if (text.includes(token)) { colors.push(name); text = text.replaceAll(token, ""); }
  }
  const patterns = [
    ["black", /\u9ed1|black/],
    ["white", /\u767d|white/],
    ["blue", /\u84dd|blue/],
    ["green", /\u7eff|green/],
    ["purple", /\u7d2b|purple/],
    ["orange", /\u6a59|orange/],
    ["gold", /\u91d1\u8272|gold/],
    ["silver", /\u94f6|silver/],
    ["red", /\u7ea2\u8272|red/],
    ["pink", /\u7c89|pink/],
    ["gray", /\u7070|gray|grey/]
  ];
  for (const [name, pattern] of patterns) if (pattern.test(text)) colors.push(name);
  return colors;
}

function extractRegionV2(compact) {
  const regions = [["cn", /国行/], ["hk", /港版/], ["jp", /日版/], ["us", /美版/], ["overseas", /海外版|外版/]].filter(([, pattern]) => pattern.test(compact));
  return regions.length === 1 ? regions[0][0] : "";
}

function extractActivationV2(compact) {
  if (/激活(?:状态|情况)?(?:未知|不明|不详|不确定|待确认|待核实|未确认)|(?:未知|不明|不详|不确定|待确认|待核实|未确认)(?:是否)?激活/.test(compact)) return "";
  const states = [["inactive", /\u672a\u6fc0\u6d3b/], ["preactivated", /\u9884\u6fc0\u6d3b/], ["activated", /\u5df2\u6fc0\u6d3b/]].filter(([, pattern]) => pattern.test(compact));
  return states.length === 1 ? states[0][0] : "";
}

function extractConditionV2(compact) {
  const conditions = [["used", /二手|使用过/], ["new", /全新|未拆/]].filter(([, pattern]) => pattern.test(compact));
  return conditions.length === 1 ? conditions[0][0] : "";
}

function detectProductFamilyV2(compact) {
  compact = compact.replace(/xiaomipad/g, "xiaomi平板");
  if (/iphone/.test(compact)) return "iphone";
  if (/ipad/.test(compact)) return "ipad";
  if (/红米|redmi/.test(compact)) return "redmi";
  if (/小米|xiaomi/.test(compact)) return "xiaomi";
  if (/ps5|playstation5/.test(compact)) return "ps5";
  if (/ns2|switch/.test(compact)) return "switch";
  if (/airpods/.test(compact)) return "airpods";
  if (/osmo/.test(compact)) return "osmo";
  if (/insta360/.test(compact)) return "insta360";
  if (/一加|oneplus/.test(compact)) return "oneplus";
  if (/华为|huawei/.test(compact)) return "huawei";
  if (/荣耀|honor/.test(compact)) return "honor";
  if (/oppo/.test(compact)) return "oppo";
  if (/vivo|iqoo/.test(compact)) return "vivo";
  if (/三星|samsung/.test(compact)) return "samsung";
  if (/真我|realme/.test(compact)) return "realme";
  if (/macbook|macmini/.test(compact)) return "mac";
  return "";
}

function detectedFamiliesV2(compact) {
  compact = compact.replace(/xiaomipad/g, "xiaomi平板");
  const patterns = [["iphone", /iphone/], ["ipad", /ipad/], ["redmi", /红米|redmi/], ["xiaomi", /小米|xiaomi/], ["ps5", /ps5|playstation5/], ["switch", /ns2|switch/], ["airpods", /airpods/], ["osmo", /osmo/], ["insta360", /insta360/], ["oneplus", /一加|oneplus/], ["huawei", /华为|huawei/], ["honor", /荣耀|honor/], ["oppo", /oppo/], ["vivo", /vivo|iqoo/], ["samsung", /三星|samsung/], ["realme", /真我|realme/], ["mac", /macbook|macmini/]];
  return patterns.filter(([, pattern]) => pattern.test(compact)).map(([family]) => family);
}

function normalizeForMatchV2(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[^\p{L}\p{N}+]/gu, "");
}

const skuAliases = [
  ["星宇橙", ["星宇橙", "cosmicorange"]],
  ["深蓝", ["深蓝色", "深蓝", "deepblue"]],
  ["银色", ["银色", "silver", "银"]],
  ["勃艮第酒红", ["勃艮第酒红", "burgundy"]],
  ["冰川蓝", ["冰川蓝", "glacierblue"]]
];
function normalizeSkuForMatchV2(value) {
  let text = normalizeForMatchV2(value);
  // PM is a model alias ONLY after an explicitly supported iPhone generation
  // and before a specification boundary, never an arbitrary English token.
  text = text.replace(/iphone(1\d)pm(?=(?:64|128|256|512|1024|2048)(?:gb|g)|[12]tb|国行|港版|日版|美版|海外版|外版|星宇橙|深蓝|银|冰川蓝|勃艮第酒红|cosmicorange|deepblue|silver|glacierblue|burgundy|全新|未拆|未激活|已激活|预激活|$)/g, "iphone$1promax");
  for (const [canonical, aliases] of skuAliases) {
    // Replace each disjoint vocabulary once; do not erase unknown SKU fields.
    text = text.replace(new RegExp(aliases.join("|"), "g"), canonical);
  }
  return text;
}
function legacySkuVariantsV2(value) {
  let variants = [normalizeSkuForMatchV2(value)];
  for (const [canonical, aliases] of skuAliases) {
    variants = [...new Set(variants.flatMap(text => text.includes(canonical) ? aliases.map(alias => text.replaceAll(canonical, alias)) : [text]))].slice(0, 256);
  }
  variants = [...new Set(variants.flatMap(text => /iphone1\dpromax/.test(text) ? [text, text.replace(/(iphone1\d)promax/g, "$1pm")] : [text]))].slice(0, 256);
  return [...new Set([normalizeForMatchV2(value), ...variants])];
}

function calculateNetProfit(sellPrice, buyPrice, costs) {
  return (Math.round(sellPrice * 100) - Math.round(buyPrice * 100)
    - Math.round(costs.shippingCost * 100) - Math.round(costs.platformCost * 100)
    - Math.round(costs.riskBuffer * 100)) / 100;
}

const engine = { parseDealV2, scoreQuoteV2, extractSkuFactsV2, normalizeForMatchV2, normalizeSkuForMatchV2, legacySkuVariantsV2, calculateNetProfit };
if (typeof module === "object" && module.exports) module.exports = engine;
else root.HymDealEngine = engine;
})(typeof globalThis !== "undefined" ? globalThis : this);
