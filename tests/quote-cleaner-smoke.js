const assert = require("assert");
const {
  cleanSkuName,
  dedupeQuoteKey,
  detectCategory,
  enrichQuote,
  normalizeSkuName,
  preferQuote,
  quoteIdentityKey,
  shouldKeepQuote
} = require("../lib/quote-cleaner");

assert.strictEqual(cleanSkuName("i Phone 17 Pro Max 2 56 G 国 行"), "iPhone 17 ProMax 256G 国行");
assert.strictEqual(cleanSkuName("P S 5 港 版 光 驱 slim"), "PS5 港版 光驱 slim");
assert.strictEqual(normalizeSkuName("AirPods Pro2 全新 报价"), "AirPods Pro2");

const phone = enrichQuote({
  skuName: "i Phone 17 Pro Max 256G 全新",
  sourceName: "AH OCR",
  price: 8900,
  confidence: 0.74
});
assert.strictEqual(phone.category, "phone");
assert.ok(phone.isDigitalTarget);
assert.ok(phone.qualityScore >= 70);

const consoleQuote = enrichQuote({
  skuName: "P S 5 港 版 光 驱 slim 全新",
  sourceName: "AH OCR",
  price: 3450
});
assert.strictEqual(detectCategory(consoleQuote), "console");
assert.ok(shouldKeepQuote(consoleQuote, { source: "ah" }));

const junk = enrichQuote({
  skuName: "茅台 53 度 500ml",
  sourceName: "AH OCR",
  price: 2100
});
assert.strictEqual(junk.isDigitalTarget, false);
assert.strictEqual(shouldKeepQuote(junk, { source: "ah" }), false);

const dirty = enrichQuote({
  skuName: "PS5 鍥? 琛? 鎵? 柄 黑 白",
  sourceName: "AH OCR",
  price: 5500,
  rawText: "PS5 鍥? 琛? 鎵? 柄 黑 白 5500"
});
assert.ok(dirty.qualityScore < 82);
assert.ok(dirty.qualityFlags.includes("ocr-broken-char"));

assert.strictEqual(
  dedupeQuoteKey({ sourceName: "AH", skuName: "iPhone 17 256G 全新", price: 5680 }),
  dedupeQuoteKey({ sourceName: "AH", skuName: "i Phone 17 2 56 G", price: 5680 })
);

const correctRedmi = enrichQuote({
  skuName: "红米 Turbo4pro 16+512 黑白绿 全新",
  sourceName: "AH OCR",
  price: 1880,
  rawText: "红米 Turbo4pro 16+512 黑白绿 1880",
  confidence: 0.74
});
const mergedRedmi = enrichQuote({
  skuName: "红米 Turbo4pro 16+512 黑白绿 全新",
  sourceName: "AH OCR",
  price: 2720,
  rawText: "红米 Turbo4pro 16+512 黑白绿 1880 小米平板 8pro 12+256 黑蓝绿 2720",
  confidence: 0.74
});
assert.strictEqual(quoteIdentityKey(correctRedmi), quoteIdentityKey(mergedRedmi));
assert.notStrictEqual(
  quoteIdentityKey({ sourceName: "AH", skuName: "iPhone17 256G 全新", conditionNote: "", rawText: "黑 5670 预激活 5550" }),
  quoteIdentityKey({ sourceName: "AH", skuName: "iPhone17 256G 全新 预激活", conditionNote: "预激活" })
);
assert.strictEqual(preferQuote(correctRedmi, mergedRedmi).price, 1880);

const mergedWatches = enrichQuote({
  skuName: "华为 WATCHGTRunner 2 破晓 000 驰光蓝 00 疾影黑 00 Watch 5 46m 黑",
  sourceName: "AH收货行情表 OCR",
  price: 5735,
  confidence: 0.68
});
assert.ok(mergedWatches.qualityFlags.includes("multi-product"));
assert.ok(mergedWatches.qualityScore < 35);
assert.strictEqual(shouldKeepQuote(mergedWatches, { source: "ah", minScore: 35 }), false);

const validWatchBuds = enrichQuote({
  skuName: "华为 WATCHbuds2 耀石黑",
  sourceName: "AH收货行情表 OCR",
  price: 3105,
  confidence: 0.74
});
assert.strictEqual(validWatchBuds.category, "earbuds");
assert.ok(validWatchBuds.qualityScore >= 55);

const pageChromeLeak = enrichQuote({
  skuName: "华为 WATCHWatchD2 Watchbuds 邀请你登录一起查看/编辑文档 3 人正在协作登录并查看 90 薄荷绿",
  sourceName: "AH收货行情表 OCR",
  price: 415,
  confidence: 0.68
});
assert.ok(pageChromeLeak.qualityFlags.includes("page-chrome"));
assert.strictEqual(shouldKeepQuote(pageChromeLeak, { source: "ah", minScore: 35 }), false);

console.log("quote cleaner smoke ok");
