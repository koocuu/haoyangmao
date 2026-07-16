const { emptyCloudSnapshot, validateCloudSnapshot } = require("../lib/cloud-snapshot");

const BLOB_PATH = "haoyangmao/latest-state.json";

async function saveSnapshot(snapshot) {
  const { put } = await import("@vercel/blob");
  const validated = validateCloudSnapshot(snapshot);
  const blob = await put(BLOB_PATH, JSON.stringify(validated), {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 60,
    contentType: "application/json"
  });
  return blob;
}

async function loadSnapshot() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return emptyCloudSnapshot();
  const { head } = await import("@vercel/blob");
  try {
    const blob = await head(BLOB_PATH);
    const response = await fetch(blob.downloadUrl || blob.url, { cache: "no-store" });
    if (!response.ok) throw new Error(`Blob HTTP ${response.status}`);
    return validateCloudSnapshot(await response.json());
  } catch (error) {
    if (/not found|404/i.test(error.message)) return emptyCloudSnapshot();
    throw error;
  }
}

function sendJson(response, status, payload) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request) {
  if (request.body && typeof request.body === "object") return request.body;
  let text = "";
  for await (const chunk of request) {
    text += chunk;
    if (text.length > 2 * 1024 * 1024) throw new Error("请求体过大");
  }
  return text ? JSON.parse(text) : {};
}

module.exports = { loadSnapshot, readJsonBody, saveSnapshot, sendJson };
