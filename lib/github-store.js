"use strict";
// Internal fixed descriptor. Neither pathname nor validators come from requests.
const AUTH_PATH = "haoyangmao-mcp/auth-state-v1.json";
const AUTH_BYTES = 256 * 1024;
const OWNER_ID = 68145231;
const ORIGIN = "https://haoyangmao.koocuu.com";
const ISSUER = "https://github.com/login/oauth";
const CALLBACK = `${ORIGIN}/api/auth/callback`;
const FLOW_MS = 600000, SESSION_MS = 8 * 3600000;
const authEmpty = () => ({ version: 1, type: "hym-auth-v1", flows: [], sessions: [], rates: [] });
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const keys = (value, names) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === names.length && names.every(key => Object.hasOwn(value, key));
const times = (entry, ttl) => Number.isSafeInteger(entry.createdAt) && entry.createdAt >= 0 && entry.expiresAt === entry.createdAt + ttl;
function validateAuthState(data) {
  if (!keys(data, ["version", "type", "flows", "sessions", "rates"]) || data.version !== 1 || data.type !== "hym-auth-v1"
    || ![data.flows, data.sessions, data.rates].every(Array.isArray) || data.flows.length > 100 || data.sessions.length > 100 || data.rates.length > 6) return false;
  if (!data.flows.every(flow => keys(flow, ["hash", "bindingHash", "verifier", "clientId", "issuer", "callback", "oldSessionHash", "createdAt", "expiresAt"])
    && hash(flow.hash) && hash(flow.bindingHash) && typeof flow.verifier === "string" && /^[A-Za-z0-9_-]{95}$/.test(flow.verifier) && typeof flow.clientId === "string" && /^[A-Za-z0-9_.-]{1,128}$/.test(flow.clientId)
    && flow.issuer === ISSUER && flow.callback === CALLBACK && (flow.oldSessionHash === null || hash(flow.oldSessionHash)) && times(flow, FLOW_MS))) return false;
  if (!data.sessions.every(session => keys(session, ["hash", "userId", "createdAt", "expiresAt"]) && hash(session.hash) && session.userId === OWNER_ID && times(session, SESSION_MS))) return false;
  if (!data.rates.every(rate => keys(rate, ["key", "start", "count"]) && ["total", "login", "callback", "session", "logout", "dashboard"].includes(rate.key)
    && Number.isSafeInteger(rate.start) && rate.start >= 0 && Number.isInteger(rate.count) && rate.count >= 1 && rate.count <= 600)) return false;
  return [data.flows, data.sessions, data.rates].every((items, index) => new Set(items.map(item => index === 2 ? item.key : item.hash)).size === items.length);
}
module.exports = { AUTH_PATH, AUTH_BYTES, OWNER_ID, ORIGIN, ISSUER, CALLBACK, FLOW_MS, SESSION_MS, authEmpty, validateAuthState };
