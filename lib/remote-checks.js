"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { CheckCore, defaults, evaluate, project, policyFor } = require("./remote-core");
const { extractSkuFactsV2 } = require("./deal-engine");
const { loadState } = require("../automation-server");
const DAY = 86400000;
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
const defaultFile = path.join(__dirname, "../data/private/remote-checks.json");
function readStore(file = defaultFile) {
  try {
    if (fs.statSync(file).size > 32 * 1024 * 1024) throw new Error("Remote store size limit");
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (data.version !== 1 || !Array.isArray(data.checks) || !Array.isArray(data.receipts) || !Array.isArray(data.notices)) throw new Error("Invalid remote store");
    return data;
  } catch (error) {
    if (error.code === "ENOENT") return { version: 1, checks: [], receipts: [], notices: [] };
    throw error; // Never reset corrupted state: that could resend notifications.
  }
}
function saveStore(file, data) {
  const json = JSON.stringify(data);
  if (Buffer.byteLength(json) > 32 * 1024 * 1024) throw new Error("Remote store size limit");
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temp, "wx", 0o600);
  try { fs.writeFileSync(fd, json); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(temp, file); } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
class CheckService extends CheckCore {
  constructor({ config, file = defaultFile, notify = null, now = Date.now }) {
    super({ config, data: null, notify, now });
    this.file = file;
    this.notify = notify;
    this.now = now;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.lock = `${file}.lock`;
    this.lockFd = fs.openSync(this.lock, "wx", 0o600);
    fs.writeFileSync(this.lockFd, String(process.pid));
    try { this.data = readStore(file); } catch (error) { this.close(); throw error; }
  }
  close() {
    if (this.lockFd !== undefined) { fs.closeSync(this.lockFd); fs.unlinkSync(this.lock); this.lockFd = undefined; }
  }
  save() {
    if (this.failed) throw new Error("Store unavailable");
    try { saveStore(this.file, this.data); } catch (error) { this.failed = true; throw error; }
  }
  importPending() {
    const workspace = this.config.localImportWorkspace;
    if (!workspace) return;
    const allowed = this.config.workspaces[workspace];
    for (const lead of loadState().leads.slice(0, 200)) {
      if (Date.parse(lead.createdAt) < this.now() - 7 * DAY || !Number.isFinite(Date.parse(lead.createdAt))) continue;
      const facts = extractSkuFactsV2(lead.rawText);
      if (!allowed.families.includes(facts.family)) continue;
      const opportunityKey = `local:${lead.id}`;
      const id = `check-${digest(`${workspace}:${opportunityKey}`).slice(0, 24)}`;
      if (this.data.checks.some((check) => check.id === id) || this.data.checks.length >= 200) continue;
      this.data.checks.push({ id, workspace, identity: null, opportunityKey, pendingText: String(lead.rawText).slice(0, 4000), createdAt: lead.createdAt, updatedAt: lead.createdAt, quotes: [], notification: { status: "not_sent" } });
    }
  }
}

module.exports = { CheckService, defaults, defaultFile, readStore, evaluate, project, policyFor };
