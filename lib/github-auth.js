"use strict";
const crypto = require("crypto");
const { BlobStore, Limited } = require("./remote-blob");
const { OWNER_ID, ORIGIN, ISSUER, CALLBACK, FLOW_MS, SESSION_MS } = require("./github-store");
const SESSION_COOKIE = "__Host-hym_session", FLOW_COOKIE = "__Host-hym_flow";
const nonce = () => crypto.randomBytes(32).toString("base64url");
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const same = (a, b) => typeof a === "string" && typeof b === "string" && Buffer.byteLength(a) === Buffer.byteLength(b) && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
class AuthError extends Error { constructor(status = 401) { super("Authentication unavailable"); this.status = status; } }
function authConfig(env) {
  if (env.HYM_GITHUB_LOGIN_ENABLED !== "1" || !/^[A-Za-z0-9_.-]{1,128}$/.test(env.GITHUB_CLIENT_ID || "")
    || !/^[\x21-\x7e]{1,256}$/.test(env.GITHUB_CLIENT_SECRET || "") || !/^[A-Za-z0-9_-]{43,256}$/.test(env.AUTH_SECRET || "")
    || !env.HYM_MCP_BLOB_READ_WRITE_TOKEN || env.HYM_MCP_BLOB_READ_WRITE_TOKEN === env.BLOB_READ_WRITE_TOKEN) return null;
  return { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET, secret: env.AUTH_SECRET, token: env.HYM_MCP_BLOB_READ_WRITE_TOKEN };
}
const mac = (config, purpose, id) => crypto.createHmac("sha256", config.secret).update(`hym-auth-v1:${purpose}:${id}`).digest("base64url");
function cookieValue(config, purpose, id) { return `${id}.${mac(config, purpose, id)}`; }
function cookieId(config, purpose, value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/.test(value)) return null;
  const [id, signature] = value.split("."); return same(signature, mac(config, purpose, id)) ? id : null;
}
function cookies(header) {
  if (header === undefined) return {};
  if (typeof header !== "string" || Buffer.byteLength(header) > 8192) throw new AuthError();
  const values = {};
  for (const entry of header.split(";")) {
    const at = entry.indexOf("="), name = entry.slice(0, at).trim();
    if (![SESSION_COOKIE, FLOW_COOKIE].includes(name)) continue;
    if (Object.hasOwn(values, name)) throw new AuthError();
    values[name] = entry.slice(at + 1).trim();
  }
  return values;
}
function setCookie(name, value, seconds) { return `${name}=${value}; Path=/; Max-Age=${seconds}; HttpOnly; Secure; SameSite=Lax`; }
const clearCookie = name => setCookie(name, "", 0);
const csrfToken = (config, id) => mac(config, "csrf", id);
function requestOrigin(req, required = false) {
  if (req.headers.host !== new URL(ORIGIN).host || (req.headers.origin !== undefined && req.headers.origin !== ORIGIN)
    || (required && req.headers.origin !== ORIGIN)) throw new AuthError(403);
  if (required && req.headers["sec-fetch-site"] !== undefined && req.headers["sec-fetch-site"] !== "same-origin") throw new AuthError(403);
}
function sessionId(config, req) { return cookieId(config, "session", cookies(req.headers.cookie)[SESSION_COOKIE]); }
function requireCsrf(config, req, id) {
  requestOrigin(req, true);
  if (!id || !same(req.headers["x-csrf-token"], csrfToken(config, id))) throw new AuthError(403);
}
function pruneAuth(data, now) {
  data.flows = data.flows.filter(flow => flow.expiresAt > now);
  data.sessions = data.sessions.filter(session => session.expiresAt > now);
  data.rates = data.rates.filter(rate => rate.start > now - 60000);
}
function rate(data, key, now) {
  const limits = { total: 600, login: 20, callback: 20, session: 120, logout: 30, dashboard: 120 };
  for (const name of ["total", key]) {
    let entry = data.rates.find(item => item.key === name);
    if (!entry) { entry = { key: name, start: now, count: 0 }; data.rates.push(entry); }
    if (entry.count >= limits[name]) throw new Limited();
    entry.count++;
  }
}
function cipherKey(config) { return crypto.createHash("sha256").update(`hym-pkce-v1:${config.secret}`).digest(); }
function encryptVerifier(config, stateHash, verifier) {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", cipherKey(config), iv);
  cipher.setAAD(Buffer.from(`${ISSUER}:${CALLBACK}:${config.clientId}:${stateHash}`));
  const content = Buffer.concat([cipher.update(verifier, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), content]).toString("base64url");
}
function decryptVerifier(config, flow) {
  try {
    const bytes = Buffer.from(flow.verifier, "base64url"), decipher = crypto.createDecipheriv("aes-256-gcm", cipherKey(config), bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28)); decipher.setAAD(Buffer.from(`${ISSUER}:${CALLBACK}:${config.clientId}:${flow.hash}`));
    const verifier = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
    if (!/^[A-Za-z0-9_-]{43}$/.test(verifier)) throw new AuthError();
    return verifier;
  } catch { throw new AuthError(); }
}

