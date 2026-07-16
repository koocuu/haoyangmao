const crypto = require("crypto");
const { readJsonBody, saveSnapshot, sendJson } = require("../_blob");

function tokensEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = async function handler(request, response) {
  if (request.method !== "POST") return sendJson(response, 405, { error: "Method not allowed" });
  const expected = process.env.HYM_SYNC_TOKEN;
  const provided = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!expected || !tokensEqual(provided, expected)) return sendJson(response, 401, { error: "Unauthorized" });

  try {
    const snapshot = await readJsonBody(request);
    const blob = await saveSnapshot(snapshot);
    return sendJson(response, 200, {
      ok: true,
      syncedAt: snapshot.syncedAt,
      quotes: snapshot.state.quotes.length,
      pathname: blob.pathname
    });
  } catch (error) {
    return sendJson(response, 400, { error: error.message });
  }
};
