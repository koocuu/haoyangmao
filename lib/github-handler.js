"use strict";
const { BlobStore, Limited } = require("./remote-blob");
const { ORIGIN, ISSUER } = require("./github-store");
const { GithubAuth, AuthError, authConfig, requestOrigin, githubIdentity, clearCookie, SESSION_COOKIE, FLOW_COOKIE } = require("./github-auth");
function headers(res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8"); res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Referrer-Policy", "no-referrer");
}
function send(res, status, value) { res.statusCode = status; res.end(value === undefined ? undefined : JSON.stringify(value)); }
function guard(now) {
  let start = now(), total = 0, active = 0; const counts = new Map();
  return key => {
    if (now() - start >= 60000) { start = now(); total = 0; counts.clear(); }
    const limit = { login: 20, callback: 60, session: 120, logout: 30, dashboard: 120 }[key];
    const count = (counts.get(key) || 0) + 1;
    if (++total > 600 || count > limit || active >= 20) throw new Limited();
    counts.set(key, count); active++; return () => { active--; };
  };
}
function errorResponse(res, error) {
  if (error instanceof Limited) { res.setHeader("Retry-After", "60"); return send(res, 429, { error: "Rate or concurrency limit" }); }
  return send(res, error instanceof AuthError ? error.status : 503, { error: error instanceof AuthError ? "Authentication required or request rejected" : "Authentication unavailable; retry requires a fresh request" });
}
async function readBody(req, max = 32768, allowEmpty = false, signal) {
  signal?.throwIfAborted();
  if (Number(req.headers["content-length"]) > max) throw new AuthError(413);
  let raw;
  if (req.body !== undefined) raw = typeof req.body === "string" || Buffer.isBuffer(req.body) ? req.body : JSON.stringify(req.body);
  else {
    const chunks = []; let size = 0;
    const timer = setTimeout(() => req.destroy?.(), 10000);
    const abort = () => req.destroy?.(); signal?.addEventListener("abort", abort, { once: true });
    try { if (req[Symbol.asyncIterator]) for await (const chunk of req) { signal?.throwIfAborted(); size += Buffer.byteLength(chunk); if (size > max) throw new AuthError(413); chunks.push(Buffer.from(chunk)); } }
    finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
    raw = Buffer.concat(chunks);
  }
  if (Buffer.byteLength(raw) > max) throw new AuthError(413);
  signal?.throwIfAborted();
  if (allowEmpty && !String(raw).trim()) return null;
  try { return JSON.parse(String(raw)); } catch { throw new AuthError(400); }
}
function callbackParams(url) {
  const allowed = ["code", "state", "iss", "error", "error_description", "error_uri"];
  const names = new Set();
  for (const [name, value] of url.searchParams) {
    if (!allowed.includes(name) || names.has(name) || value.length > 512) throw new AuthError();
    names.add(name);
  }
  const params = Object.fromEntries(url.searchParams);
  if ((params.iss !== undefined && params.iss !== ISSUER) || !/^[A-Za-z0-9_-]{43}$/.test(params.state || "")
    || (params.error && params.code) || (!params.error && !/^[A-Za-z0-9_-]{1,512}$/.test(params.code || ""))) throw new AuthError();
  return params;
}
function createAuthHandler({ env = process.env, storeFactory = token => new BlobStore({ token, kind: "auth" }), fetcher = fetch, now = Date.now, githubTimeoutMs = 10000 } = {}) {
  const enter = guard(now);
  return async function handler(req, res) {
    headers(res); let release, action;
    const signal = AbortSignal.timeout(40000);
    try {
      requestOrigin(req);
      if (typeof req.url !== "string" || !req.url.startsWith("/api/auth/") || req.url.length > 4096) throw new AuthError(400);
      const url = new URL(req.url, ORIGIN), match = url.pathname.match(/^\/api\/auth\/(session|login|callback|logout)$/);
      if (!match) return send(res, 404, { error: "Not found" });
      action = match[1];
      if (req.method !== (action === "logout" ? "POST" : "GET")) { res.setHeader("Allow", action === "logout" ? "POST" : "GET"); return send(res, 405, { error: "Method not allowed" }); }
      if (action !== "callback" && url.search) throw new AuthError(400);
      release = enter(action);
      const config = authConfig(env);
      if (action === "session" && !config) return send(res, 200, { enabled: false, authenticated: false, legacyEnabled: false });
      if (!config) throw new AuthError(503);
      if (action === "session") {
        // Malformed/unsigned anonymous cookies never reach storage.
        const { sessionId } = require("./github-auth");
        let id; try { id = sessionId(config, req); } catch (error) { if (!(error instanceof AuthError)) throw error; }
        const auth = id ? new GithubAuth({ config, store: storeFactory(config.token), now }) : null;
        const session = auth && await auth.lookup(req, "session", signal);
        return send(res, 200, { enabled: true, authenticated: Boolean(session), legacyEnabled: false, ...(session ? { csrfToken: session.csrfToken, user: session.user } : {}) });
      }
      if (action === "login" && req.headers["sec-fetch-site"] !== undefined && !["same-origin", "none"].includes(req.headers["sec-fetch-site"])) throw new AuthError(403);
      if (action === "callback") {
        // Reject issuer/duplicates BEFORE even constructing auth storage.
        const params = callbackParams(url);
        const auth = new GithubAuth({ config, store: storeFactory(config.token), now });
        const flow = await auth.consume(params.state, req, signal);
        if (params.error) throw new AuthError();
        await githubIdentity(config, params.code, flow, fetcher, signal, githubTimeoutMs);
        const cookie = await auth.issue(flow, req, signal);
        res.setHeader("Set-Cookie", [clearCookie(FLOW_COOKIE), cookie]); res.setHeader("Location", "/"); return send(res, 303);
      }
      if (action === "logout") {
        const { sessionId, requireCsrf } = require("./github-auth");
        requireCsrf(config, req, sessionId(config, req));
        const body = await readBody(req, 1024, true, signal);
        if (body !== null && (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length)) throw new AuthError(400);
        await new GithubAuth({ config, store: storeFactory(config.token), now }).logout(req, signal);
        res.setHeader("Set-Cookie", [clearCookie(SESSION_COOKIE), clearCookie(FLOW_COOKIE)]); return send(res, 204);
      }
      const result = await new GithubAuth({ config, store: storeFactory(config.token), now }).begin(req, signal);
      res.setHeader("Set-Cookie", result.cookie); res.setHeader("Location", result.url); return send(res, 302);
    } catch (error) {
      if (action === "callback") {
        res.setHeader("Set-Cookie", clearCookie(FLOW_COOKIE)); res.setHeader("Location", "/?login=failed"); return send(res, 303);
      }
      return errorResponse(res, error);
    } finally { release?.(); }
  };
}
module.exports = { createAuthHandler, headers, send, errorResponse, readBody, guard, callbackParams };
