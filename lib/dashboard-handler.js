"use strict";
const { BlobStore } = require("./remote-blob");
const { createHandler } = require("./remote-handler");
const { GithubAuth, AuthError, authConfig, sessionId, requireCsrf, requestOrigin } = require("./github-auth");
const { headers, send, errorResponse, readBody, guard } = require("./github-handler");
const { tools, validate } = require("../mcp/remote-schema");
function dashboardMessage(message) {
  if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0" || Object.keys(message).some(key => !["jsonrpc", "id", "method", "params"].includes(key))) throw new AuthError(400);
  if (message.id !== undefined && !(typeof message.id === "string" && message.id.length <= 100) && !Number.isSafeInteger(message.id)) throw new AuthError(400);
  if (message.method === "notifications/initialized" && message.id === undefined && message.params === undefined) return;
  if (message.id === undefined) throw new AuthError(400);
  if (message.method === "initialize") return;
  if (message.method !== "tools/call" || !message.params || Array.isArray(message.params) || Object.keys(message.params).some(key => !["name", "arguments"].includes(key)) || message.params.name !== "get_status") throw new AuthError(403);
  try { validate(message.params.arguments ?? {}, tools.find(tool => tool.name === "get_status").inputSchema); } catch { throw new AuthError(400); }
}
function createDashboardHandler({ env = process.env, authStoreFactory = token => new BlobStore({ token, kind: "auth" }), storeFactory, now = Date.now, requestTimeoutMs = 40000 } = {}) {
  const enter = guard(now);
  const remote = createHandler({ env, ...(storeFactory ? { storeFactory } : {}), notifyFactory: () => null, now, readonlyDashboard: true });
  return async function handler(req, res) {
    headers(res); let release;
    const signal = AbortSignal.timeout(requestTimeoutMs);
    try {
      if (req.method !== "POST") { res.setHeader("Allow", "POST"); return send(res, 405, { error: "Method not allowed" }); }
      requestOrigin(req, true);
      if (req.url !== undefined && req.url !== "/api/dashboard") throw new AuthError(400);
      const config = authConfig(env); if (!config) throw new AuthError(503);
      const id = sessionId(config, req); if (!id) throw new AuthError(); requireCsrf(config, req, id);
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || "")) throw new AuthError(415);
      release = enter("dashboard");
      const body = await readBody(req, 32768, false, signal); dashboardMessage(body);
      const auth = new GithubAuth({ config, store: authStoreFactory(config.token), now });
      if (!await auth.lookup(req, "dashboard", signal)) throw new AuthError();
      // Server-owned factory principal, never a forged request header or an
      // external self-request. The browser never receives a Dashboard token.
      return await remote({ method: "POST", body, headers: { host: req.headers.host, origin: req.headers.origin,
        "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25" } }, res, signal);
    } catch (error) { return errorResponse(res, error); }
    finally { release?.(); }
  };
}
module.exports = { createDashboardHandler, dashboardMessage };
