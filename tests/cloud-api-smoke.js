const assert = require("assert");
const stateHandler = require("../api/automation/state");
const statusHandler = require("../api/automation/status");
const snapshotHandler = require("../api/automation/snapshot");

function makeResponse() {
  return {
    headers: {},
    statusCode: 0,
    body: "",
    setHeader(name, value) { this.headers[name] = value; },
    end(value) { this.body = String(value || ""); }
  };
}

async function invoke(handler, request) {
  const response = makeResponse();
  await handler(request, response);
  return { status: response.statusCode, body: JSON.parse(response.body) };
}

async function main() {
  const previousBlobToken = process.env.BLOB_READ_WRITE_TOKEN;
  const previousSyncToken = process.env.HYM_SYNC_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.HYM_SYNC_TOKEN;
  try {
    const state = await invoke(stateHandler, { method: "GET", headers: {} });
    assert.strictEqual(state.status, 200);
    assert.deepStrictEqual(state.body.quotes, []);

    const status = await invoke(statusHandler, { method: "GET", headers: {} });
    assert.strictEqual(status.status, 200);
    assert.strictEqual(status.body.mode, "cloud");
    assert.match(status.body.scheduler.lastError, /尚未收到/);

    const unauthorized = await invoke(snapshotHandler, { method: "POST", headers: {} });
    assert.strictEqual(unauthorized.status, 401);

    process.env.HYM_SYNC_TOKEN = "test-sync-token";
    const invalid = await invoke(snapshotHandler, {
      method: "POST",
      headers: { authorization: "Bearer test-sync-token" },
      body: { schemaVersion: 1, syncedAt: new Date().toISOString(), state: { quotes: [] } }
    });
    assert.strictEqual(invalid.status, 400);
    assert.match(invalid.body.error, /报价数量异常/);
  } finally {
    if (previousBlobToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = previousBlobToken;
    if (previousSyncToken === undefined) delete process.env.HYM_SYNC_TOKEN;
    else process.env.HYM_SYNC_TOKEN = previousSyncToken;
  }
  console.log("cloud api smoke ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
