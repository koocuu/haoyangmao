"use strict";
const crypto = require("crypto");
const { tools } = require("../mcp/remote-schema");
const { authorizeCall, previewCheck, publicError } = require("./remote-core");
const { loadCloudConfig, telegramNotifier, hash } = require("./remote-config");
const { BlobStore, CloudChecks, Unavailable, Limited } = require("./remote-blob");
const versions = ["2025-11-25", "2025-06-18", "2025-03-26"];
const MAX_BODY = 32768;
const MAX_RESPONSE = 4 * 1024 * 1024;

function createHandler({ env = process.env, storeFactory = (token) => new BlobStore({ token }), notifyFactory = telegramNotifier, now = Date.now } = {}) {
  // Preview intentionally has no global/cloud rate writes. This fixed-size,
  // process-local guard bounds work per warm serverless instance only.
  let previewStart = now(), previewTotal = 0;
  const previewCounts = new Map();
  async function processRequest(req, res) {
    let lease, service;
    const signal = AbortSignal.timeout(40000);
    const send = (status, value) => {
      const body = value === undefined ? "" : JSON.stringify(value);
      if (Buffer.byteLength(body) > MAX_RESPONSE) {
        res.statusCode = 503; res.end('{"error":"Response capacity reached; request a smaller page"}'); return;
      }
      res.statusCode = status; res.end(body);
    };
    const rpcError = (status, id, code, message) => send(status, { jsonrpc: "2.0", id, error: { code, message } });
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    let config, token;
    try {
      config = loadCloudConfig(env);
      token = env.HYM_MCP_BLOB_READ_WRITE_TOKEN;
      if (!token || token === env.BLOB_READ_WRITE_TOKEN) throw new Error("Independent private token required");
    } catch { return send(503, { error: "MCP configuration unavailable" }); }
    if (!config.allowedHosts.includes(req.headers.host)) return send(403, { error: "Invalid host" });
    const origin = req.headers.origin;
    if (origin !== undefined && !config.allowedOrigins.includes(origin)) return send(403, { error: "Invalid origin" });
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin); res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, MCP-Protocol-Version");
      res.setHeader("Access-Control-Allow-Methods", "POST");
    }
    if (req.method === "OPTIONS" && origin) return send(204);
    const authorization = req.headers.authorization;
    const supplied = hash(typeof authorization === "string" && /^Bearer [\x21-\x7e]{32,256}$/.test(authorization) ? authorization.slice(7) : "");
    const principal = config.clients.find((client) => crypto.timingSafeEqual(supplied, client.tokenHash));
    if (!principal) { res.setHeader("WWW-Authenticate", 'Bearer realm="haoyangmao-mcp"'); return send(401, { error: "Unauthorized" }); }
    if (req.method !== "POST") { res.setHeader("Allow", "POST"); return send(405, { error: "Only POST supported" }); }
    if (typeof req.headers["content-type"] !== "string" || !/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"])) return send(415, { error: "JSON required" });
    const accept = req.headers.accept || "";
    if (typeof accept !== "string" || !accept.includes("application/json") || !accept.includes("text/event-stream")) return send(406, { error: "Accept application/json and text/event-stream" });
    if (!versions.includes(req.headers["mcp-protocol-version"] || "2025-03-26")) return send(400, { error: "Unsupported protocol version" });
    if (Number(req.headers["content-length"]) > MAX_BODY) return send(413, { error: "Body too large" });
    let message;
    try {
      if (req.body !== undefined) {
        const raw = typeof req.body === "string" || Buffer.isBuffer(req.body) ? req.body : JSON.stringify(req.body);
        if (Buffer.byteLength(raw) > MAX_BODY) return send(413, { error: "Body too large" });
        message = typeof req.body === "object" && !Buffer.isBuffer(req.body) ? req.body : JSON.parse(raw);
      } else {
        const chunks = []; let size = 0;
        const timeout = setTimeout(() => req.destroy(), 10000);
        try {
          for await (const chunk of req) {
            size += Buffer.byteLength(chunk); if (size > MAX_BODY) return send(413, { error: "Body too large" });
            chunks.push(Buffer.from(chunk));
          }
          message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } finally { clearTimeout(timeout); }
      }
    } catch { return rpcError(400, null, -32700, "Invalid JSON"); }
    if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0"
      || typeof message.method !== "string" || message.method.length > 100
      || Object.keys(message).some((key) => !["jsonrpc", "id", "method", "params"].includes(key))
      || (message.id !== undefined && !(typeof message.id === "string" && message.id.length <= 100) && !Number.isSafeInteger(message.id))) return rpcError(400, null, -32600, "Invalid request");
    const respond = (result) => send(200, { jsonrpc: "2.0", id: message.id, result });
    // Reject static tool/source/family scope failures before even constructing
    // storage. Resource/check workspace membership is also checked in the core.
    if (message.method === "tools/call") {
      const params = message.params;
      if (!params || typeof params !== "object" || Array.isArray(params) || typeof params.name !== "string"
        || Object.keys(params).some((key) => !["name", "arguments", "_meta"].includes(key))) return rpcError(200, message.id ?? null, -32602, "Invalid tool parameters");
      const tool = tools.find((item) => item.name === params.name);
      let problem;
      if (!tool || !principal.tools.includes(params.name)) problem = "Tool not authorized";
      else {
        try { authorizeCall(config, principal, params.name, params.arguments ?? {}); }
        catch (error) { problem = publicError(error); }
      }
      if (problem) return respond({ content: [{ type: "text", text: problem }], isError: true });
    }
    try {
      if (message.method === "tools/call" && message.params.name === "preview_check") {
        if (message.id === undefined) return rpcError(400, null, -32600, "Unsupported notification");
        if (now() - previewStart >= 60000) { previewStart = now(); previewTotal = 0; previewCounts.clear(); }
        const count = (previewCounts.get(principal.id) || 0) + 1;
        if (++previewTotal > 600 || count > 120) throw new Limited();
        previewCounts.set(principal.id, count);
        const result = previewCheck(config, principal, message.params.arguments ?? {}, now());
        return respond({ content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: false });
      }
      const store = storeFactory(token);
      service = new CloudChecks({ config, store, notify: notifyFactory(config, env), now });
      lease = await service.acquire(principal, signal);
      if (message.id === undefined) {
        if (["notifications/initialized", "notifications/cancelled"].includes(message.method)) return send(202);
        return rpcError(400, null, -32600, "Unsupported notification");
      }
      if (message.method === "initialize") return respond({ protocolVersion: versions.includes(message.params?.protocolVersion) ? message.params.protocolVersion : versions[0], capabilities: { tools: {} }, serverInfo: { name: "haoyangmao-cloud-checks", version: "1.1.0" } });
      if (message.method === "ping") return respond({});
      if (message.method === "tools/list") return respond({ tools: tools.filter((tool) => principal.tools.includes(tool.name)) });
      if (message.method !== "tools/call") return rpcError(200, message.id, -32601, "Method not found");
      const params = message.params;
      if (!params || typeof params !== "object" || Array.isArray(params) || typeof params.name !== "string"
        || Object.keys(params).some((key) => !["name", "arguments", "_meta"].includes(key))) return rpcError(200, message.id, -32602, "Invalid tool parameters");
      const result = await service.call(principal, params.name, params.arguments ?? {}, signal);
      return respond({ content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: false });
    } catch (error) {
      if (error instanceof Limited) { res.setHeader("Retry-After", "60"); return send(429, { error: "Rate or concurrency limit" }); }
      if (error instanceof Unavailable || signal.aborted) {
        if (error instanceof Unavailable) console.error("MCP_STORAGE", error.reason, error.sdkClass);
        else console.error("MCP_STORAGE", "request_timeout", "TimeoutError");
        return send(503, { error: "Storage unavailable or write outcome unknown; no automatic retry" });
      }
      const message = publicError(error);
      if (message === "Processing unavailable; inspect service configuration") console.error("MCP request failed; private storage or configuration requires review");
      return respond({ content: [{ type: "text", text: message }], isError: true });
    } finally {
      if (lease) await service.release(lease, signal);
    }
  }
  return async function handler(req, res) {
    let body;
    const staged = {
      setHeader: (name, value) => res.setHeader(name, value),
      set statusCode(value) { res.statusCode = value; },
      end(value) { body = value; }
    };
    // Finish awaited lease release before closing the response. Serverless
    // platforms may suspend an invocation once its HTTP response is complete.
    await processRequest(req, staged);
    res.end(body);
  };
}
module.exports = { createHandler, MAX_BODY, MAX_RESPONSE };
