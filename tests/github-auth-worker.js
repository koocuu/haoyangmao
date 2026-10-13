"use strict";
// Isolated test process. Only fixture configuration and loopback providers.
const http = require("http");
const { BlobStore } = require("../lib/remote-blob");
const { createAuthHandler } = require("../lib/github-handler");
const { createDashboardHandler } = require("../lib/dashboard-handler");
const { createHandler } = require("../lib/remote-handler");
const sdkTypes = require("@vercel/blob");
const env = JSON.parse(process.env.FIXTURE_ENV), backend = process.env.FIXTURE_BACKEND;
let now = Number(process.env.FIXTURE_NOW);
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
    if (!response.ok) throw new Error("fixture ACK lost");
    return { etag: response.headers.get("etag") };
  }
};
const factory = token => new BlobStore({ token, sdk, kind: "auth" });
const business = token => new BlobStore({ token, sdk });
const auth = createAuthHandler({ env, storeFactory: factory, now: () => now, githubTimeoutMs: 500,
  fetcher: (url, options) => {
    if (!["https://github.com/login/oauth/access_token", "https://api.github.com/user"].includes(url) || options.redirect !== "error" || options.cache !== "no-store") throw new Error("unsafe fixture provider call");
    return fetch(`${backend}${url.endsWith("access_token") ? "/token" : "/user"}`, options);
  } });
const dashboard = createDashboardHandler({ env, authStoreFactory: factory, storeFactory: business, now: () => now });
const mcp = createHandler({ env, storeFactory: business, now: () => now, notifyFactory: () => null });
const server = http.createServer((req, res) => {
  const handler = req.url.startsWith("/api/auth/") ? auth : req.url === "/api/dashboard" ? dashboard : req.url === "/api/mcp" ? mcp : null;
  if (!handler) { res.writeHead(404); res.end(); return; }
  handler(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
});
server.listen(0, "127.0.0.1", () => process.send({ url: `http://127.0.0.1:${server.address().port}` }));
process.on("message", message => {
  if (message.now) { now = message.now; process.send({ clock: now }); }
  if (message.stop) { server.close(); server.closeAllConnections(); process.disconnect(); }
});
