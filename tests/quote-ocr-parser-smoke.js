const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { parseRecyclerOcrText, parseModelLine } = require("../lib/quote-ocr-parser");

const root = path.join(__dirname, "..");
const talangText = fs.readFileSync(path.join(root, "data", "inbox", "quotes", "talang-ocr-sample.txt"), "utf8");
const xiaogeText = fs.readFileSync(path.join(root, "data", "inbox", "quotes", "xiaoge-ocr-sample.txt"), "utf8");

const brokenModel = parseModelLine("iPhone17ProMa x 256G");
assert.strictEqual(brokenModel.model, "iPhone17ProMax");
assert.strictEqual(brokenModel.storage, "256G");

const talangQuotes = parseRecyclerOcrText(talangText, { fallbackSource: "踏浪" });
assert.ok(talangQuotes.length >= 8);
assert.ok(talangQuotes.some((quote) => quote.skuName.includes("iPhone17ProMax 256G 深蓝色") && quote.price === 8910));
assert.ok(talangQuotes.some((quote) => quote.skuName.includes("iPhone17ProMax 512G 橙色") && quote.price === 10820));
assert.ok(talangQuotes.every((quote) => quote.sourceType === "recycler"));

const xiaogeQuotes = parseRecyclerOcrText(xiaogeText, { fallbackSource: "小鸽" });
assert.ok(xiaogeQuotes.length >= 8);
assert.ok(xiaogeQuotes.some((quote) => quote.skuName.includes("iPhone17 256G 黑色") && quote.price === 5670));
assert.ok(xiaogeQuotes.some((quote) => quote.skuName.includes("iPhone17 256G 白色") && quote.price === 5690));
assert.ok(xiaogeQuotes.some((quote) => quote.skuName.includes("iPhone17 512G 黑色") && quote.price === 6670));

console.log("quote ocr parser smoke ok");
