const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  extractDealLines,
  importAhKdocsOcrText,
  importQuoteText,
  loadConfig,
  parseAhKdocsOcrLayout,
  parseAhKdocsOcrTextV2,
  parseLeadLine,
  parseQuoteLine
} = require("../automation-server");

const statePath = path.join(__dirname, "..", "data", "state.json");
const originalState = fs.existsSync(statePath) ? fs.readFileSync(statePath, "utf8") : null;

try {
fs.writeFileSync(statePath, JSON.stringify({ leads: [], quotes: [], runs: [] }, null, 2), "utf8");

const lead = parseLeadLine("PDD 百亿补贴 iPhone 16 256G 国行 黑色 券后 5599", "pdd");
assert.ok(lead);
assert.strictEqual(lead.source, "pdd");
assert.ok(lead.rawText.includes("iPhone 16"));

const xiaogeQuote = parseQuoteLine("小鸽 iPhone 16 256G 国行 全新未激活 5730");
assert.ok(xiaogeQuote);
assert.strictEqual(xiaogeQuote.sourceName, "小鸽");
assert.strictEqual(xiaogeQuote.price, 5730);
assert.strictEqual(xiaogeQuote.sourceType, "recycler");

const dealerQuote = parseQuoteLine("贩子A PS5 Slim 国行 光驱版 全新 3050");
assert.ok(dealerQuote);
assert.strictEqual(dealerQuote.sourceType, "dealer");
assert.strictEqual(dealerQuote.price, 3050);

const lines = extractDealLines(
  "<html><body><a>PDD 百亿补贴 iPhone 16 256G 国行 券后 5599 元</a><a>普通文章</a></body></html>",
  { keywords: ["iPhone 16", "券"] }
);
assert.ok(lines.length >= 1);

const imported = importQuoteText(
  [
    "踏浪数码",
    "iPhone17ProMax 256G",
    "深蓝色 8910",
    "橙色 8900"
  ].join("\n"),
  "踏浪"
);
assert.ok(imported.imported >= 2);
assert.ok(imported.items.some((quote) => quote.skuName.includes("深蓝色") && quote.price === 8910));

const scopedAhQuotes = parseAhKdocsOcrTextV2(
  "\u7ea2\u7c73 Turbo4pro 16+512 \u9ed1 \u767d \u7eff 1880 \u5c0f\u7c73 \u5e73 \u677f 8pro 12+256 \u9ed1 \u84dd \u7eff 2720",
  "AH OCR"
);
assert.strictEqual(scopedAhQuotes.length, 1);
assert.strictEqual(scopedAhQuotes[0].price, 1880);
assert.ok(!scopedAhQuotes[0].rawText.includes("2720"));

const layoutQuotes = parseAhKdocsOcrLayout({
  width: 2400,
  lines: [
    { text: "17 一 256G：黑 5670 白 5720 紫 5660 蓝 5660 绿 5660 预激活 5550", words: [] },
    { text: "17PRO-256G: 银 78S0 橙 7M0 蓝 7710 预激活 7750 橙 7550 蓝 76S0", words: [] },
    { text: "17PRO-1TBG: 银 117 橙 1 1800 蓝 117m 预激活-150", words: [] },
    { text: "17 MAX-512G: 银 10800 橙 10S00 蓝 107m 预激活-100", words: [] },
    { text: "17 MAX-256G：银 8850 橙 8640 蓝 8700 预激活 银 8750 橙 8 S80 蓝 86m", words: [] },
    { text: "17 MAX-2TBG：银 151m 橙 151m 蓝 151m 预激活-150", words: [] },
    { text: "17e-256G：黑 40m 白 4 粉 40m", words: [] },
    { text: "17e 巧12G：黑 5650 白 5650 粉 56m", words: [] },
    { text: "AirPods4降噪版(P93)*995", words: [] },
    { text: "AirPods4ßS*版(P93)*99S", words: [] },
    { text: "AirPods3代Pro无线耳机(HP4)*1 S50", words: [] },
    { text: "AirPods2代 @N * 610", words: [] },
    { text: "红米 k90max 1 2+512 黑 恨 蓝 3020", words: [] },
    { text: "红米 k90max 16 + ltb 黑 银 蓝 3570", words: [] },
    { text: "红米 14 ( 4 + 64 ( 无 充 ) 黑 银 绿 455", words: [] },
    { text: "红米 14C4 + 64 ( 有 充 ) 黑 银 绿 530", words: [] },
    { text: "24年不要AirPods2代Pro(JV3)*1220", words: [] },
    { text: "一加 Turbo6 16+512 青 黑 钅 良 2790", words: [] },
    { text: "一加 ACE6 至尊 16+512 黑白 3740", words: [] }
  ]
}, "AH OCR");
const layoutBySku = new Map(layoutQuotes.map((quote) => [quote.skuName.replace(/ 全新$/, ""), quote.price]));
assert.strictEqual(layoutBySku.get("iPhone17 256G"), 5660);
assert.strictEqual(layoutBySku.get("iPhone17 256G 预激活"), 5550);
assert.strictEqual(layoutBySku.get("iPhone17 Pro 256G"), 7640);
assert.strictEqual(layoutBySku.get("iPhone17 Pro 256G 预激活"), 7550);
assert.strictEqual(layoutBySku.get("iPhone17 Pro 1TB"), 11700);
assert.strictEqual(layoutBySku.get("iPhone17 ProMax 512G"), 10500);
assert.strictEqual(layoutBySku.get("iPhone17 ProMax 256G 预激活"), 8580);
assert.strictEqual(layoutBySku.get("iPhone17 ProMax 2TB"), 15100);
assert.strictEqual(layoutBySku.get("iPhone17e 256G"), 4000);
assert.strictEqual(layoutBySku.get("iPhone17e 512G"), 5600);
assert.strictEqual(layoutBySku.get("一加 Turbo6 16+512"), 2790);
assert.strictEqual(layoutBySku.get("一加 ACE6 至尊 16+512"), 3740);
assert.ok([...layoutBySku.keys()].some((sku) => /AirPods4/.test(sku)));
assert.strictEqual(layoutBySku.get("AirPods4 降噪版 (P93)"), 995);
assert.strictEqual(layoutBySku.get("AirPods3 Pro 无线耳机 (HP4)"), 1550);
assert.ok(!layoutQuotes.some((quote) => /@N/.test(quote.skuName)));
assert.strictEqual(layoutBySku.get("红米 K90 Max 12+512 黑 银 蓝"), 3020);
assert.strictEqual(layoutBySku.get("红米 K90 Max 16+1TB 黑 银 蓝"), 3570);
assert.strictEqual(layoutBySku.get("红米 14C 4+64 (无充) 黑 银 绿"), 455);
assert.strictEqual(layoutBySku.get("红米 14C 4+64 (有充) 黑 银 绿"), 530);
assert.ok(![...layoutBySku.keys()].some((sku) => /JV3/.test(sku)));

assert.strictEqual(loadConfig().intervalMinutes, 1440);

fs.writeFileSync(statePath, JSON.stringify({
  leads: [],
  runs: [],
  quotes: [
    { id: "old-ah", sourceName: "AH OCR", skuName: "旧 AH 报价", price: 999 },
    { id: "old-ah-alias", sourceName: "AH", skuName: "旧 AH 别名报价", price: 777 },
    { id: "xiaoge", sourceName: "小鸽", skuName: "保留的小鸽报价", price: 888 }
  ]
}, null, 2), "utf8");
const replaced = importAhKdocsOcrText(
  "红米 Turbo4pro 16+512 黑白绿 1880",
  "AH OCR",
  { replaceSource: true, minQuotes: 1 }
);
assert.strictEqual(replaced.imported, 1);
const replacedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
assert.ok(!replacedState.quotes.some((quote) => quote.id === "old-ah"));
assert.ok(!replacedState.quotes.some((quote) => quote.id === "old-ah-alias"));
assert.ok(replacedState.quotes.some((quote) => quote.id === "xiaoge"));

assert.throws(
  () => importAhKdocsOcrText("无法识别的内容", "AH OCR", { replaceSource: true, minQuotes: 20 }),
  /已保留上一版/
);
const rejectedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
assert.ok(rejectedState.quotes.some((quote) => quote.sourceName === "AH OCR"));

console.log("automation smoke ok");
} finally {
  if (originalState === null) {
    try {
      fs.unlinkSync(statePath);
    } catch (error) {}
  } else {
    fs.writeFileSync(statePath, originalState, "utf8");
  }
}
