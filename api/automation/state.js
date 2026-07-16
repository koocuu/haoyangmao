const { loadSnapshot, sendJson } = require("../_blob");

module.exports = async function handler(request, response) {
  if (request.method !== "GET") return sendJson(response, 405, { error: "Method not allowed" });
  try {
    const snapshot = await loadSnapshot();
    return sendJson(response, 200, snapshot.state);
  } catch (error) {
    return sendJson(response, 500, { error: error.message });
  }
};
