"use strict";
// Test-only process: never reads real env credentials or connects to real providers.
const http = require("http");
const { createHandler } = require("../lib/remote-handler");
const { BlobStore } = require("../lib/remote-blob");
const sdkTypes = require("@vercel/blob");
let now = Number(process.env.FIXTURE_NOW);
const backend = process.env.FIXTURE_BACKEND;
const sdk = {
  BlobError: sdkTypes.BlobError, BlobPreconditionFailedError: sdkTypes.BlobPreconditionFailedError,
  async get(path, options) {
    const response = await fetch(`${backend}/blob`, { headers: { "x-options": JSON.stringify({ path, ...options, abortSignal: undefined }) }, signal: options.abortSignal });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error("fixture read unavailable");
    return { statusCode: 200, stream: response.body, blob: { etag: response.headers.get("etag"), size: Number(response.headers.get("content-length")) } };
  },
  async put(path, body, options) {
    const response = await fetch(`${backend}/blob`, { method: "PUT", body, signal: options.abortSignal, headers: { "x-options": JSON.stringify({ path, ...options, abortSignal: undefined }) } });
    if (response.status === 412) throw new sdkTypes.BlobPreconditionFailedError();
    if (response.status === 409) throw new sdkTypes.BlobError("This blob already exists, use `allowOverwrite: true` if you want to overwrite it. Or `addRandomSuffix: true` to generate a unique filename.");
    if (!response.ok) throw new Error("fixture write response lost");
    return { etag: response.headers.get("etag") };
  }
};
const notify = async (notice, signal) => {
  const response = await fetch(`${backend}/notify`, { method: "POST", body: JSON.stringify(notice), signal });
  if (!response.ok) throw new Error("fixture delivery outcome unknown");
};
notify.available = () => process.env.FIXTURE_NOTIFY !== "disabled";
const env = JSON.parse(process.env.FIXTURE_ENV);
const handler = createHandler({ env, storeFactory: (token) => new BlobStore({ token, sdk }), notifyFactory: () => notify, now: () => now });
const server = http.createServer((req, res) => {
  if (req.url !== "/api/mcp") { res.writeHead(404); res.end(); return; }
  handler(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
});
server.listen(0, "127.0.0.1", () => process.send({ url: `http://127.0.0.1:${server.address().port}/api/mcp` }));
process.on("message", (message) => {
  if (message.now) { now = message.now; process.send({ clock: now }); }
  if (message.stop) { server.close(); server.closeAllConnections(); process.disconnect(); }
});
