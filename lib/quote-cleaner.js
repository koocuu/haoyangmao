const CONDITION_WORDS = [
  "全新",
  "未激活",
  "预激活",
  "当天",
  "报价",
  "行情",
  "参考价",
  "鍏ㄦ柊",
  "鏈縺娲",
  "棰勬縺娲"
];

const CATEGORY_LABELS = {
  phone: "手机",
  tablet: "平板",
  console: "主机",
  earbuds: "耳机",
  camera: "影像",
  watch: "手表",
  computer: "电脑",
  accessory: "配件",
  other: "其他"
};

const NON_DIGITAL_RE = /饮品|酒水|白酒|茅台|奶粉|尿不湿|纸巾|洗衣|护肤|面膜|口红|美妆|零食|牛奶|咖啡|茶叶|粮油|药品|保健|服饰|鞋|箱包|家具|家纺|鍗庤幈|濂跺?/i;
const PAGE_CHROME_RE = /登录|查看\s*\/\s*编辑|查看.{0,8}编辑|编辑文档|协作登录|邀请你|人正在协作|仅查看|立即登录/i;

function cleanSkuName(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\u200b-\u200f]/g, "")
    .replace(/[｜|]/g, " ")
    .replace(/[<>「」『』【】]/g, " ")
    .replace(/i\s*phone/gi, "iPhone")
    .replace(/i\s*pad/gi, "iPad")
    .replace(/air\s*pods/gi, "AirPods")
    .replace(/p\s*s\s*5/gi, "PS5")
    .replace(/n\s*s\s*2/gi, "NS2")
    .replace(/\bpr\s*o\b/gi, "Pro")
    .replace(/pro\s*max|promax|promay/gi, "ProMax")
    .replace(/uItra|u1tra/gi, "Ultra")
    .replace(/turb0|turbO/gi, "Turbo")
    .replace(/(\d)\s*(?:TB|T8|lt|lT|IT)\b/gi, "$1TB")
    .replace(/(\d)\s*(?:GB|G)\b/gi, "$1G")
    .replace(/\b2\s*56(?=\s*G\b|\b)/g, "256")
    .replace(/\b5\s*12(?=\s*G\b|\b)/g, "512")
    .replace(/\b1\s*28(?=\s*G\b|\b)/g, "128")
    .replace(/国\s*行/g, "国行")
    .replace(/港\s*版/g, "港版")
    .replace(/日\s*版/g, "日版")
    .replace(/国\s*补/g, "国补")
    .replace(/光\s*驱/g, "光驱")
    .replace(/区\s*slim/gi, "光驱 slim")
    .replace(/数\s*字/g, "数字")
    .replace(/黑\s*白/g, "黑白")
    .replace(/黑\s*臼\s*彡?\s*色/g, "黑白色")
    .replace(/白\s*彡?\s*色/g, "白色")
    .replace(/手\s*柄/g, "手柄")
    .replace(/小\s*米/g, "小米")
    .replace(/红\s*米/g, "红米")
    .replace(/一\s*加/g, "一加")
    .replace(/华\s*为/g, "华为")
    .replace(/荣\s*耀/g, "荣耀")
    .replace(/\s+/g, " ")
    .replace(/\s+([,，/:：+])/g, "$1")
    .replace(/([,，/:：+])\s+/g, "$1")
    .trim();
}

function normalizeSkuName(value) {
  let normalized = cleanSkuName(value);
  for (const word of CONDITION_WORDS) {
    normalized = normalized.replace(new RegExp(escapeRegExp(word), "gi"), " ");
  }
  return normalized
    .replace(/\b0\b/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[,，/:：\s-]+|[,，/:：\s-]+$/g, "")
    .trim();
}