class GithubAuth {
  constructor({ config, store = new BlobStore({ token: config.token, kind: "auth" }), now = Date.now }) { this.config = config; this.store = store; this.now = now; }
  async begin(req, signal) {
    const config = this.config, state = nonce(), binding = nonce(), verifier = nonce(), stateHash = digest(state);
    const jar = cookies(req.headers.cookie), oldBinding = cookieId(config, "flow", jar[FLOW_COOKIE]), oldId = cookieId(config, "session", jar[SESSION_COOKIE]);
    const createdAt = this.now();
    const flow = { hash: stateHash, bindingHash: digest(binding), verifier: encryptVerifier(config, stateHash, verifier), clientId: config.clientId,
      issuer: ISSUER, callback: CALLBACK, oldSessionHash: oldId ? digest(oldId) : null, createdAt, expiresAt: createdAt + FLOW_MS };
    await this.store.transaction(data => {
      pruneAuth(data, this.now()); rate(data, "login", this.now());
      flow.oldSessionHash = oldId && data.sessions.some(item => item.hash === digest(oldId) && item.createdAt <= this.now()) ? digest(oldId) : null;
      if (oldBinding) data.flows = data.flows.filter(item => item.bindingHash !== digest(oldBinding));
      if (data.flows.length >= 100) throw new Limited();
      data.flows.push(flow);
    }, signal);
    const url = new URL("https://github.com/login/oauth/authorize");
    url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: CALLBACK, state,
      code_challenge: crypto.createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", allow_signup: "false" }).toString();
    return { url: url.href, cookie: setCookie(FLOW_COOKIE, cookieValue(config, "flow", binding), FLOW_MS / 1000) };
  }
  async consume(state, req, signal) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(state || "")) throw new AuthError();
    const binding = cookieId(this.config, "flow", cookies(req.headers.cookie)[FLOW_COOKIE]);
    if (!binding) throw new AuthError();
    const flow = await this.store.transaction(data => {
      pruneAuth(data, this.now()); rate(data, "callback", this.now());
      const found = data.flows.find(item => item.hash === digest(state) && item.bindingHash === digest(binding) && item.createdAt <= this.now()
        && item.clientId === this.config.clientId && item.issuer === ISSUER && item.callback === CALLBACK);
      if (!found) return null;
      data.flows = data.flows.filter(item => item.hash !== found.hash);
      return found;
    }, signal);
    if (!flow) throw new AuthError();
    // Only ACKNOWLEDGED nonce consumption permits an external token exchange.
    return { ...flow, verifier: decryptVerifier(this.config, flow) };
  }
  async issue(flow, req, signal) {
    const id = nonce(), oldId = sessionId(this.config, req), createdAt = this.now();
    await this.store.transaction(data => {
      pruneAuth(data, this.now());
      // A logout that wins while token exchange is in flight must also prevent
      // this consumed flow from rotating/re-establishing the revoked session.
      if (flow.oldSessionHash && !data.sessions.some(item => item.hash === flow.oldSessionHash)) throw new AuthError();
      data.sessions = data.sessions.filter(item => item.hash !== flow.oldSessionHash && (!oldId || item.hash !== digest(oldId)));
      if (data.sessions.length >= 100) throw new Limited();
      data.sessions.push({ hash: digest(id), userId: OWNER_ID, createdAt, expiresAt: createdAt + SESSION_MS });
    }, signal);
    return setCookie(SESSION_COOKIE, cookieValue(this.config, "session", id), SESSION_MS / 1000);
  }
  async lookup(req, key, signal) {
    const id = sessionId(this.config, req);
    if (!id) return null;
    const valid = await this.store.transaction(data => {
      pruneAuth(data, this.now()); rate(data, key, this.now());
      return data.sessions.some(item => item.hash === digest(id) && item.userId === OWNER_ID && item.createdAt <= this.now() && item.expiresAt > this.now());
    }, signal);
    return valid ? { id, csrfToken: csrfToken(this.config, id), user: { login: "koocuu" } } : null;
  }
  async logout(req, signal) {
    const id = sessionId(this.config, req); requireCsrf(this.config, req, id);
    const binding = cookieId(this.config, "flow", cookies(req.headers.cookie)[FLOW_COOKIE]);
    await this.store.transaction(data => {
      pruneAuth(data, this.now()); rate(data, "logout", this.now());
      data.sessions = data.sessions.filter(item => item.hash !== digest(id));
      data.flows = data.flows.filter(item => item.oldSessionHash !== digest(id) && (!binding || item.bindingHash !== digest(binding)));
    }, signal);
  }
}

