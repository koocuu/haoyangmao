const { loadSnapshot, sendJson } = require("../_blob");

module.exports = async function handler(request, response) {
  if (request.method !== "GET") return sendJson(response, 405, { error: "Method not allowed" });
  try {
    const snapshot = await loadSnapshot();
    return sendJson(response, 200, {
      mode: "cloud",
      running: false,
      scheduler: snapshot.scheduler,
      state: {
        leads: 0,
        quotes: snapshot.state.quotes.length,
        runs: 0,
        lastRun: null
      },
      syncedAt: snapshot.syncedAt,
      sourceCollectedAt: snapshot.sourceCollectedAt
    });
  } catch (error) {
    return sendJson(response, 500, { error: error.message });
  }
};