function detectCategory(quote) {
  const text = `${quote.normalizedSku || ""} ${quote.skuName || ""} ${quote.rawText || ""}`.toLowerCase();
  if (/airpods|耳机|buds|wh-?1000|wf-?1000|bose|beats/i.test(text)) return "earbuds";
  if (/watch|手表|apple\s?watch|华为gt|小米手环/i.test(text)) return "watch";
  if (/iphone|苹果手机|mate\s?\d|pura|nova|redmi|红米|小米\d|xiaomi|一加|oneplus|oppo|vivo|honor|荣耀|huawei|华为|iqoo|三星|galaxy|find\s?x|magic\s?\d|k\d{2}|note\s?\d{1,2}/i.test(text)) return "phone";
  if (/ipad|平板|matepad|pad\s?\d|小米平板|mini\s?[67]\b|air\s?\d\b|pro\s?11|pro\s?13/i.test(text)) return "tablet";
  if (/ps5|playstation|switch|ns2|steam\s?deck|joy-?con|xbox|国行.*手柄|港版.*手柄/i.test(text)) return "console";
  if (/osmo|pocket|action|insta360|instax|拍立得|相机|镜头|富士|索尼|佳能|尼康|大疆|gopro|camera/i.test(text)) return "camera";
  if (/macbook|imac|电脑|笔记本|thinkpad|surface|matebook|magicbook/i.test(text)) return "computer";
  if (/手柄|鼠标|键盘|充电器|保护壳|保护套|电源|配件|pencil|keyboard|mouse/i.test(text)) return "accessory";
  return "other";
}

function isDigitalTarget(quote) {
  const text = `${quote.normalizedSku || ""} ${quote.skuName || ""} ${quote.rawText || ""}`;
  if (NON_DIGITAL_RE.test(text)) return false;
  return detectCategory(quote) !== "other";
}

function scoreQuoteQuality(quote) {
  const sku = String(quote.normalizedSku || quote.skuName || "");
  const raw = String(quote.rawText || "");
  const category = quote.category || detectCategory(quote);
  const price = Number(quote.price || 0);
  const flags = [];
  let score = Number(quote.confidence || 0) > 0 ? Math.round(Number(quote.confidence) * 100) : 82;

  if (!sku || sku.length < 3) {
    score -= 45;
    flags.push("sku-too-short");
  }
  if (sku.length > 72) {
    score -= 18;
    flags.push("sku-too-long");
  }
  const brokenCount = (sku.match(/�|锟|\?/g) || []).length;
  if (brokenCount) {
    score -= Math.min(35, brokenCount * 5);
    flags.push("ocr-broken-char");
  }
  if (/[^\x00-\x7F\u4E00-\u9FFF\s,，/:：.+*()（）-]/.test(sku)) {
    score -= 8;
    flags.push("odd-symbol");
  }
  if (category === "other") {
    score -= 55;
    flags.push("no-target-category");
  }
  if (price < 100 || price > 30000) {
    score -= 40;
    flags.push("price-out-of-range");
  } else if (!isPricePlausible(category, price)) {
    score -= 18;
    flags.push("price-unusual");
  }
  if (raw && raw.length > 130) {
    score -= 12;
    flags.push("raw-too-wide");
  }
  if (countProductMarkers(sku) > 1) {
    score -= 35;
    flags.push("multi-product");
  }
  if (PAGE_CHROME_RE.test(`${sku} ${raw}`)) {
    score -= 55;
    flags.push("page-chrome");
  }
  if ((sku.match(/(?:^|\s)0{2,3}(?=\s|$)/g) || []).length >= 2) {
    score -= 18;
    flags.push("ocr-zero-noise");
  }
  if (NON_DIGITAL_RE.test(`${sku} ${raw}`)) {
    score -= 65;
    flags.push("non-digital");
  }

  return {
    qualityScore: Math.max(0, Math.min(100, score)),
    qualityFlags: [...new Set(flags)]
  };
}

