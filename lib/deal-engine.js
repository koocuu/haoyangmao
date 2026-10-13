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
  const quoteFacts = extractSkuFactsV2(`${quote.normalizedSku || ""} ${quote.skuName || ""}`);
  if (!dealFacts.family || !quoteFacts.family || dealFacts.family !== quoteFacts.family) return -Infinity;
  if (dealFacts.model && quoteFacts.model && dealFacts.model !== quoteFacts.model) return -Infinity;
  if (dealFacts.model && !quoteFacts.model) return -Infinity;
  if (dealFacts.ram && (!quoteFacts.ram || dealFacts.ram !== quoteFacts.ram)) return -Infinity;
  if (dealFacts.storage && (!quoteFacts.storage || dealFacts.storage !== quoteFacts.storage)) return -Infinity;
  if (dealFacts.colors.length && !dealFacts.colors.some((color) => quoteFacts.colors.includes(color))) return -Infinity;
  if (dealFacts.region && dealFacts.region !== quoteFacts.region) return -Infinity;
  if (dealFacts.activation && dealFacts.activation !== quoteFacts.activation) return -Infinity;
  if (dealFacts.condition && dealFacts.condition !== quoteFacts.condition) return -Infinity;

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
  const storageMatch = String(value || "").normalize("NFKC").match(/(?:^|[^\d])(?:(64|128|256|512|1024|2048)(?:gb|g)|([12](?:\.\d+)?)t(?:b)?)\b/i);
  const facts = {
    family: detectProductFamilyV2(compact),
    model: "",
    ram: pair ? pair[1] : "",
    storage: pair
      ? pair[2] ? `${pair[2]}gb` : `${pair[3]}tb`
      : storageMatch ? storageMatch[1] ? `${storageMatch[1]}gb` : `${storageMatch[2]}tb` : "",
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
  return facts;
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
  if (/\u56fd\u884c/.test(compact)) return "cn";
  if (/\u6e2f\u7248/.test(compact)) return "hk";
  if (/\u65e5\u7248/.test(compact)) return "jp";
  if (/\u7f8e\u7248/.test(compact)) return "us";
  if (/\u6d77\u5916\u7248|\u5916\u7248/.test(compact)) return "overseas";
  return "";
}

function extractActivationV2(compact) {
  if (/激活(?:状态|情况)?(?:未知|不明|不详|不确定|待确认|待核实|未确认)|(?:未知|不明|不详|不确定|待确认|待核实|未确认)(?:是否)?激活/.test(compact)) return "";
  const states = [["inactive", /\u672a\u6fc0\u6d3b/], ["preactivated", /\u9884\u6fc0\u6d3b/], ["activated", /\u5df2\u6fc0\u6d3b/]].filter(([, pattern]) => pattern.test(compact));
  return states.length === 1 ? states[0][0] : "";
}

function extractConditionV2(compact) {
  if (/\u4e8c\u624b|\u4f7f\u7528\u8fc7/.test(compact)) return "used";
  if (/\u5168\u65b0|\u672a\u62c6/.test(compact)) return "new";
  return "";
}

function detectProductFamilyV2(compact) {
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
  if (/vivo/.test(compact)) return "vivo";
  return "";
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
