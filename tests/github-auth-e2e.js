"use strict";
const assert = require("assert/strict"), fs = require("fs"), path = require("path"), http = require("http"), crypto = require("crypto");
const { fork } = require("child_process"), { once } = require("events");
const { BlobStore, PATH, Unavailable } = require("../lib/remote-blob");
const { AUTH_PATH, AUTH_BYTES, OWNER_ID, ORIGIN, ISSUER, CALLBACK, FLOW_MS, SESSION_MS, authEmpty, validateAuthState } = require("../lib/github-store");
const { GithubAuth, authConfig, githubIdentity, SESSION_COOKIE, FLOW_COOKIE } = require("../lib/github-auth");
const { createDashboardHandler } = require("../lib/dashboard-handler");
const { empty } = require("../lib/remote-blob");
const random = () => crypto.randomBytes(32).toString("base64url");
async function main() {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, "../config/remote-mcp.example.json"), "utf8"));
  delete config.localImportWorkspace; config.allowedHosts = [new URL(ORIGIN).host]; config.allowedOrigins = [ORIGIN];
  const env = { HYM_GITHUB_LOGIN_ENABLED: "1", HYM_LEGACY_DASHBOARD_ENABLED: "0", GITHUB_CLIENT_ID: "fixture-client", GITHUB_CLIENT_SECRET: random(), AUTH_SECRET: random(),
    HYM_GROK_TOKEN: random(), HYM_DASHBOARD_TOKEN: random(), HYM_MCP_CONFIG_JSON: JSON.stringify(config), HYM_MCP_BLOB_READ_WRITE_TOKEN: "private-fixture-auth-and-checks", BLOB_READ_WRITE_TOKEN: "public-fixture" };
  const records = new Map(); const children = []; let now = Date.now(), reads = 0, writes = 0, tokens = 0, users = 0, userId = OWNER_ID, login = "koocuu", fault = null;
  const accessToken = random(), expectedChallenges = new Map();
  const backend = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk); const body = Buffer.concat(chunks).toString("utf8");
    const json = (value, status = 200) => { const content = JSON.stringify(value); res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(content) }); res.end(content); };
    if (req.url === "/token") {
      tokens++; const fields = new URLSearchParams(body);
      backend.emit("fixture-token-arrived", fields.get("code"));
      assert.equal(req.method, "POST"); assert.equal(fields.get("client_id"), env.GITHUB_CLIENT_ID); assert.equal(fields.get("client_secret"), env.GITHUB_CLIENT_SECRET); assert.equal(fields.get("redirect_uri"), CALLBACK);
      assert.equal(crypto.createHash("sha256").update(fields.get("code_verifier")).digest("base64url"), expectedChallenges.get(fields.get("code")));
      if (fault === "provider_timeout") return setTimeout(() => json({ access_token: accessToken, token_type: "bearer" }), 700);
      if (fault === "provider_pause") return setTimeout(() => json({ access_token: accessToken, token_type: "bearer" }), 80);
      if (fault === "provider_redirect") { res.writeHead(302, { Location: "https://example.invalid/steal" }); res.end(); return; }
      if (fault === "provider_large") return json({ access_token: "x".repeat(33000), token_type: "bearer" });
      if (fault === "provider_error") return json({ error: "private provider payload", access_token: accessToken });
      json({ access_token: accessToken, refresh_token: "fixture-unused", token_type: "bearer" }); return;
    }
    if (req.url === "/user") { users++; assert.equal(req.method, "GET"); assert.equal(req.headers.authorization, `Bearer ${accessToken}`); json({ id: userId, login }); return; }
    const options = JSON.parse(req.headers["x-options"]);
    assert.ok([AUTH_PATH, PATH].includes(options.path)); assert.equal(options.access, "private"); assert.equal(options.token, env.HYM_MCP_BLOB_READ_WRITE_TOKEN);
    const previous = records.get(options.path);
    if (req.method === "GET") {
      reads++; assert.equal(options.useCache, false); assert.equal(options.headers["Accept-Encoding"], "identity");
      if (!previous) { res.writeHead(404); res.end(); return; }
      const content = JSON.stringify(previous.data);
      res.writeHead(200, { etag: fault === "weak" && options.path === AUTH_PATH ? `W/"${previous.rev}"` : `"${previous.rev}"`, "content-length": Buffer.byteLength(content) }); res.end(content); return;
    }
    writes++; assert.equal(options.addRandomSuffix, false); assert.equal(options.multipart, false);
    if (!previous) assert.equal(options.allowOverwrite, false);
    else {
      if (!options.allowOverwrite) { res.writeHead(409); res.end(); return; }
      assert.ok(options.ifMatch); if (options.ifMatch !== `"${previous.rev}"`) { res.writeHead(412); res.end(); return; }
    }
    const next = JSON.parse(body); if (options.path === AUTH_PATH) assert.ok(validateAuthState(next));
    const newSession = next.sessions?.some(session => !previous?.data.sessions.some(old => old.hash === session.hash));
    const rev = (previous?.rev || 0) + 1; records.set(options.path, { data: next, rev });
    if (options.path === AUTH_PATH && (fault === "auth_write_lost" || (fault === "session_write_lost" && newSession))) { fault = null; res.writeHead(503); res.end(); return; }
    res.writeHead(200, { etag: `"${rev}"` }); res.end();
  });
  await new Promise(resolve => backend.listen(0, "127.0.0.1", resolve));
  async function worker(changes = {}) {
    const child = fork(path.join(__dirname, "github-auth-worker.js"), [], { env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP,
      FIXTURE_ENV: JSON.stringify({ ...env, ...changes }), FIXTURE_NOW: String(now), FIXTURE_BACKEND: `http://127.0.0.1:${backend.address().port}` }, stdio: ["ignore", "inherit", "inherit", "ipc"] });
    children.push(child); const [message] = await once(child, "message"); return message.url;
  }
  async function clock(ms) { now += ms; await Promise.all(children.map(async child => { const ack = once(child, "message"); child.send({ now }); await ack; })); }
  async function request(base, pathname, { method = "GET", cookie, csrf, body, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request(`${base}${pathname}`, { method, headers: { Host: new URL(ORIGIN).host, ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { "X-CSRF-Token": csrf } : {}), ...(method === "POST" ? { Origin: ORIGIN, "Content-Type": "application/json" } : {}), ...headers } }, async res => {
        try { const chunks = []; for await (const chunk of res) chunks.push(chunk); const text = Buffer.concat(chunks).toString("utf8"); resolve({ status: res.statusCode, headers: res.headers, text, body: text ? JSON.parse(text) : null }); } catch (error) { reject(error); }
      }); req.on("error", reject); req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  const cookie = (response, name) => [response.headers["set-cookie"] || []].flat().find(value => value.startsWith(`${name}=`))?.split(";")[0];
  async function begin(base, previousCookie) {
    const response = await request(base, "/api/auth/login", { cookie: previousCookie }); assert.equal(response.status, 302);
    const url = new URL(response.headers.location); assert.equal(url.origin + url.pathname, "https://github.com/login/oauth/authorize"); assert.equal(url.searchParams.get("redirect_uri"), CALLBACK);
    assert.equal(url.searchParams.get("code_challenge_method"), "S256"); assert.equal(url.searchParams.has("scope"), false);
    assert.match(response.headers["set-cookie"][0], /Path=\/; Max-Age=600; HttpOnly; Secure; SameSite=Lax/); assert.doesNotMatch(response.headers["set-cookie"][0], /Domain=/);
    return { state: url.searchParams.get("state"), challenge: url.searchParams.get("code_challenge"), cookie: cookie(response, FLOW_COOKIE) };
  }
  async function callback(base, flow, code, extra = "", previousCookie) {
    expectedChallenges.set(code, flow.challenge);
    return request(base, `/api/auth/callback?code=${code}&state=${flow.state}${extra}`, { cookie: [flow.cookie, previousCookie].filter(Boolean).join("; ") });
  }
  const rpc = (method, params, id = 1) => ({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, ...(params === undefined ? {} : { params }) });
  try {
    const a = await worker(), b = await worker();
    const disabled = await worker({ HYM_GITHUB_LOGIN_ENABLED: "0", HYM_LEGACY_DASHBOARD_ENABLED: undefined });
    const initial = { reads, writes };
    assert.deepEqual((await request(disabled, "/api/auth/session")).body, { enabled: false, authenticated: false, legacyEnabled: true });
    assert.deepEqual((await request(a, "/api/auth/session")).body, { enabled: true, authenticated: false, legacyEnabled: false });
    assert.deepEqual({ reads, writes }, initial, "anonymous/config-disabled session polls use zero Blob operations");
    assert.equal((await request(a, "/api/auth/login", { headers: { Host: "alias.vercel.app" } })).status, 403);
    assert.equal((await request(a, "/api/auth/session", { headers: { Origin: "https://evil.example" } })).status, 403);
    assert.equal((await request(a, "/api/auth/login?next=https://evil.example")).status, 400);
    assert.equal((await request(a, "/api/dashboard", { method: "POST", body: rpc("initialize") })).status, 401);

    const flow = await begin(a);
    const beforeInvalid = { reads, writes, tokens, users };
    for (const suffix of [`&iss=${encodeURIComponent("https://github.com")}`, "&state=duplicate", "&code=duplicate", `&iss=${encodeURIComponent(ISSUER)}&iss=${encodeURIComponent(ISSUER)}`, "&unknown=field"]) {
      const failed = await callback(a, flow, "invalid-params", suffix); assert.equal(failed.status, 303); assert.equal(failed.headers.location, "/?login=failed"); assert.ok(!cookie(failed, SESSION_COOKIE));
    }
    assert.deepEqual({ reads, writes, tokens, users }, beforeInvalid, "duplicate/issuer failures precede storage and GitHub calls");
    const success = await callback(b, flow, "first-code", `&iss=${encodeURIComponent(ISSUER)}`);
    assert.equal(success.status, 303); assert.equal(success.headers.location, "/"); const sessionCookie = cookie(success, SESSION_COOKIE); assert.ok(sessionCookie);
    assert.match(success.headers["set-cookie"][1], /Max-Age=28800; HttpOnly; Secure; SameSite=Lax/); assert.equal(success.headers["referrer-policy"], "no-referrer");
    assert.equal(records.get(AUTH_PATH).data.flows.length, 0); assert.equal(records.get(AUTH_PATH).data.sessions.length, 1);
    const stored = JSON.stringify(records.get(AUTH_PATH).data); assert.ok(!stored.includes(accessToken)); assert.ok(!stored.includes("fixture-unused")); assert.ok(!stored.includes(sessionCookie.split("=")[1].split(".")[0]));
    const logged = await request(a, "/api/auth/session", { cookie: sessionCookie }); assert.equal(logged.body.authenticated, true); assert.deepEqual(logged.body.user, { login: "koocuu" }); assert.match(logged.body.csrfToken, /^[A-Za-z0-9_-]{43}$/);
    const beforeBadCookies = { reads, writes };
    const tamperedCookie = sessionCookie.slice(0, -1) + (sessionCookie.endsWith("A") ? "B" : "A");
    for (const invalidCookie of [tamperedCookie, `${sessionCookie}; ${sessionCookie}`, `${SESSION_COOKIE}=unsigned`]) {
      assert.equal((await request(a, "/api/auth/session", { cookie: invalidCookie })).body.authenticated, false);
      assert.equal((await request(a, "/api/dashboard", { method: "POST", cookie: invalidCookie, csrf: logged.body.csrfToken, body: rpc("initialize") })).status, 401);
    }
    assert.deepEqual({ reads, writes }, beforeBadCookies, "forged/duplicate cookies are rejected without Blob operations");
    const beforeReplay = tokens; assert.equal((await callback(a, flow, "first-code")).headers.location, "/?login=failed"); assert.equal(tokens, beforeReplay);

    const dOpts = { method: "POST", cookie: sessionCookie, csrf: logged.body.csrfToken };
    const initialized = await request(a, "/api/dashboard", { ...dOpts, body: rpc("initialize", { protocolVersion: "2025-11-25" }) }); assert.equal(initialized.status, 200);
    assert.equal((await request(a, "/api/dashboard", { ...dOpts, body: { jsonrpc: "2.0", method: "notifications/initialized" } })).status, 202);
    const list = await request(b, "/api/dashboard", { ...dOpts, body: rpc("tools/call", { name: "get_status", arguments: { limit: 50 } }) }); assert.equal(list.status, 200); assert.equal(list.body.result.structuredContent.total, 0);
    assert.ok(!JSON.stringify(list).includes(env.HYM_DASHBOARD_TOKEN));
    const beforeReject = { reads, writes };
    for (const body of [rpc("tools/list"), rpc("tools/call", { name: "void_check", arguments: { checkId: "fake", reason: "fake" } }), rpc("tools/call", { name: "get_status", arguments: { workspace: "fake" } }), { ...rpc("initialize"), url: "https://example.invalid" }]) assert.ok([400, 403].includes((await request(a, "/api/dashboard", { ...dOpts, body })).status));
    assert.equal((await request(a, "/api/dashboard", { ...dOpts, csrf: "wrong", body: rpc("initialize") })).status, 403);
    assert.equal((await request(a, "/api/dashboard", { ...dOpts, headers: { Origin: "https://other.koocuu.com" }, body: rpc("initialize") })).status, 403);
    assert.equal((await request(a, "/api/dashboard", { ...dOpts, headers: { "Sec-Fetch-Site": "same-site" }, body: rpc("initialize") })).status, 403);
    assert.equal((await request(a, "/api/dashboard", { ...dOpts, body: { padding: "x".repeat(33000) } })).status, 413);
    assert.deepEqual({ reads, writes }, beforeReject, "CSRF/Origin/tool/schema/size rejection never accesses storage");
    const mcpOptions = key => ({ method: "POST", headers: { Authorization: `Bearer ${key}`, Accept: "application/json, text/event-stream" }, body: rpc("tools/list") });
    assert.equal((await request(a, "/api/mcp", mcpOptions(env.HYM_DASHBOARD_TOKEN))).status, 401);
    assert.equal((await request(a, "/api/mcp", mcpOptions(env.HYM_GROK_TOKEN))).body.result.tools.length, 7);
    const fallback = await worker({ HYM_LEGACY_DASHBOARD_ENABLED: "1" }); assert.equal((await request(fallback, "/api/mcp", mcpOptions(env.HYM_DASHBOARD_TOKEN))).body.result.tools.length, 1);

    // Login rotates and revokes the browser's previous opaque ID.
    const rotating = await begin(b, sessionCookie); const rotated = await callback(a, rotating, "rotated-code", "", sessionCookie); const newCookie = cookie(rotated, SESSION_COOKIE); assert.notEqual(newCookie, sessionCookie);
    assert.equal((await request(b, "/api/auth/session", { cookie: sessionCookie })).body.authenticated, false);
    const current = await request(b, "/api/auth/session", { cookie: newCookie }); assert.equal(current.body.authenticated, true);
    const pendingLogoutFlow = await begin(a, newCookie);
    assert.equal((await request(a, "/api/auth/logout", { method: "POST", cookie: newCookie, csrf: "wrong" })).status, 403);
    assert.equal((await request(a, "/api/auth/logout", { method: "POST", cookie: `${newCookie}; ${pendingLogoutFlow.cookie}`, csrf: current.body.csrfToken })).status, 204);
    assert.equal((await request(b, "/api/auth/session", { cookie: newCookie })).body.authenticated, false, "copied cookie revoked server-side");
    assert.equal((await request(b, "/api/dashboard", { method: "POST", cookie: newCookie, csrf: current.body.csrfToken, body: rpc("initialize") })).status, 401);
    const afterLogoutTokens = tokens; assert.equal((await callback(b, pendingLogoutFlow, "logout-cancelled-flow")).headers.location, "/?login=failed"); assert.equal(tokens, afterLogoutTokens);

    // Logout also wins if the nonce has already been consumed while the code
    // exchange is in flight, rather than only clearing a browser flow cookie.
    const renewed = await begin(a), renewedResponse = await callback(b, renewed, "before-logout-race"), renewedCookie = cookie(renewedResponse, SESSION_COOKIE);
    const renewedSession = await request(a, "/api/auth/session", { cookie: renewedCookie });
    const inflight = await begin(a, renewedCookie); fault = "provider_pause";
    const exchangeStarted = once(backend, "fixture-token-arrived");
    const inflightCallback = callback(b, inflight, "logout-during-exchange", "", renewedCookie);
    await exchangeStarted;
    assert.equal((await request(a, "/api/auth/logout", { method: "POST", cookie: `${renewedCookie}; ${inflight.cookie}`, csrf: renewedSession.body.csrfToken })).status, 204);
    const rejectedIssue = await inflightCallback; fault = null;
    assert.equal(rejectedIssue.headers.location, "/?login=failed"); assert.ok(!cookie(rejectedIssue, SESSION_COOKIE));
    assert.equal((await request(b, "/api/auth/session", { cookie: renewedCookie })).body.authenticated, false);

    const lostLogoutFlow = await begin(a), lostLogoutSuccess = await callback(b, lostLogoutFlow, "lost-logout-session"), lostLogoutCookie = cookie(lostLogoutSuccess, SESSION_COOKIE);
    const lostLogoutSession = await request(a, "/api/auth/session", { cookie: lostLogoutCookie });
    fault = "auth_write_lost"; const beforeLogoutWrites = writes;
    assert.equal((await request(b, "/api/auth/logout", { method: "POST", cookie: lostLogoutCookie, csrf: lostLogoutSession.body.csrfToken })).status, 503);
    assert.equal(writes, beforeLogoutWrites + 1, "ambiguous logout CAS is not replayed");
    assert.equal((await request(a, "/api/auth/session", { cookie: lostLogoutCookie })).body.authenticated, false);

    // Two independent OS processes can consume one state only once.
    const racing = await begin(a); const tokenCount = tokens;
    const raced = await Promise.all([callback(a, racing, "race-code"), callback(b, racing, "race-code")]); assert.equal(raced.filter(r => r.headers.location === "/").length, 1); assert.equal(tokens, tokenCount + 1);
    const denied = await begin(a); userId = OWNER_ID + 1; login = "koocuu";
    const sessionsBefore = records.get(AUTH_PATH).data.sessions.length; assert.equal((await callback(b, denied, "denied-code")).headers.location, "/?login=failed"); assert.equal(records.get(AUTH_PATH).data.sessions.length, sessionsBefore);
    const stringId = await begin(a); userId = String(OWNER_ID); assert.equal((await callback(b, stringId, "string-id-code")).headers.location, "/?login=failed"); userId = OWNER_ID;
    const renamed = await begin(a); login = "renamed-owner"; assert.equal((await callback(b, renamed, "renamed-code")).headers.location, "/"); login = "koocuu";
    const wrongBrowser = await begin(a), otherBrowser = await begin(b); const beforeMismatch = tokens;
    assert.equal((await callback(a, { ...wrongBrowser, cookie: otherBrowser.cookie }, "wrong-browser")).headers.location, "/?login=failed"); assert.equal(tokens, beforeMismatch);

    // Unknown ACK loss consumes state, but never proceeds to external exchange.
    const uncertain = await begin(a), beforeLost = tokens, writeStart = writes; fault = "auth_write_lost";
    assert.equal((await callback(b, uncertain, "lost-code")).headers.location, "/?login=failed"); assert.equal(tokens, beforeLost); assert.equal(writes, writeStart + 1);
    assert.equal((await callback(a, uncertain, "lost-code")).headers.location, "/?login=failed"); assert.equal(tokens, beforeLost);
    const lostSession = await begin(a); fault = "session_write_lost";
    const lostResponse = await callback(b, lostSession, "session-lost-code"); assert.equal(lostResponse.headers.location, "/?login=failed"); assert.ok(!cookie(lostResponse, SESSION_COOKIE));
    const afterSessionLost = tokens; await callback(a, lostSession, "session-lost-code"); assert.equal(tokens, afterSessionLost);
    await clock(60000);
    for (const mode of ["provider_redirect", "provider_large", "provider_error", "provider_timeout"]) {
      const f = await begin(a); fault = mode; const failed = await callback(b, f, mode); assert.equal(failed.headers.location, "/?login=failed"); assert.ok(!cookie(failed, SESSION_COOKIE)); assert.ok(!JSON.stringify(failed).includes(accessToken)); fault = null;
    }
    const expiring = await begin(a); await clock(FLOW_MS + 1); const countBeforeExpiry = tokens;
    assert.equal((await callback(b, expiring, "expired-code")).headers.location, "/?login=failed"); assert.equal(tokens, countBeforeExpiry);
    const fresh = await begin(a), freshResult = await callback(b, fresh, "ttl-code"), ttlCookie = cookie(freshResult, SESSION_COOKIE);
    assert.equal((await request(a, "/api/auth/session", { cookie: ttlCookie })).body.authenticated, true);
    const configOff = await worker({ GITHUB_CLIENT_SECRET: undefined }); assert.equal((await request(configOff, "/api/auth/session", { cookie: ttlCookie })).body.enabled, false);
    const rotatedSecret = await worker({ AUTH_SECRET: random() }); assert.equal((await request(rotatedSecret, "/api/auth/session", { cookie: ttlCookie })).body.authenticated, false);
    fault = "weak"; assert.equal((await request(a, "/api/auth/session", { cookie: ttlCookie })).status, 503); fault = null;
    await clock(SESSION_MS + 1); assert.equal((await request(a, "/api/auth/session", { cookie: ttlCookie })).body.authenticated, false);

    await clock(60000);
    for (let n = 0; n < 20; n++) assert.equal((await request(n % 2 ? a : b, "/api/auth/login")).status, 302);
    assert.equal((await request(a, "/api/auth/login")).status, 429, "login rate is persisted across OS instances");
    assert.equal(validateAuthState({ ...authEmpty(), sessions: Array(101).fill({}) }), false);
    assert.equal(validateAuthState({ ...authEmpty(), flows: [{ hash: random() }] }), false);
    assert.ok(records.get(PATH), "business uses separate unchanged checks file");
    assert.equal(records.get(PATH).data.checks.length, 0); assert.equal(records.get(PATH).data.notices.length, 0);
    console.log("GitHub auth OS E2E ok: canonical/ID-only/PKCE/issuer/duplicates/state single-use/CAS ACK loss/rotation/revocation/CSRF/session TTL/limits; cookie dashboard only get_status; legacy-off does not affect Grok; anonymous session zero Blob; no real providers/data");
  } finally {
    for (const child of children) if (child.connected) child.send({ stop: true });
    await Promise.all(children.map(child => child.exitCode === null ? once(child, "exit") : Promise.resolve())); backend.close(); backend.closeAllConnections();
  }
  await storeContract(env);
  await deadlineContract(env);
}
async function deadlineContract(env) {
  const config = authConfig(env), data = authEmpty();
  const authStore = { async transaction(mutate) { return mutate(data); } };
  const auth = new GithubAuth({ config, store: authStore });
  const cookie = (await auth.issue({ oldSessionHash: null }, { headers: {} })).split(";")[0];
  const logged = await auth.lookup({ headers: { cookie } }, "session");
  let authSignal, operations = 0, bodyFinished = false, releaseFinished = false, responseClosed = false;
  authStore.transaction = async (mutate, signal) => { assert.equal(bodyFinished, true); authSignal = signal; return mutate(data); };
  const business = empty();
  const store = {
    async transaction(mutate, signal) {
      if (++operations === 1) { assert.equal(signal, authSignal); return mutate(business); }
      if (operations === 2) {
        assert.equal(signal, authSignal, "auth lookup and remote business share the very same deadline");
        await new Promise((resolve, reject) => { const keepAlive = setTimeout(resolve, 500); signal.addEventListener("abort", () => { clearTimeout(keepAlive); reject(new Error("fixture deadline reached")); }, { once: true }); });
        throw new Error("deadline did not stop work");
      }
      assert.notEqual(signal, authSignal, "cleanup receives its bounded reserve after expiry");
      await new Promise(resolve => setTimeout(resolve, 5)); const result = mutate(business); releaseFinished = true; return result;
    }
  };
  const handler = createDashboardHandler({ env, authStoreFactory: () => authStore, storeFactory: () => store, requestTimeoutMs: 200 });
  const req = { method: "POST", url: "/api/dashboard", headers: { host: new URL(ORIGIN).host, origin: ORIGIN, cookie, "x-csrf-token": logged.csrfToken, "content-type": "application/json" },
    async *[Symbol.asyncIterator]() { await new Promise(resolve => setTimeout(resolve, 10)); bodyFinished = true; yield JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_status", arguments: {} } }); } };
  let status;
  let cleanupAtResponse;
  await handler(req, { setHeader() {}, set statusCode(value) { status = value; }, end() { cleanupAtResponse = releaseFinished; responseClosed = true; } });
  assert.equal(operations, 3, `expected acquire/business/release; status=${status}, bodyFinished=${bodyFinished}`);
  assert.equal(cleanupAtResponse, true);
  assert.equal(status, 503); assert.equal(responseClosed, true); assert.equal(business.leases.length, 0);
  console.log("dashboard deadline ok: bounded body/auth/business share one deadline; awaited cleanup reserve completes before response, no lease leak");
}
async function storeContract(env) {
  const sdkTypes = require("@vercel/blob"); let writes = 0, snapshot = null;
  const sdk = { BlobError: sdkTypes.BlobError, BlobPreconditionFailedError: sdkTypes.BlobPreconditionFailedError,
    get: async (pathname, opts) => { assert.equal(pathname, AUTH_PATH); assert.equal(opts.useCache, false); assert.equal(opts.headers["Accept-Encoding"], "identity"); return snapshot; },
    put: async (pathname, body, opts) => { writes++; assert.equal(pathname, AUTH_PATH); assert.ok(validateAuthState(JSON.parse(body))); assert.equal(opts.allowOverwrite, false); return { etag: '"auth"' }; } };
  const store = new BlobStore({ token: "fixture", sdk, kind: "auth" });
  assert.deepEqual((await store.read()).data, authEmpty());
  let tick = Date.now(); const auth = new GithubAuth({ config: authConfig(env), store, now: () => ++tick });
  await auth.begin({ headers: {} }); assert.equal(writes, 1, "captured timestamps support a real advancing clock");
  snapshot = { statusCode: 200, blob: { etag: '"auth"', size: 1 }, stream: new Response(JSON.stringify({ ...authEmpty(), sessions: [{ userId: OWNER_ID }] })).body };
  await assert.rejects(store.read(), Unavailable);
  snapshot = { statusCode: 200, blob: { etag: '"auth"', size: AUTH_BYTES + 1 }, stream: new Response("{}").body }; await assert.rejects(store.read(), Unavailable);
  assert.throws(() => new BlobStore({ token: "fixture", sdk, kind: "client-controlled-path" }), Unavailable);
  const bogusConfig = { ...env, HYM_GITHUB_LOGIN_ENABLED: undefined }; assert.equal(authConfig(bogusConfig), null);
  let called = 0;
  await assert.rejects(githubIdentity(authConfig(env), "fixture", { verifier: random() }, async () => { called++; return new Response(JSON.stringify({ token_type: "not-bearer", access_token: random() })); }), /Authentication/);
  assert.equal(called, 1);
  console.log("auth Blob descriptor ok: fixed private path/strict shape/bytes/advancing-clock TTL/strong ETag/exclusive CAS; no client-selectable store or GitHub token persistence");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
