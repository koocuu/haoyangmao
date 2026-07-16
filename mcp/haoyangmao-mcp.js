#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  loadState,
  parseLeadLine,
  parseQuoteLine,
  parseRecyclerOcrText
} = require("../automation-server");

const root = path.join(__dirname, "..");
const statePath = path.join(root, "data", "state.json");
const screenshotDir = path.join(root, "data", "screenshots");

let inputBuffer = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  processMessages();
});

function processMessages() {
  while (true) {
    const headerEnd = inputBuffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;

    const header = inputBuffer.slice(0, headerEnd).toString("utf8");
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      inputBuffer = Buffer.alloc(0);
      return;
    }

    const length = Number(match[1]);
    const messageStart = headerEnd + 4;
    const messageEnd = messageStart + length;
    if (inputBuffer.length < messageEnd) return;

    const raw = inputBuffer.slice(messageStart, messageEnd).toString("utf8");
    inputBuffer = inputBuffer.slice(messageEnd);
    handleMessage(JSON.parse(raw)).catch((error) => {
      sendError(null, -32603, error.message);
    });
  }
}

async function handleMessage(message) {
  if (message.method === "initialize") {
    sendResult(message.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "haoyangmao-automation", version: "0.1.0" }
    });
    return;
  }

  if (message.method === "tools/list") {
    sendResult(message.id, {
      tools: [
        {
          name: "capture_active_window",
          description: "截取当前前台窗口，适合你先打开小鸽/踏浪小程序或微信群窗口后抓图。",
          inputSchema: {
            type: "object",
            properties: {
              label: { type: "string", description: "截图标签，如 xiaoge-iphone16" }
            }
          }
        },
        {
          name: "capture_screen",
          description: "截取全屏，适合多窗口调试或无法定位窗口时使用。",
          inputSchema: {
            type: "object",
            properties: {
              label: { type: "string", description: "截图标签" }
            }
          }
        },
        {
          name: "import_quote_text",
          description: "导入 OCR 或复制得到的报价文本，自动解析小鸽/踏浪/贩子报价。",
          inputSchema: {
            type: "object",
            properties: {
              text: { type: "string" },
              fallbackSource: { type: "string" }
            },
            required: ["text"]
          }
        },
        {
          name: "import_lead_text",
          description: "导入 OCR 或复制得到的羊毛线索文本。",
          inputSchema: {
            type: "object",
            properties: {
              text: { type: "string" },
              source: { type: "string" }
            },
            required: ["text"]
          }
        },
        {
          name: "ocr_image_openai",
          description: "使用 OPENAI_API_KEY 对截图做 OCR。没有 key 时会返回配置提示。",
          inputSchema: {
            type: "object",
            properties: {
              imagePath: { type: "string" }
            },
            required: ["imagePath"]
          }
        },
        {
          name: "read_state",
          description: "读取当前自动化状态。",
          inputSchema: { type: "object", properties: {} }
        }
      ]
    });
    return;
  }

  if (message.method === "tools/call") {
    const { name, arguments: args = {} } = message.params || {};
    const result = await callTool(name, args);
    sendResult(message.id, {
      content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }]
    });
    return;
  }

  if (message.method === "notifications/initialized") return;
  sendError(message.id, -32601, `Unknown method: ${message.method}`);
}

async function callTool(name, args) {
  if (name === "capture_active_window") {
    return capture("capture-active-window.ps1", args.label || "active-window");
  }
  if (name === "capture_screen") {
    return capture("capture-screen.ps1", args.label || "screen");
  }
  if (name === "import_quote_text") {
    return importQuoteText(args.text, args.fallbackSource || "OCR");
  }
  if (name === "import_lead_text") {
    return importText(args.text, "lead", args.source || "OCR");
  }
  if (name === "ocr_image_openai") {
    return ocrImageOpenAI(args.imagePath);
  }
  if (name === "read_state") {
    return summarize(loadState());
  }
  throw new Error(`Unknown tool: ${name}`);
}

function capture(scriptName, label) {
  fs.mkdirSync(screenshotDir, { recursive: true });
  const safeLabel = String(label).replace(/[^a-z0-9\u4e00-\u9fa5_-]+/gi, "-").slice(0, 48);
  const outputPath = path.join(screenshotDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${safeLabel}.png`);
  const scriptPath = path.join(root, "scripts", scriptName);
  const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-OutputPath", outputPath], {
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "capture failed");
  }
  return { imagePath: outputPath, note: "截图已保存，可继续调用 ocr_image_openai 或人工 OCR 后 import_quote_text。" };
}

function importText(text, kind, source) {
  const state = loadState();
  const lines = String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const imported = [];

  for (const line of lines) {
    const item = kind === "quote" ? parseQuoteLine(line, source) : parseLeadLine(line, source);
    if (!item) continue;
    const list = kind === "quote" ? state.quotes : state.leads;
    if (!list.some((existing) => existing.id === item.id)) {
      list.unshift(item);
      imported.push(item);
    }
  }

  saveState(state);
  return { kind, imported: imported.length, items: imported, state: summarize(state) };
}

function importQuoteText(text, source) {
  const state = loadState();
  const imported = [];
  const tableQuotes = parseRecyclerOcrText(text, { fallbackSource: source });

  for (const quote of tableQuotes) {
    if (!state.quotes.some((existing) => existing.id === quote.id)) {
      state.quotes.unshift(quote);
      imported.push(quote);
    }
  }

  const lines = String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const quote = parseQuoteLine(line, source);
    if (!quote) continue;
    if (!state.quotes.some((existing) => existing.id === quote.id)) {
      state.quotes.unshift(quote);
      imported.push(quote);
    }
  }

  saveState(state);
  return { kind: "quote", imported: imported.length, items: imported, state: summarize(state) };
}

async function ocrImageOpenAI(imagePath) {
  if (!process.env.OPENAI_API_KEY) {
    return {
      error: "OPENAI_API_KEY 未配置",
      next: "配置后可用此工具识别截图；或先用其他 OCR 工具转成文本，再调用 import_quote_text。"
    };
  }

  const absolutePath = path.isAbsolute(imagePath) ? imagePath : path.join(root, imagePath);
  const image = fs.readFileSync(absolutePath);
  const ext = path.extname(absolutePath).toLowerCase();
  const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";
  const dataUrl = `data:${mime};base64,${image.toString("base64")}`;

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: process.env.OPENAI_VISION_MODEL || "gpt-4.1-mini",
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: "请只提取截图中的商品型号、版本、容量、颜色、成色、回收/出售报价、来源名称和时间。输出每条一行，适合机器解析。"
            },
            { type: "input_image", image_url: dataUrl }
          ]
        }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(`OpenAI OCR failed: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  const text = extractResponseText(data);
  return { imagePath: absolutePath, text };
}

function extractResponseText(data) {
  if (data.output_text) return data.output_text;
  const parts = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (content.text) parts.push(content.text);
    }
  }
  return parts.join("\n").trim();
}

function saveState(state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function summarize(state) {
  return {
    leads: state.leads.length,
    quotes: state.quotes.length,
    runs: state.runs.length,
    lastLead: state.leads[0] || null,
    lastQuote: state.quotes[0] || null
  };
}

function sendResult(id, result) {
  writeMessage({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  writeMessage({ jsonrpc: "2.0", id, error: { code, message } });
}

function writeMessage(message) {
  const json = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`);
}
