const fs = require("fs");
const path = require("path");
const { buildCloudSnapshot, validateCloudSnapshot } = require("../lib/cloud-snapshot");

const root = path.resolve(__dirname, "..");

async function main() {
  const configPath = path.join(root, "config", "automation.json");
  const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
  const cloudUrl = String(process.env.HYM_CLOUD_URL || config.cloudSync?.url || "").replace(/\/+$/, "");
  const token = String(process.env.HYM_SYNC_TOKEN || "");
  if (!cloudUrl || !token) {
    process.stdout.write(JSON.stringify({ ok: false, configured: false, message: "未配置 HYM_CLOUD_URL/HYM_SYNC_TOKEN" }));
    return;
  }

  const state = JSON.parse(fs.readFileSync(path.join(root, "data", "state.json"), "utf8"));
  const imported = Number(process.argv[2] || state.quotes?.length || 0);
  const snapshot = validateCloudSnapshot(buildCloudSnapshot(state, { imported }));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(`${cloudUrl}/api/automation/snapshot`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(snapshot),
      signal: controller.signal
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    process.stdout.write(JSON.stringify({ ok: true, configured: true, ...result }));
  } finally {
    clearTimeout(timeout);
  }
}

main().catch((error) => {
  process.stdout.write(JSON.stringify({ ok: false, configured: true, error: error.message }));
  process.exitCode = 1;
});
