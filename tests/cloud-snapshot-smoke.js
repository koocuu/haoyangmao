const assert = require("assert");
const { buildCloudSnapshot, emptyCloudSnapshot, validateCloudSnapshot } = require("../lib/cloud-snapshot");

const quotes = Array.from({ length: 20 }, (_, index) => ({
  skuName: `SKU ${index + 1}`,
  price: 1000 + index,
  observedAt: "2026-07-16T08:00:00.000Z"
}));
const snapshot = buildCloudSnapshot({ leads: [{ private: true }], quotes, runs: [{ private: true }] }, {
  imported: 20,
  syncedAt: "2026-07-16T08:10:00.000Z"
});

assert.strictEqual(validateCloudSnapshot(snapshot), snapshot);
assert.strictEqual(snapshot.state.quotes.length, 20);
assert.deepStrictEqual(snapshot.state.leads, []);
assert.deepStrictEqual(snapshot.state.runs, []);
assert.strictEqual(snapshot.scheduler.lastImported, 20);
assert.strictEqual(emptyCloudSnapshot().state.quotes.length, 0);
assert.throws(() => validateCloudSnapshot(buildCloudSnapshot({ quotes: quotes.slice(0, 5) })), /报价数量异常/);
console.log("cloud snapshot smoke ok");