function countProductMarkers(value) {
  const text = String(value || "").toLowerCase();
  const watchMarkers = text.match(/watch\s*(?:gt\s*)?(?:runner\s*)?\d|watch\s*buds\s*\d|watch\s*d\s*\d/g) || [];
  const general = text.match(/iphone\s*\d{1,2}|ipad|airpods|ps5|ns2|switch|osmo|insta360|instax|红米|小米|redmi|oppo|vivo|honor|荣耀|华为|huawei/g) || [];
  const generalWithoutWatchBrand = watchMarkers.length
    ? general.filter((marker) => !/^(?:华为|huawei)$/.test(marker))
    : general;
  return watchMarkers.length + generalWithoutWatchBrand.length;
}

function isPricePlausible(category, price) {
  const ranges = {
    phone: [500, 20000],
    tablet: [300, 18000],
    console: [300, 12000],
    earbuds: [120, 4000],
    camera: [100, 30000],
    watch: [200, 8000],
    computer: [1000, 30000],
    accessory: [80, 8000],
    other: [100, 30000]
  };
  const [min, max] = ranges[category] || ranges.other;
  return price >= min && price <= max;
}

function enrichQuote(quote) {
  const normalizedSku = normalizeSkuName(quote?.skuName || quote?.rawText || "");
  const enriched = {
    ...quote,
    normalizedSku
  };
  enriched.category = detectCategory(enriched);
  enriched.isDigitalTarget = isDigitalTarget(enriched);
  Object.assign(enriched, scoreQuoteQuality(enriched));
  enriched.displaySku = normalizedSku || quote?.skuName || "";
  return enriched;
}

function shouldKeepQuote(quote, options = {}) {
  const enriched = quote.normalizedSku ? quote : enrichQuote(quote);
  const minScore = Number(options.minScore ?? 35);
  if (options.source === "ah" && !enriched.isDigitalTarget) return false;
  if (options.source === "ah" && enriched.qualityScore < minScore) return false;
  return true;
}

function dedupeQuoteKey(quote) {
  const enriched = quote.normalizedSku ? quote : enrichQuote(quote);
  return [
    String(enriched.sourceName || "").toLowerCase(),
    normalizeForKey(enriched.normalizedSku || enriched.skuName || ""),
    Number(enriched.price || 0)
  ].join(":");
}

function quoteIdentityKey(quote) {
  const enriched = quote.normalizedSku ? quote : enrichQuote(quote);
  return [
    String(enriched.sourceName || "").toLowerCase(),
    normalizeForKey(enriched.normalizedSku || enriched.skuName || ""),
    quoteConditionKey(enriched)
  ].join(":");
}

function quoteConditionKey(quote) {
  const text = `${quote.conditionNote || ""} ${quote.skuName || ""}`;
  if (/预\s*激\s*活/.test(text)) return "preactivated";
  if (/未\s*激\s*活/.test(text)) return "unactivated";
  if (/仅\s*激\s*活/.test(text)) return "activated-only";
  if (/拆\s*封/.test(text)) return "opened";
  return "standard";
}

function preferQuote(left, right) {
  const a = left.normalizedSku ? left : enrichQuote(left);
  const b = right.normalizedSku ? right : enrichQuote(right);
  const aRank = quotePreferenceRank(a);
  const bRank = quotePreferenceRank(b);
  if (aRank !== bRank) return aRank > bRank ? a : b;
  return new Date(a.observedAt || 0) >= new Date(b.observedAt || 0) ? a : b;
}

function quotePreferenceRank(quote) {
  const quality = Number(quote.qualityScore || 0) * 1000;
  const multiProductPenalty = (quote.qualityFlags || []).includes("multi-product") ? 10000 : 0;
  const rawLengthPenalty = Math.min(500, String(quote.rawText || "").length);
  return quality - multiProductPenalty - rawLengthPenalty;
}

function normalizeForKey(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = {
  CATEGORY_LABELS,
  cleanSkuName,
  dedupeQuoteKey,
  detectCategory,
  enrichQuote,
  isDigitalTarget,
  normalizeSkuName,
  preferQuote,
  quoteIdentityKey,
  shouldKeepQuote
};
