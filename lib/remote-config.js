"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { tools } = require("../mcp/remote-schema");
const { defaults } = require("./remote-core");
const hash = (value) => crypto.createHash("sha256").update(value).digest();
function loadConfig(file = process.env.HYM_MCP_CONFIG || path.join(__dirname, "../config/remote-mcp.local.json"), env = process.env) {
  return validateConfig(JSON.parse(fs.readFileSync(file, "utf8")), env);
}

function validateConfig(input, env = process.env) {
  const config = structuredClone(input);
  if (!config.workspaces || !Array.isArray(config.clients) || !config.clients.length || config.clients.length > 20) throw new Error("Invalid MCP config");
  if (config.localImportWorkspace && !config.workspaces[config.localImportWorkspace]) throw new Error("Invalid import workspace");
  const ids = new Set(), tokens = new Set();
  for (const client of config.clients) {
    const token = env[client.tokenEnv];
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(client.id) || ids.has(client.id) || !config.workspaces[client.workspace] || !Array.isArray(client.tools) || client.tools.some((name) => !tools.some((tool) => tool.name === name))) throw new Error("Invalid MCP client scope");
    if (!token || !/^[\x21-\x7e]{32,256}$/.test(token) || tokens.has(token)) throw new Error("Missing, short or reused MCP credential");
    ids.add(client.id); tokens.add(token);
    client.tokenHash = hash(token);
  }
  for (const workspace of Object.values(config.workspaces)) {
    if (!Array.isArray(workspace.sources) || !workspace.sources.length || !Array.isArray(workspace.families) || !workspace.families.length) throw new Error("Explicit source and family allowlists required");
    for (const [key, value] of Object.entries(workspace.policy || {})) {
      if (!Object.hasOwn(defaults, key) || typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 200000) throw new Error("Invalid profit policy");
      if (key.endsWith("Minutes") && (value < 1 || value > 1440)) throw new Error("TTL must be 1..1440 minutes");
    }
  }
  for (const origin of config.allowedOrigins || []) {
    const parsed = new URL(origin);
    const loopback = parsed.protocol === "http:" && ["127.0.0.1", "localhost"].includes(parsed.hostname);
    if (parsed.origin !== origin || (parsed.protocol !== "https:" && !loopback) || parsed.username || parsed.password) throw new Error("Origins must be exact HTTPS or loopback origins");
  }
  if (!Array.isArray(config.allowedHosts) || config.allowedHosts.some((host) => !/^[a-zA-Z0-9.:-]+$/.test(host))) throw new Error("Invalid host allowlist");
  return config;
}

function loadCloudConfig(env = process.env) {
  if (typeof env.HYM_MCP_CONFIG_JSON !== "string" || Buffer.byteLength(env.HYM_MCP_CONFIG_JSON) > 32768) throw new Error("Invalid cloud config");
  const input = JSON.parse(env.HYM_MCP_CONFIG_JSON);
  const plain = (value) => value && typeof value === "object" && !Array.isArray(value);
  if (!plain(input) || Object.keys(input).some((key) => !["clients", "workspaces", "allowedHosts", "allowedOrigins"].includes(key))
    || !plain(input.workspaces) || Object.keys(input.workspaces).length < 1 || Object.keys(input.workspaces).length > 20
    || !Array.isArray(input.clients) || !Array.isArray(input.allowedHosts) || !input.allowedHosts.length || input.allowedHosts.length > 20
    || !Array.isArray(input.allowedOrigins) || input.allowedOrigins.length > 20) throw new Error("Invalid cloud config");
  for (const [id, workspace] of Object.entries(input.workspaces)) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id) || ["__proto__", "constructor", "prototype"].includes(id) || !plain(workspace)
      || Object.keys(workspace).some((key) => !["sources", "families", "policy", "telegramChatEnv"].includes(key))
      || !Array.isArray(workspace.sources) || workspace.sources.length > 50 || !Array.isArray(workspace.families) || workspace.families.length > 50
      || [...workspace.sources, ...workspace.families].some((s) => typeof s !== "string" || !s.trim() || s.length > 100)
      || (workspace.policy !== undefined && !plain(workspace.policy))
      || (workspace.telegramChatEnv !== undefined && workspace.telegramChatEnv !== "HYM_TELEGRAM_CHAT_ID")) throw new Error("Invalid cloud workspace");
  }
  for (const client of input.clients) {
    if (!plain(client) || Object.keys(client).some((key) => !["id", "workspace", "tokenEnv", "tools"].includes(key))
      || !["HYM_GROK_TOKEN", "HYM_DASHBOARD_TOKEN"].includes(client.tokenEnv)
      || !Object.hasOwn(input.workspaces, client.workspace)
      || (client.tokenEnv === "HYM_DASHBOARD_TOKEN" && (!Array.isArray(client.tools) || client.tools.some((name) => name !== "get_status")))) throw new Error("Invalid cloud client");
  }
  for (const host of input.allowedHosts) {
    if (typeof host !== "string" || host !== host.toLowerCase() || host.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?::[0-9]{1,5})?$/.test(host)
      || host.includes("xn--")) throw new Error("Invalid cloud host");
  }
  return validateConfig(input, env);
}

function telegramNotifier(config, env = process.env, fetcher = fetch) {
  const token = env.HYM_TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  if (!/^\d+:[a-zA-Z0-9_-]+$/.test(token)) throw new Error("Invalid Telegram token format");
  const notify = async ({ id, workspace, sku, result }, signal) => {
    const chat = env[config.workspaces[workspace].telegramChatEnv];
    if (!chat || !/^-?\d+$/.test(chat)) throw new Error("Notification destination unavailable");
    const response = await fetcher(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST", redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: `好羊毛：条件已核验，达到利润门槛\n${sku}\n净利润 ¥${result.netProfit}（门槛 ¥${result.minimumProfit}）\n有效至 ${result.validUntil}\n核验 ${id}\n下单前请再次确认价格和库存。` })
    });
    let body = "";
    for await (const chunk of response.body) {
      body += Buffer.from(chunk).toString("utf8");
      if (Buffer.byteLength(body) > 65536) throw new Error("Notification response too large");
    }
    if (!response.ok || JSON.parse(body).ok !== true) throw new Error("Notification delivery not confirmed");
  };
  notify.available = (workspace) => /^-?\d+$/.test(env[config.workspaces[workspace].telegramChatEnv] || "");
  return notify;
}


module.exports = { loadConfig, loadCloudConfig, validateConfig, telegramNotifier, hash };
