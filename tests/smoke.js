const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

class FakeElement {
  constructor() {
    this.value = "";
    this.textContent = "";
    this.innerHTML = "";
    this.className = "";
    this.children = [];
    this.src = "";
    this.classList = {
      add: () => {},
      remove: () => {}
    };
  }

  addEventListener() {}
  appendChild(child) {
    this.children.push(child);
  }
  click() {}
}

const ids = [
  "statusLine",
  "dropZone",
  "dropIdle",
  "longImageInput",
  "ocrStatus",
  "ocrPreview",
  "dealInput",
  "analyzeBtn",
  "judgeBadge",
  "resultEmpty",
  "resultCard",
  "kdocsOpenBtn",
  "kdocsCollectBtn",
  "kdocsStatus",
  "resultSku",
  "buyPrice",
  "sellPrice",
  "quickPrice",
  "profit",
  "reasonText",
  "quoteCount",
  "historyCount",
  "quoteSearch",
  "quoteTable",
  "historyList"
];

const elements = new Map(ids.map((id) => [id, new FakeElement()]));
const storage = new Map();

const context = {
  console,
  Date,
  Math,
  Number,
  String,
  RegExp,
  Array,
  JSON,
  URL,
  location: { protocol: "https:", origin: "https://haoyangmao.koocuu.com" },
  localStorage: {
    getItem(key) {
      return storage.get(key) || null;
    },
    setItem(key, value) {
      storage.set(key, value);
    }
  },
  fetch: async () => ({
    ok: true,
    json: async () => ({
      quotes: [
        {
          skuName: "Osmo Pocket 3 标准版 全新",
          sourceName: "小鸽",
          price: 2020,
          observedAt: "2026-07-03T08:00:00.000Z"
        }
      ]
    })
  }),
  document: {
    querySelector(selector) {
      const id = selector.replace("#", "");
      if (!elements.has(id)) elements.set(id, new FakeElement());
      return elements.get(id);
    },
    addEventListener() {},
    createElement() {
      return new FakeElement();
    }
  },
  FileReader: class {}
};

