"use strict";
const assert = require("assert/strict");
const engine = require("../lib/deal-engine");
async function main() {
  // Keep the pure profit/SKU engine regressions after retiring manual UI helpers.
  assert.equal(engine.parseDealV2("红米 Turbo4pro 15+512").price, 0);
  assert.equal(engine.parseDealV2("PDD iPhone 16 256G 券后 5599").price, 5599);
  assert.equal(engine.extractSkuFactsV2("红米 Turbo4pro 16+512").storage, "512gb");
  assert.equal(engine.extractSkuFactsV2("红米 Turbo4pro 16+1TB").storage, "1tb");
  assert.equal(engine.extractSkuFactsV2("iPhone 16 256G").storage, "256gb");
  const costs = { shippingCost: 20, platformCost: 0, riskBuffer: 30 };
  assert.equal(engine.calculateNetProfit(5800.10, 5599.05, costs), 151.05);
  const facts = engine.extractSkuFactsV2("红米 Turbo4pro 16+512 券后 1500");
  const quotes = [{ skuName: "红米 Turbo4pro 16+512 黑白绿 全新", price: 1880 }, { skuName: "红米 Turbo4pro 16+1TB 黑白绿 全新", price: 1930 }, { skuName: "iPhone 17 Pro 512G 全新", price: 11700 }];
  const matches = quotes.filter(quote => Number.isFinite(engine.scoreQuoteV2(facts, quote)));
  assert.equal(matches.length, 1); assert.equal(matches[0].price, 1880);
  assert.equal(Number.isFinite(engine.scoreQuoteV2(engine.extractSkuFactsV2("红米 Turbo4pro 15+512"), quotes[0])), false);
  const floor = [1880, 1860].sort((a, b) => a - b)[0];
  assert.equal(engine.calculateNetProfit(floor, 1688, costs), 122);
  assert.equal(engine.calculateNetProfit(2020, 1850, costs), 120);
  assert.equal(Number.isFinite(engine.scoreQuoteV2(engine.extractSkuFactsV2("iPhone 16 256G 国行 黑色 全新未激活"), { skuName: "iPhone 16 256G 国行 白色 全新未激活" })), false);
  console.log("profit/SKU engine smoke ok");
  await require("./ui-smoke")();
}
main().catch(error => { console.error(error); process.exitCode = 1; });
