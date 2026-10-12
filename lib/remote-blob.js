"use strict";
const crypto = require("crypto");
const { setTimeout: backoff } = require("node:timers/promises");
const { CheckCore, evaluate, policyFor } = require("./remote-core");
const PATH = "haoyangmao-mcp/private-state-v1.json";
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_ATTEMPTS = 5;
const empty = () => ({ version: 1, checks: [], receipts: [], notices: [], rates: [], leases: [] });
class Conflict extends Error {}
class Unavailable extends Error {}
class Limited extends Error {}

// SDK 2.6.1 otherwise retries ambiguous network/5xx writes internally. Disable
// that process-wide behavior before using it; only confirmed CAS conflicts retry.
function sdkOnce() {
  process.env.VERCEL_BLOB_RETRIES = "0";
  return require("@vercel/blob");
}
class BlobStore {
  constructor({ token, sdk = sdkOnce() }) {
    if (!token) throw new Unavailable("Private storage unavailable");
    this.token = token; this.sdk = sdk;
  }
  async read(signal) {
    try { return await this.readSnapshot(signal); }
    catch { throw new Unavailable("Private storage unavailable"); }
  }
  async readSnapshot(signal) {
    const result = await this.sdk.get(PATH, { access: "private", token: this.token, useCache: false, abortSignal: signal });
    if (result === null) return { data: empty(), etag: null };
    if (result.statusCode !== 200 || !result.blob.etag || result.blob.size > MAX_BYTES) throw new Unavailable("Private storage unavailable");
    const chunks = []; let size = 0;
    for await (const chunk of result.stream) {
      size += chunk.byteLength;
      if (size > MAX_BYTES) throw new Unavailable("Private storage capacity reached");
      chunks.push(Buffer.from(chunk));
    }
    const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (data.version !== 1 || ![data.checks, data.receipts, data.notices, data.rates, data.leases].every(Array.isArray)
      || data.checks.length > 200 || data.receipts.length > 5000 || data.notices.length > 10000
      || data.rates.length > 21 || data.leases.length > 20) throw new Unavailable("Invalid private storage");
    return { data, etag: result.blob.etag };
  }
  async write(data, etag, signal) {
    const body = JSON.stringify(data);
    if (Buffer.byteLength(body) > MAX_BYTES) throw new Unavailable("Private storage capacity reached");
    try {
      const result = await this.sdk.put(PATH, body, {
        access: "private", token: this.token, addRandomSuffix: false,
        // Fixed-path create is exclusive; existing objects ALWAYS require ETag.
        allowOverwrite: etag !== null, ...(etag !== null ? { ifMatch: etag } : {}),
        contentType: "application/json", cacheControlMaxAge: 60,
        multipart: false, abortSignal: signal
      });
      if (!result.etag) throw new Unavailable("Write outcome unknown");
    } catch (error) {
      if (error instanceof this.sdk.BlobPreconditionFailedError) throw new Conflict();
      // SDK maps the API's explicit exclusive-create rejection to BlobError.
      // Exact, known rejection only; timeout/unknown/bad-request NEVER retry.
      if (etag === null && error instanceof this.sdk.BlobError && error.message ===
        "Vercel Blob: This blob already exists, use `allowOverwrite: true` if you want to overwrite it. Or `addRandomSuffix: true` to generate a unique filename.") throw new Conflict();
      throw new Unavailable("Write outcome unknown; do not automatically retry");
    }
  }
  async transaction(mutate, signal) {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      signal?.throwIfAborted();
      const { data, etag } = await this.read(signal);
      const value = await mutate(data);
      try { await this.write(data, etag, signal); return value; }
      catch (error) {
        if (!(error instanceof Conflict)) throw error;
        if (attempt === MAX_ATTEMPTS - 1) throw new Unavailable("Storage busy; confirmed contention");
        await backoff(10 + crypto.randomInt(30) * (attempt + 1), undefined, { signal });
      }
    }
  }
}