async function main() {
  vm.createContext(context);
  const appPath = path.join(__dirname, "..", "app.js");
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../lib/deal-engine.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(appPath, "utf8"), context, { filename: appPath });
  assert.strictEqual(elements.get("checksUrl").value, "https://haoyangmao.koocuu.com/api/mcp");

  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }

  assert.strictEqual(context.formatMoney(2020), "\u00a52020");
  assert.strictEqual(context.buildVerdict(160).label, "\u53ef\u51b2");
  assert.strictEqual(context.HymDealEngine.parseDealV2("\u7ea2\u7c73 Turbo4pro 15+512").price, 0);
  assert.strictEqual(context.HymDealEngine.parseDealV2("PDD iPhone 16 256G \u5238\u540e 5599").price, 5599);
  assert.strictEqual(context.HymDealEngine.extractSkuFactsV2("\u7ea2\u7c73 Turbo4pro 16+512").storage, "512gb");
  assert.strictEqual(context.HymDealEngine.extractSkuFactsV2("\u7ea2\u7c73 Turbo4pro 16+1TB").storage, "1tb");
  assert.strictEqual(context.HymDealEngine.extractSkuFactsV2("iPhone 16 256G").storage, "256gb");
  assert.strictEqual(context.HymDealEngine.calculateNetProfit(5800.10, 5599.05, { shippingCost: 20, platformCost: 0, riskBuffer: 30 }), 151.05);
  const now = Date.now();
  assert.strictEqual(context.isQuoteFresh({ sourceName: "AH\u6536\u8d27\u884c\u60c5\u8868 OCR", observedAt: new Date(now - 25 * 60 * 60 * 1000).toISOString() }, now), true);
  assert.strictEqual(context.isQuoteFresh({ sourceName: "AH\u6536\u8d27\u884c\u60c5\u8868 OCR", observedAt: new Date(now - 27 * 60 * 60 * 1000).toISOString() }, now), false);
  assert.strictEqual(context.isQuoteFresh({ sourceName: "\u5c0f\u9e3d", observedAt: new Date(now - 31 * 60 * 1000).toISOString() }, now), false);
  assert.strictEqual(context.sanitizeQuotes([{ skuName: "OCR dirty", qualityScore: 38, price: 415 }]).length, 0);
  assert.strictEqual(
    context.quoteDisplayName({ normalizedSku: "iPhone17 256G", conditionNote: "\u9884\u6fc0\u6d3b" }),
    "iPhone17 256G \u00b7 \u9884\u6fc0\u6d3b"
  );

  context.__setQuotesForTest([
    {
      skuName: "\u7ea2\u7c73 Turbo4pro 16+512 \u9ed1\u767d\u7eff \u5168\u65b0",
      normalizedSku: "\u7ea2\u7c73 Turbo4pro 16+512 \u9ed1\u767d\u7eff",
      sourceName: "AH OCR",
      price: 1880,
      qualityScore: 74
    },
    {
      skuName: "\u7ea2\u7c73 Turbo4pro 16+1TB \u9ed1\u767d\u7eff \u5168\u65b0",
      normalizedSku: "\u7ea2\u7c73 Turbo4pro 16+1TB \u9ed1\u767d\u7eff",
      sourceName: "AH OCR",
      price: 1930,
      qualityScore: 74
    },
    {
      skuName: "iPhone 17 Pro 512G \u5168\u65b0",
      normalizedSku: "iPhone 17 Pro 512G",
      sourceName: "AH OCR",
      price: 11700,
      qualityScore: 74
    }
  ]);
  assert.strictEqual(context.matchQuotesV2("\u7ea2\u7c73 Turbo4pro 15+512 \u5238\u540e 1500").length, 0);
  const redmiMatches = context.matchQuotesV2("\u7ea2\u7c73 Turbo4pro 16+512 \u5238\u540e 1500");
  assert.strictEqual(redmiMatches.length, 1);
  assert.strictEqual(redmiMatches[0].price, 1880);

  context.__setQuotesForTest([
    {
      skuName: "\u7ea2\u7c73 Turbo4pro 16+512 \u9ed1\u767d\u7eff \u5168\u65b0",
      normalizedSku: "\u7ea2\u7c73 Turbo4pro 16+512 \u9ed1\u767d\u7eff",
      sourceName: "AH OCR",
      price: 1880,
      qualityScore: 74,
      observedAt: new Date().toISOString()
    },
    {
      skuName: "\u7ea2\u7c73 Turbo4pro 16+512 \u9ed1\u767d\u7eff \u5168\u65b0",
      normalizedSku: "\u7ea2\u7c73 Turbo4pro 16+512 \u9ed1\u767d\u7eff",
      sourceName: "\u5c0f\u9e3d",
      price: 1860,
      qualityScore: 90,
      observedAt: new Date().toISOString()
    }
  ]);
  elements.get("dealInput").value = "\u7ea2\u7c73 Turbo4pro 16+512 1688";
  assert.strictEqual(context.HymDealEngine.parseDealV2(elements.get("dealInput").value).price, 1688);
  assert.strictEqual(context.matchQuotesV2(elements.get("dealInput").value).length, 2);
  context.analyzeDeal();
  assert.strictEqual(elements.get("sellPrice").textContent, "\u00a51860");
  assert.strictEqual(elements.get("quickPrice").textContent, "\u00a51880");
  assert.strictEqual(elements.get("profit").textContent, "+\u00a5122");

  context.__setQuotesForTest([
    {
      skuName: "Osmo Pocket 3 \u6807\u51c6\u7248 \u5168\u65b0",
      sourceName: "\u5c0f\u9e3d",
      price: 2020,
      qualityScore: 90,
      observedAt: "2026-07-03T08:00:00.000Z"
    }
  ]);
  elements.get("dealInput").value = "PDD \u767e\u4ebf\u8865\u8d34 Osmo Pocket 3 \u6807\u51c6\u7248 \u5238\u540e 1850";
  context.analyzeDeal();
  assert.strictEqual(elements.get("judgeBadge").textContent, "\u62a5\u4ef7\u8fc7\u671f");

  context.__setQuotesForTest([
    {
      skuName: "Osmo Pocket 3 \u6807\u51c6\u7248 \u5168\u65b0",
      sourceName: "\u5c0f\u9e3d",
      price: 2020,
      qualityScore: 90,
      observedAt: new Date().toISOString()
    }
  ]);
  context.analyzeDeal();
  assert.strictEqual(elements.get("judgeBadge").textContent, "\u53ef\u51b2");
  assert.strictEqual(elements.get("sellPrice").textContent, "\u00a52020");
  assert.strictEqual(elements.get("quickPrice").textContent, "\u00a52020");
  assert.strictEqual(elements.get("profit").textContent, "+\u00a5120");

  console.log("smoke ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
