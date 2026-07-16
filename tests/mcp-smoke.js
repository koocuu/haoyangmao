const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const root = path.join(__dirname, "..");
const statePath = path.join(root, "data", "state.json");
const originalState = fs.existsSync(statePath) ? fs.readFileSync(statePath, "utf8") : null;
const child = spawn(process.execPath, [path.join(root, "mcp", "haoyangmao-mcp.js")], {
  cwd: root,
  stdio: ["pipe", "pipe", "pipe"]
});

let buffer = Buffer.alloc(0);
let nextId = 1;
const pending = new Map();

child.stdout.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;
    const header = buffer.slice(0, headerEnd).toString("utf8");
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) throw new Error(`bad header: ${header}`);
    const length = Number(match[1]);
    const start = headerEnd + 4;
    const end = start + length;
    if (buffer.length < end) return;
    const message = JSON.parse(buffer.slice(start, end).toString("utf8"));
    buffer = buffer.slice(end);
    const resolver = pending.get(message.id);
    if (resolver) {
      pending.delete(message.id);
      resolver(message);
    }
  }
});

function send(method, params) {
  const id = nextId++;
  const message = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  child.stdin.write(`Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`MCP request timed out: ${method}`));
    }, 5000);
    pending.set(id, (message) => {
      clearTimeout(timeout);
      resolve(message);
    });
  });
}

(async () => {
  const init = await send("initialize", {});
  assert.strictEqual(init.result.serverInfo.name, "haoyangmao-automation");

  const tools = await send("tools/list", {});
  assert.ok(tools.result.tools.some((tool) => tool.name === "import_quote_text"));

  const imported = await send("tools/call", {
    name: "import_quote_text",
    arguments: { text: "小鸽 iPhone 16 256G 国行 全新未激活 5730" }
  });
  assert.ok(imported.result.content[0].text.includes("\"imported\": 1"));

  child.kill();
  restoreState();
  console.log("mcp smoke ok");
  process.exit(0);
})().catch((error) => {
  child.kill();
  restoreState();
  console.error(error);
  process.exit(1);
});

function restoreState() {
  if (originalState === null) {
    try {
      fs.unlinkSync(statePath);
    } catch (error) {}
  } else {
    fs.writeFileSync(statePath, originalState, "utf8");
  }
}
