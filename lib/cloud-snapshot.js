const SNAPSHOT_SCHEMA_VERSION = 1;

function buildCloudSnapshot(state, options = {}) {
  const quotes = Array.isArray(state?.quotes) ? state.quotes : [];
  const syncedAt = options.syncedAt || new Date().toISOString();
  const observedTimes = quotes
    .map((quote) => Date.parse(quote?.observedAt || ""))
    .filter(Number.isFinite);
  const sourceCollectedAt = options.sourceCollectedAt
    || (observedTimes.length ? new Date(Math.max(...observedTimes)).toISOString() : syncedAt);

  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    syncedAt,
    sourceCollectedAt,
    source: options.source || "windows-ah-collector",
    state: {
      leads: [],
      quotes,
      runs: []
    },
    scheduler: {
      active: false,
      lastSuccessAt: sourceCollectedAt,
      lastError: "",
      lastImported: Number(options.imported ?? quotes.length),
      lastEvidencePath: "",
      lastCloudSyncAt: syncedAt
    }
  };
}

function validateCloudSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") throw new Error("快照必须是 JSON 对象");
  if (Number(snapshot.schemaVersion) !== SNAPSHOT_SCHEMA_VERSION) throw new Error("不支持的快照版本");
  if (!Number.isFinite(Date.parse(snapshot.syncedAt || ""))) throw new Error("快照缺少有效 syncedAt");
  if (!snapshot.state || !Array.isArray(snapshot.state.quotes)) throw new Error("快照缺少报价数组");
  if (snapshot.state.quotes.length < 20 || snapshot.state.quotes.length > 2000) {
    throw new Error(`报价数量异常：${snapshot.state.quotes.length}`);
  }

  for (const quote of snapshot.state.quotes) {
    if (!String(quote?.skuName || quote?.normalizedSku || "").trim()) throw new Error("报价缺少 SKU");
    const price = Number(quote?.price);
    if (!Number.isFinite(price) || price <= 0 || price > 200000) throw new Error("报价价格异常");
  }
  return snapshot;
}

function emptyCloudSnapshot() {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    syncedAt: "",
    sourceCollectedAt: "",
    source: "cloud-empty",
    state: { leads: [], quotes: [], runs: [] },
    scheduler: {
      active: false,
      lastSuccessAt: "",
      lastError: "尚未收到本机 AH 报价快照",
      lastImported: 0,
      lastEvidencePath: "",
      lastCloudSyncAt: ""
    }
  };
}

module.exports = {
  SNAPSHOT_SCHEMA_VERSION,
  buildCloudSnapshot,
  emptyCloudSnapshot,
  validateCloudSnapshot
};