// Every transaction gets its own core and snapshot. No in-process/cloud locks.
class StagedCore extends CheckCore {
  constructor(options) { super(options); this.effects = []; }
  save() {} // The enclosing Blob CAS commits submission, receipt and notice together.
  async maybeNotify(check) {
    const result = evaluate(check, policyFor(this.config, check.workspace), this.now());
    if (result.status !== "eligible") return;
    const previous = this.data.notices.find((item) => item.identity === check.identity);
    if (previous) {
      check.notification = { status: previous.status, attemptedAt: new Date(previous.at).toISOString() };
      return;
    }
    if (!this.notify || !this.notify.available(check.workspace)) { check.notification = { status: "not_configured" }; return; }
    if (this.data.notices.length >= 10000) throw new Error("Notification capacity reached");
    const notice = { identity: check.identity, at: this.now(), status: "delivery_unknown", attemptId: crypto.randomUUID() };
    this.data.notices.push(notice);
    check.notification = { status: notice.status, attemptedAt: new Date(notice.at).toISOString() };
    this.effects.push({ ...notice, id: check.id, workspace: check.workspace, sku: check.lead.sku, result });
  }
}

class CloudChecks {
  constructor({ config, store, notify = null, now = Date.now }) {
    this.config = config; this.store = store; this.notify = notify; this.now = now;
  }
  async acquire(principal, signal) {
    const id = crypto.randomUUID();
    await this.store.transaction((data) => {
      const now = this.now();
      data.rates = data.rates.filter((item) => item.start > now - 60000);
      data.leases = data.leases.filter((item) => item.until > now);
      for (const [key, max] of [["*", 600], [principal.id, 120]]) {
        let rate = data.rates.find((item) => item.key === key);
        if (!rate) { rate = { key, start: now, count: 0 }; data.rates.push(rate); }
        if (rate.count >= max) throw new Limited("Rate limit");
        rate.count++;
      }
      if (data.leases.length >= 20) throw new Limited("Server busy");
      data.leases.push({ id, until: now + 60000 });
    }, signal);
    return id;
  }
  async release(id, signal) {
    try { await this.store.transaction((data) => { data.leases = data.leases.filter((lease) => lease.id !== id); }, signal); }
    catch { /* If the outcome is unknown, lease expires; never replay effects. */ }
  }
  async call(principal, name, args, signal) {
    const committed = await this.store.transaction(async (data) => {
      const core = new StagedCore({ config: this.config, data, notify: this.notify, now: this.now });
      const result = await core.call(principal, name, args);
      // Only a submission (including replay) may claim one still-valid notice.
      // Read-only dashboard tools never initiate external side effects.
      if (!core.effects.length && ["submit_lead", "submit_quote"].includes(name)) {
        await core.maybeNotify(core.find(principal, result.id));
      }
      return { result, effects: core.effects };
    }, signal);
    for (const effect of committed.effects) {
      // Only this invocation's ACKNOWLEDGED successful reservation owns sending.
      // A lost write response leaves delivery_unknown and no sending/reclaim.
      if (signal?.aborted || Date.parse(effect.result.validUntil) <= this.now()) continue;
      let status = "delivery_unknown";
      try {
        const { data } = await this.store.read(signal);
        const check = data.checks.find((item) => item.id === effect.id && item.workspace === effect.workspace);
        const current = check && evaluate(check, policyFor(this.config, check.workspace), this.now());
        if (!data.notices.some((item) => item.attemptId === effect.attemptId && item.status === "delivery_unknown")
          || current?.status !== "eligible" || current.quoteId !== effect.result.quoteId) continue;
        await this.notify({ ...effect, result: current }, signal); status = "sent";
      } catch { /* never retry delivery or uncertain pre-send read */ }
      try {
        await this.store.transaction((data) => {
          const notice = data.notices.find((item) => item.attemptId === effect.attemptId);
          if (!notice) return;
          notice.status = status;
          for (const check of data.checks.filter((item) => item.identity === notice.identity)) {
            check.notification = { status, attemptedAt: new Date(notice.at).toISOString() };
          }
        }, signal);
        // Keep the returned submission's notification status coherent.
        if (committed.result.id === effect.id) committed.result.notification = { status, attemptedAt: new Date(effect.at).toISOString() };
      } catch { /* Conservatively report the persisted reservation as unknown. */ }
    }
    // Reflect fresh evaluation/notification even on reads and idempotent replay.
    const { data } = await this.store.read(signal);
    const core = new StagedCore({ config: this.config, data, now: this.now });
    if (committed.result.id) {
      const check = core.find(principal, committed.result.id);
      return { ...core.view(principal, check), ...(committed.result.submissionId ? { submissionId: committed.result.submissionId, replayed: committed.result.replayed } : {}) };
    }
    // Read methods do not carry submission metadata.
    return core.call(principal, name, args);
  }
}
module.exports = { BlobStore, CloudChecks, Conflict, Unavailable, Limited, PATH, MAX_BYTES, empty };