// Official fixed endpoints only, no configurable URLs or token persistence.
async function githubIdentity(config, code, flow, fetcher = fetch, signal, timeoutMs = 10000) {
  async function json(url, init) {
    const abort = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
    let reader, stop;
    const cancelled = new Promise((_, reject) => { stop = () => reject(new AuthError()); if (abort.aborted) stop(); else abort.addEventListener("abort", stop, { once: true }); });
    try {
      return await Promise.race([cancelled, (async () => {
        const response = await fetcher(url, { ...init, redirect: "error", cache: "no-store", signal: abort });
        if (!response.ok || response.redirected || !response.body || Number(response.headers.get("content-length")) > 32768) throw new AuthError();
        reader = response.body.getReader(); const chunks = []; let size = 0;
        for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 32768) throw new AuthError(); chunks.push(Buffer.from(part.value)); }
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new AuthError();
        return value;
      })()]);
    } catch { throw new AuthError(); }
    finally { abort.removeEventListener("abort", stop); if (reader) { reader.cancel().catch(() => {}); } }
  }
  const token = await json("https://github.com/login/oauth/access_token", { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, code, redirect_uri: CALLBACK, code_verifier: flow.verifier }).toString() });
  if (token.error || typeof token.token_type !== "string" || token.token_type.toLowerCase() !== "bearer" || !/^[A-Za-z0-9_-]{1,2048}$/.test(token.access_token || "")) throw new AuthError();
  const user = await json("https://api.github.com/user", { method: "GET", headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token.access_token}`, "User-Agent": "haoyangmao-login", "X-GitHub-Api-Version": "2022-11-28" } });
  if (user.id !== OWNER_ID) throw new AuthError(403);
  return OWNER_ID; // No token, refresh token, username or provider payload leaves this function.
}
module.exports = { GithubAuth, AuthError, authConfig, cookies, cookieId, setCookie, clearCookie, csrfToken, requestOrigin, sessionId, requireCsrf, githubIdentity, SESSION_COOKIE, FLOW_COOKIE };
