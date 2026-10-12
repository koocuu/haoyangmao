#!/usr/bin/env node
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { tools } = require("./remote-schema");
const { CheckService } = require("../lib/remote-checks");
const versions = ["2025-11-25", "2025-06-18", "2025-03-26"];
const { loadConfig, telegramNotifier, hash } = require("../lib/remote-config");

function createRemoteServer({ config, service }) {
  let tail = Promise.resolve(), queued = 0;
  const serial = (fn) => {
    if (queued >= 20) return Promise.reject(new Error("Server busy"));
    queued++;
    const run = tail.then(fn);
    tail = run.catch(() => {}).finally(() => { queued--; });
    return run;
  };
  let rateWindow = Date.now(), total = 0;
  const counts = new Map();
  const server = http.createServer(async (req, res) => {
    const send = (status, value) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      res.end(value === undefined ? undefined : JSON.stringify(value));
    };
    const rpcError = (status, id, code, message) => send(status, { jsonrpc: "2.0", id, error: { code, message } });
    if (Date.now() - rateWindow >= 60000) { rateWindow = Date.now(); total = 0; counts.clear(); }
    if (++total > 600) return send(429, { error: "Rate limit" });
    if (req.url !== "/mcp") return send(404, { error: "Not found" });
    const localHosts = [`127.0.0.1:${server.address().port}`, `localhost:${server.address().port}`];
    if (![...localHosts, ...config.allowedHosts].includes(req.headers.host)) return send(403, { error: "Invalid host" });
    const origin = req.headers.origin;
    if (origin && !(config.allowedOrigins || []).includes(origin)) return send(403, { error: "Invalid origin" });
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, MCP-Protocol-Version");
      res.setHeader("Access-Control-Allow-Methods", "POST");
    }
    if (req.method === "OPTIONS" && origin) return send(204);
    const authorization = req.headers.authorization || "";
    const supplied = hash(authorization.startsWith("Bearer ") ? authorization.slice(7) : "");
    const principal = config.clients.find((client) => crypto.timingSafeEqual(supplied, client.tokenHash));
    if (!principal) { res.setHeader("WWW-Authenticate", 'Bearer realm="haoyangmao-mcp"'); return send(401, { error: "Unauthorized" }); }
    counts.set(principal.id, (counts.get(principal.id) || 0) + 1);
    if (counts.get(principal.id) > 120) return send(429, { error: "Rate limit" });
    if (req.method !== "POST") { res.setHeader("Allow", "POST"); return send(405, { error: "Only POST supported; no SSE stream" }); }
    if (!(req.headers["content-type"] || "").match(/^application\/json(?:;|$)/i)) return send(415, { error: "JSON required" });
    if (!(req.headers.accept || "").includes("application/json") || !(req.headers.accept || "").includes("text/event-stream")) return send(406, { error: "Accept application/json and text/event-stream" });
    const version = req.headers["mcp-protocol-version"] || "2025-03-26";
    if (!versions.includes(version)) return send(400, { error: "Unsupported protocol version" });
    if (Number(req.headers["content-length"]) > 32768) return send(413, { error: "Body too large" });
    let message;
    try {
      let size = 0; const chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > 32768) return send(413, { error: "Body too large" }); chunks.push(chunk); }
      message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch { return rpcError(400, null, -32700, "Invalid JSON"); }
    if (!message || Array.isArray(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string" || (message.id !== undefined && typeof message.id !== "string" && !Number.isSafeInteger(message.id))) return rpcError(400, null, -32600, "Invalid request");
    if (message.id === undefined) {
      if (["notifications/initialized", "notifications/cancelled"].includes(message.method)) return send(202);
      return rpcError(400, null, -32600, "Unsupported notification");
    }
    const respond = (result) => send(200, { jsonrpc: "2.0", id: message.id, result });
    if (message.method === "initialize") return respond({ protocolVersion: versions.includes(message.params?.protocolVersion) ? message.params.protocolVersion : versions[0], capabilities: { tools: {} }, serverInfo: { name: "haoyangmao-remote-checks", version: "1.0.0" } });
    if (message.method === "ping") return respond({});
    if (message.method === "tools/list") return respond({ tools: tools.filter((tool) => principal.tools.includes(tool.name)) });
    if (message.method !== "tools/call") return rpcError(200, message.id, -32601, "Method not found");
    const params = message.params;
    if (!params || typeof params.name !== "string") return rpcError(200, message.id, -32602, "Invalid tool parameters");
    try {
      const result = await serial(() => service.call(principal, params.name, params.arguments || {}));
      respond({ content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: false });
    } catch (error) {
      // Return only controlled validation messages, never OS paths, tokens or provider errors.
      const safe = /^(Invalid |Tool not authorized|Check not found|Idempotency conflict|Recent |Source not authorized|Product family not authorized|Opportunity identity|Older lead|Server busy)/.test(error.message);
      respond({ content: [{ type: "text", text: safe ? error.message : "Processing failed; inspect local service" }], isError: true });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.timeout = 15000;
  server.keepAliveTimeout = 5000;
  server.maxConnections = 50;
  server.runMaintenance = () => serial(() => service.tick());
  return server;
}

function main() {
  const port = Number(process.env.HYM_MCP_PORT || 8766);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid MCP port");
  const config = loadConfig();
  const notify = telegramNotifier(config);
  const service = new CheckService({ config, notify });
  const server = createRemoteServer({ config, service });
  const timer = setInterval(() => server.runMaintenance().catch(() => console.error("MCP maintenance failed; inspect local state")), 60000);
  const shutdown = () => { clearInterval(timer); server.close(() => { service.close(); process.exit(0); }); };
  process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
  server.on("error", () => { clearInterval(timer); service.close(); console.error("MCP listener failed"); process.exitCode = 1; });
  server.listen(port, "127.0.0.1", () => console.log(`MCP ready: http://127.0.0.1:${server.address().port}/mcp (loopback only)`));
}
if (require.main === module) { try { main(); } catch { console.error("MCP startup failed: check local config, credentials and store lock"); process.exitCode = 1; } }
module.exports = { createRemoteServer, loadConfig, telegramNotifier };
