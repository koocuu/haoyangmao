const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");
const { parseRecyclerOcrText, parseXiaogeOcrLayout } = require("./lib/quote-ocr-parser");
const {
  dedupeQuoteKey,
  enrichQuote,
  preferQuote,
  quoteIdentityKey,
  shouldKeepQuote
} = require("./lib/quote-cleaner");

const root = __dirname;
const port = Number(process.env.PORT || 8765);
const host = process.env.HOST || "127.0.0.1";
const configPath = path.join(root, "config", "automation.json");
const statePath = path.join(root, "data", "state.json");
const schedulerStatusPath = path.join(root, "data", "automation-status.json");
const screenshotDir = path.join(root, "data", "screenshots");

const staticTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
};

let timer = null;
let schedulerProcess = null;
let kdocsCollectionActive = false;

function loadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return fallback;
  }
}

function saveJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function loadConfig() {
  return loadJson(configPath, {
    intervalMinutes: 1440,
    leadInboxFile: "data/inbox/leads.txt",
    quoteInboxDir: "data/inbox/quotes",
    kdocsSources: [
      {
        id: "ah-kdocs",
        name: "AH收货行情表",
        url: "https://kdocs.cn/l/ciUyT3wSXLX0",
        port: 9223
      }
    ],
    sourceWatchers: []
  });
}

function loadState() {
  return loadJson(statePath, { leads: [], quotes: [], runs: [] });
}

function saveState(state) {
  saveJson(statePath, state);
}

function makeId(prefix, value) {
  const hash = crypto.createHash("sha1").update(value).digest("hex").slice(0, 12);
  return `${prefix}-${hash}`;
}

function normalizeText(value) {
  return String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x2F;/g, "/")
    .replace(/\s+/g, " ")
    .trim();
}

function dedupePush(list, item) {
  if (String(item?.id || "").startsWith("lead-") || (!item?.skuName && !Number(item?.price))) {
    if (list.some((existing) => existing.id === item.id)) return false;
    list.unshift(item);
    return true;
  }

  const prepared = enrichQuote(item);
  if ((prepared.qualityFlags || []).includes("multi-product")) return false;
  const preparedKey = dedupeQuoteKey(prepared);
  if (list.some((existing) => existing.id === prepared.id || dedupeQuoteKey(existing) === preparedKey)) {
    return false;
  }

  const identity = quoteIdentityKey(prepared);
  const existingIndex = list.findIndex((existing) => quoteIdentityKey(existing) === identity);
  if (existingIndex >= 0) {
    const existing = enrichQuote(list[existingIndex]);
    const preferred = preferQuote(existing, prepared);
    if (preferred === existing) return false;
    list.splice(existingIndex, 1);
  }

  list.unshift(prepared);
  Object.assign(item, prepared);
  return true;
}

function parseLeadLine(line, source = "inbox") {
  const rawText = normalizeText(line.replace(/^#.*$/, ""));
  if (!rawText || rawText.length < 8) return null;
  if (!hasLikelyProduct(rawText)) return null;

  return {
    id: makeId("lead", `${source}:${rawText}`),
    source,
    rawText,
    status: "pending",
    createdAt: new Date().toISOString(),
    evidence: null
  };
}

function parseQuoteLine(line, fallbackSource = "报价箱") {
  const rawText = normalizeText(line.replace(/^#.*$/, ""));
  if (!rawText || rawText.length < 8) return null;

  const priceMatch = rawText.match(/(?:报价|回收|收|¥|￥)?\s*(\d{3,5})(?:\s*元)?\s*$/) || rawText.match(/(?:报价|回收|收|¥|￥)\s*(\d{3,5})/);
  if (!priceMatch) return null;

  const sourceName = detectQuoteSource(rawText) || fallbackSource;
  const skuName = rawText
    .replace(priceMatch[0], " ")
    .replace(sourceName, " ")
    .replace(/报价|回收|可收|今天|今日|元/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!skuName || !hasLikelyProduct(skuName)) return null;

  return {
    id: makeId("quote", `${sourceName}:${skuName}:${priceMatch[1]}:${rawText}`),
    skuName,
    sourceType: sourceName.includes("贩子") ? "dealer" : "recycler",
    sourceName,
    price: Number(priceMatch[1]),
    conditionNote: detectCondition(rawText),
    observedAt: new Date().toISOString(),
    confidence: sourceName.includes("小鸽") || sourceName.includes("踏浪") ? 0.95 : 0.86,
    rawText
  };
}

function detectQuoteSource(text) {
  const sources = ["小鸽", "踏浪", "贩子A", "贩子B", "贩子C", "贩子", "闲鱼"];
  return sources.find((source) => text.includes(source)) || "";
}

function detectCondition(text) {
  if (text.includes("全新未拆")) return "全新未拆";
  if (text.includes("未激活")) return "全新未激活";
  if (text.includes("全新")) return "全新";
  if (text.includes("二手")) return "二手";
  return "";
}

function hasLikelyProduct(text) {
  return /iphone|苹果|switch|ps5|airpods|耳机|相机|索尼|佳能|富士|ipad|macbook/i.test(text);
}

function extractDealLines(html, watcher) {
  const text = normalizeText(html);
  const parts = text.split(/(?=¥|￥|券后|到手|补贴|百亿|iPhone|Switch|PS5|AirPods|相机)/i);
  const keywordSet = (watcher.keywords || []).map((keyword) => keyword.toLowerCase());
  const lines = [];

  for (const part of parts) {
    const line = part.slice(0, 180).trim();
    if (line.length < 12) continue;
    const lower = line.toLowerCase();
    const keywordHit = keywordSet.length === 0 || keywordSet.some((keyword) => lower.includes(keyword.toLowerCase()));
    const priceHit = /(\d{3,5})|¥|￥|券|到手|补贴|百亿/.test(line);
    if (keywordHit && priceHit && hasLikelyProduct(line)) {
      lines.push(line);
    }
    if (lines.length >= 20) break;
  }

  return [...new Set(lines)];
}

function fetchText(url, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https:") ? https : http;
    const request = client.get(
      url,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 HaoYangMaoAutomation/0.1",
          Accept: "text/html,application/rss+xml,application/xml;q=0.9,*/*;q=0.8"
        }
      },
      (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          resolve(fetchText(new URL(response.headers.location, url).toString(), timeoutMs));
          response.resume();
          return;
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`HTTP ${response.statusCode}`));
          response.resume();
          return;
        }
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
          if (body.length > 2_000_000) request.destroy(new Error("response too large"));
        });
        response.on("end", () => resolve(body));
      }
    );
    request.setTimeout(timeoutMs, () => request.destroy(new Error("request timeout")));
    request.on("error", reject);
  });
}

async function scanSources(config, state) {
  const added = [];
  const errors = [];

  for (const watcher of config.sourceWatchers || []) {
    if (!watcher.enabled) continue;
    try {
      if (watcher.kind !== "html" && watcher.kind !== "rss") continue;
      const body = await fetchText(watcher.url);
      const lines = extractDealLines(body, watcher);
      for (const line of lines) {
        const lead = parseLeadLine(line, watcher.source || watcher.id);
        if (lead) {
          lead.evidence = watcher.url;
          if (dedupePush(state.leads, lead)) added.push(lead);
        }
      }
    } catch (error) {
      errors.push({ watcher: watcher.id, message: error.message });
    }
  }

  return { added, errors };
}

function importInbox(config, state) {
  const addedLeads = [];
  const addedQuotes = [];
  const leadInboxPath = path.join(root, config.leadInboxFile || "data/inbox/leads.txt");
  const quoteInboxDir = path.join(root, config.quoteInboxDir || "data/inbox/quotes");

  if (fs.existsSync(leadInboxPath)) {
    const lines = fs.readFileSync(leadInboxPath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const lead = parseLeadLine(line, "mobile-inbox");
      if (lead && dedupePush(state.leads, lead)) addedLeads.push(lead);
    }
  }

  if (fs.existsSync(quoteInboxDir)) {
    const files = fs.readdirSync(quoteInboxDir).filter((file) => file.endsWith(".txt"));
    for (const file of files) {
      const fallbackSource = path.basename(file, ".txt");
      const rawText = fs.readFileSync(path.join(quoteInboxDir, file), "utf8");
      const tableQuotes = parseRecyclerOcrText(rawText, { fallbackSource });
      for (const quote of tableQuotes) {
        if (dedupePush(state.quotes, quote)) addedQuotes.push(quote);
      }

      const lines = rawText.split(/\r?\n/);
      for (const line of lines) {
        const quote = parseQuoteLine(line, fallbackSource);
        if (quote && dedupePush(state.quotes, quote)) addedQuotes.push(quote);
      }
    }
  }

  return { addedLeads, addedQuotes };
}

function importQuoteText(text, fallbackSource = "OCR") {
  const state = loadState();
  const imported = [];
  const tableQuotes = parseRecyclerOcrText(text, { fallbackSource });

  for (const quote of tableQuotes) {
    if (dedupePush(state.quotes, quote)) imported.push(quote);
  }

  const lines = String(text || "").split(/\r?\n/);
  for (const line of lines) {
    const quote = parseQuoteLine(line, fallbackSource);
    if (quote && dedupePush(state.quotes, quote)) imported.push(quote);
  }

  saveState(state);
  return { imported: imported.length, items: imported, state: summarizeState(state) };
}

function captureWindow(scriptName, label = "capture") {
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

  return {
    imagePath: outputPath,
    relativePath: path.relative(root, outputPath).replace(/\\/g, "/")
  };
}

async function ocrImageOpenAI(imagePath) {
  if (!process.env.OPENAI_API_KEY) {
    return {
      error: "OPENAI_API_KEY 未配置",
      next: "可以先用 QQ/微信截图 OCR 复制文字，再粘贴到报价 OCR 工作台。"
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
              text: "请只提取截图中的回收报价表。保留商品型号、容量、颜色、价格、来源名称。每条或每段按原文字输出，不要解释。"
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
  return { imagePath: absolutePath, text: extractResponseText(data) };
}

function ocrImageWindows(imagePath, options = {}) {
  const absolutePath = path.isAbsolute(imagePath) ? imagePath : path.join(root, imagePath);
  const scriptPath = path.join(root, "scripts", "ocr-windows.ps1");
  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-ImagePath", absolutePath];
  if (options.scale && Number(options.scale) > 1) args.push("-Scale", String(options.scale));
  const result = spawnSync("powershell.exe", args, {
    encoding: "utf8",
    timeout: options.timeout || 30000,
    maxBuffer: 32 * 1024 * 1024
  });

  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "Windows OCR failed").trim());
  }

  return {
    imagePath: absolutePath,
    text: result.stdout.trim(),
    engine: "windows-ocr"
  };
}

function ocrImageWindowsJson(imagePath, options = {}) {
  const absolutePath = path.isAbsolute(imagePath) ? imagePath : path.join(root, imagePath);
  const scriptPath = path.join(root, "scripts", "ocr-windows.ps1");
  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-ImagePath", absolutePath];
  if (options.scale && Number(options.scale) > 1) args.push("-Scale", String(options.scale));
  args.push("-Json");
  const result = spawnSync("powershell.exe", args, {
    encoding: "utf8",
    timeout: options.timeout || 30000,
    maxBuffer: 32 * 1024 * 1024
  });

  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "Windows OCR JSON failed").trim());
  }

  return JSON.parse(result.stdout);
}

function splitLongImage(imagePath) {
  const absolutePath = path.isAbsolute(imagePath) ? imagePath : path.join(root, imagePath);
  const outputDir = path.join(screenshotDir, `split-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  const scriptPath = path.join(root, "scripts", "split-long-image.ps1");
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    "-ImagePath",
    absolutePath,
    "-OutputDir",
    outputDir
  ], {
    encoding: "utf8",
    timeout: 30000
  });

  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "split image failed").trim());
  }

  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function importXiaogeLongScreenshot(imagePath) {
  const state = loadState();
  const chunks = splitLongImage(imagePath);
  const imported = [];
  const chunkResults = [];

  for (const chunkPath of chunks) {
    const ocr = ocrImageWindowsJson(chunkPath);
    const quotes = parseXiaogeOcrLayout(ocr, { sourceName: "小鸽" });
    let importedInChunk = 0;
    for (const quote of quotes) {
      if (dedupePush(state.quotes, quote)) {
        imported.push(quote);
        importedInChunk += 1;
      }
    }
    chunkResults.push({
      imagePath: chunkPath,
      textLength: ocr.text.length,
      parsed: quotes.length,
      imported: importedInChunk
    });
  }

  saveState(state);
  return {
    imported: imported.length,
    items: imported,
    chunks: chunkResults,
    state: summarizeState(state)
  };
}

function uploadImage({ filename, dataUrl }) {
  const match = String(dataUrl || "").match(/^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) {
    throw new Error("只支持 PNG/JPEG 图片上传");
  }
  const ext = match[1] === "jpeg" ? ".jpg" : ".png";
  const safeName = String(filename || "screenshot")
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-z0-9\u4e00-\u9fa5_-]+/gi, "-")
    .slice(0, 48);
  const outputDir = path.join(root, "data", "inbox", "screenshots");
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${safeName}${ext}`);
  fs.writeFileSync(outputPath, Buffer.from(match[2], "base64"));
  return {
    imagePath: outputPath,
    relativePath: path.relative(root, outputPath).replace(/\\/g, "/")
  };
}

function getKdocsSource(config, id = "ah-kdocs") {
  const sources = config.kdocsSources || [];
  return sources.find((source) => source.id === id) || {
    id: "ah-kdocs",
    name: "AH收货行情表",
    url: "https://kdocs.cn/l/ciUyT3wSXLX0",
    port: 9223
  };
}

function runKdocsSession(command, source) {
  const scriptPath = path.join(root, "scripts", "kdocs-session.js");
  const timeoutMs = command === "collect" ? 5 * 60 * 1000 : 15000;
  const result = spawnSync(process.execPath, [scriptPath, command, source.url, String(source.port || 9223)], {
    encoding: "utf8",
    timeout: timeoutMs
  });

  const output = (result.stdout || result.stderr || "").trim();
  if (result.status !== 0) {
    if (result.error?.code === "ETIMEDOUT") {
      throw new Error(`KDocs ${command} 超过 ${Math.round(timeoutMs / 60000)} 分钟，已保留上一版 AH 报价。`);
    }
    throw new Error(output || `kdocs ${command} failed`);
  }

  try {
    return JSON.parse(output);
  } catch (error) {
    return { ok: true, output };
  }
}

function openKdocsSource(id = "ah-kdocs") {
  const config = loadConfig();
  const source = getKdocsSource(config, id);
  return { source, session: runKdocsSession("open", source) };
}

function collectKdocsSource(id = "ah-kdocs") {
  const config = loadConfig();
  const source = getKdocsSource(config, id);
  const session = runKdocsSession("collect", source);
  if (!session.captureComplete) {
    throw new Error("KDocs 最新目录未完整截图，已保留上一版 AH 报价。");
  }
  const imageOcr = importKdocsImageOcr(session, source);
  const imported = imageOcr.imported;
  const cloudSync = syncCloudSnapshot(imported.imported);
  return { source, session, imported, imageOcr, cloudSync, diagnostics: diagnoseKdocsSnapshot(session, imported, imageOcr) };
}

function syncCloudSnapshot(imported = 0) {
  const config = loadConfig();
  const cloudUrl = process.env.HYM_CLOUD_URL || config.cloudSync?.url || "";
  if (!cloudUrl || !process.env.HYM_SYNC_TOKEN) {
    return { ok: false, configured: false, message: "未配置 HYM_CLOUD_URL/HYM_SYNC_TOKEN" };
  }
  const scriptPath = path.join(root, "scripts", "cloud-sync.js");
  const result = spawnSync(process.execPath, [scriptPath, String(imported)], {
    cwd: root,
    encoding: "utf8",
    timeout: 45000,
    windowsHide: true,
    env: { ...process.env, HYM_CLOUD_URL: cloudUrl }
  });
  const output = String(result.stdout || result.stderr || "").trim();
  try {
    return JSON.parse(output);
  } catch (error) {
    return { ok: false, configured: true, error: output || `cloud sync exited ${result.status}` };
  }
}

function importKdocsImageOcr(session, source) {
  const imagePaths = Array.isArray(session.latestImagePaths) ? session.latestImagePaths : [];
  const ocrResults = [];
  const textBlocks = [];
  const parsedQuotes = [];
  const sourceName = `${source.name || "AH"} OCR`;

  for (const imagePath of imagePaths) {
    if (!imagePath || !fs.existsSync(imagePath)) continue;
    try {
      const ocr = ocrImageWindowsJson(imagePath, { scale: 2, timeout: 60000 });
      const imageQuotes = parseAhKdocsOcrLayout(ocr, sourceName);
      parsedQuotes.push(...imageQuotes);
      ocrResults.push({
        imagePath,
        engine: "windows-ocr-layout",
        textLength: ocr.text.length,
        parsed: imageQuotes.length,
        preview: ocr.text.slice(0, 300)
      });
      if (ocr.text.trim()) textBlocks.push(`# ${path.basename(imagePath)}\n${ocr.text.trim()}`);
    } catch (error) {
      ocrResults.push({ imagePath, error: error.message });
    }
  }

  const ocrText = textBlocks.join("\n\n");
  const latestOcrTextPath = path.join(root, "data", "inbox", "quotes", "ah-kdocs-ocr-latest.txt");
  if (ocrText) {
    fs.mkdirSync(path.dirname(latestOcrTextPath), { recursive: true });
    fs.writeFileSync(latestOcrTextPath, ocrText, "utf8");
  }

  const imported = parsedQuotes.length
    ? importAhKdocsQuotes(parsedQuotes, sourceName, { replaceSource: true, minQuotes: 20 })
    : { imported: 0, items: [] };

  return {
    imageCount: imagePaths.length,
    ocrCount: ocrResults.filter((item) => !item.error).length,
    textLength: ocrText.length,
    latestOcrTextPath: ocrText ? latestOcrTextPath : "",
    results: ocrResults,
    imported
  };
}

function importAhKdocsOcrText(text, sourceName = "AH OCR", options = {}) {
  const quotes = parseAhKdocsOcrTextV2(text, sourceName);
  return importAhKdocsQuotes(quotes, sourceName, options);
}

function importAhKdocsQuotes(quotes, sourceName = "AH OCR", options = {}) {
  const state = loadState();
  const byIdentity = new Map();

  for (const quote of quotes) {
    const prepared = enrichQuote(quote);
    if (!shouldKeepQuote(prepared, { source: "ah", minScore: 55 })) continue;
    const identity = `${quoteIdentityKey(prepared)}:${String(prepared.conditionNote || "").trim()}`;
    const existing = byIdentity.get(identity);
    if (!existing || Number(prepared.price) < Number(existing.price)) byIdentity.set(identity, prepared);
  }

  const preparedQuotes = [...byIdentity.values()];

  const minQuotes = Math.max(1, Number(options.minQuotes || 1));
  if (options.replaceSource && preparedQuotes.length < minQuotes) {
    throw new Error(`AH OCR 仅解析出 ${preparedQuotes.length} 条，低于完整更新阈值 ${minQuotes} 条，已保留上一版。`);
  }

  if (options.replaceSource) {
    const sourceFamily = String(sourceName).replace(/\s*OCR$/i, "").trim();
    state.quotes = state.quotes.filter((quote) => {
      const existingName = String(quote.sourceName || "").trim();
      const isAhOcrSource = /^AH/i.test(existingName) && /OCR/i.test(existingName);
      return !isAhOcrSource && existingName !== sourceName && existingName !== sourceFamily;
    });
  }

  const imported = [];
  for (const prepared of preparedQuotes) {
    if (dedupePush(state.quotes, prepared)) imported.push(prepared);
  }

  saveState(state);
  return { imported: imported.length, items: imported, state: summarizeState(state) };
}

function parseAhKdocsOcrText(text, sourceName = "AH OCR") {
  const normalized = String(text || "")
    .replace(/\r/g, "\n")
    .replace(/[|｜]/g, " ")
    .replace(/([一小红华荣苹任戴拍])\s+(?=[加米为耀果天森立])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  const productPattern = /(iPhone\s*\d{1,2}\s*(?:Pro\s*Max|ProMax|Pro|Air|e)?|PS5\s*(?:PRO|Pro)?|NS2|NS\b|任\s*天堂|STEAM\s*OLED|一\s*加\s*[A-Za-z0-9]+|小\s*米\s*\d+\s*(?:ProMax|Pro|Ultra|Max|ro|max)?|红\s*米\s*[A-Za-z0-9]+|vivo\s*[A-Za-z0-9]+|OPPO\s*[A-Za-z0-9]+|荣耀\s*[A-Za-z0-9]+|华为\s*[A-Za-z0-9]+|戴\s*森|拍\s*立\s*得|instax)/gi;
  const marked = normalized.replace(productPattern, "\n$1");
  const quotes = [];

  for (const segment of marked.split(/\n+/)) {
    const clean = cleanupAhSegment(segment);
    const compact = clean.replace(/\s+/g, "");
    if (!hasAhProductMarker(compact)) continue;
    if (/收货行情|行情报价|目录|要点|访客|仅查看/.test(compact)) continue;

    const priceMatches = [...clean.matchAll(/\b(\d{3,5})\b/g)]
      .map((match) => ({ price: Number(match[1]), index: match.index || 0 }))
      .filter((item) => item.price >= 300 && item.price <= 30000);
    if (!priceMatches.length) continue;

    const priceMatch = priceMatches[priceMatches.length - 1];
    const skuName = clean.slice(0, priceMatch.index).replace(/\s+/g, " ").trim();
    if (skuName.length < 4 || skuName.length > 90) continue;
    if (!hasAhProductMarker(skuName.replace(/\s+/g, ""))) continue;

    quotes.push({
      id: makeId("quote", `${sourceName}:${skuName}:${priceMatch.price}`),
      skuName: `${skuName} 全新`,
      sourceType: "recycler",
      sourceName,
      price: priceMatch.price,
      conditionNote: "",
      observedAt: new Date().toISOString(),
      confidence: 0.68,
      rawText: clean
    });
  }

  return dedupeParsedQuotes(quotes);
}

function cleanupAhSegment(segment) {
  return String(segment || "")
    .replace(/[<>《》#]/g, " ")
    .replace(/([A-Za-z])\s+([A-Za-z])/g, "$1$2")
    .replace(/(\d)\s*(?:\+|路|鍜|鈥|＋)\s*(\d)/g, "$1+$2")
    .replace(/(\d)\s*(?:TB|T8|lt|lT|IT)\b/gi, "$1TB")
    .replace(/(\d)\s*(?:GB|G)\b/gi, "$1G")
    .replace(/\s+/g, " ")
    .trim();
}

function hasAhProductMarker(compactText) {
  return /(iphone|ps5|ns2|任天堂|steam|一加|小米|红米|vivo|oppo|荣耀|华为|戴森|拍立得|instax)/i.test(compactText);
}

function dedupeParsedQuotes(quotes) {
  const seen = new Set();
  const result = [];
  for (const quote of quotes) {
    const key = `${quote.sourceName}:${quote.skuName}:${quote.price}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(quote);
  }
  return result;
}

function parseAhKdocsOcrTextV2(text, sourceName = "AH OCR") {
  const normalized = normalizeAhOcrTextV2(text);
  const productPattern = /(iPhone\s*\d{1,2}\s*(?:Pro\s*Max|ProMax|Pro|Air|e)?|iPad\s*\d*|AirPods\s*[^ ]*|Mini\s*\d+|AIR\s*\d+|PS5\s*(?:PRO|Pro)?|NS2|NS\b|任\s*天\s*堂|STEAM\s*OLED|一\s*加\s*[A-Za-z0-9]+|小\s*米\s*\d+\s*(?:ProMax|Promax|Pro|Ultra|Max|ro|max|uItra|ultra)?|红\s*米\s*[A-Za-z0-9]+|vivo\s*[A-Za-z0-9]+|OPPO\s*[A-Za-z0-9]+|荣耀\s*[A-Za-z0-9]+|华为\s*[A-Za-z0-9]+|戴\s*森|拍\s*立\s*得|instax)/gi;
  const marked = normalized.replace(productPattern, "\n$1");
  const quotes = [];

  for (const segment of marked.split(/\n+/)) {
    const clean = cleanupAhSegmentV2(segment);
    const scopedClean = scopeAhProductSegmentV2(clean);
    const compact = scopedClean.replace(/\s+/g, "");
    if (!hasAhProductMarkerV2(compact)) continue;
    if (/收货行情|行情报价|目录|要点|访客|仅查看|供参考|私聊/.test(compact)) continue;

    const priceMatches = extractAhPricesV2(scopedClean);
    if (!priceMatches.length) continue;

    const bestPrice = priceMatches.reduce((best, item) => (item.price > best.price ? item : best), priceMatches[0]);
    const firstPrice = priceMatches[0];
    const skuName = scopedClean
      .slice(0, firstPrice.index)
      .replace(/[：:，,、/]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (skuName.length < 4 || skuName.length > 90) continue;
    if (!hasAhProductMarkerV2(skuName.replace(/\s+/g, ""))) continue;

    quotes.push({
      id: makeId("quote", `${sourceName}:${skuName}:${bestPrice.price}`),
      skuName: `${skuName} 全新`,
      sourceType: "recycler",
      sourceName,
      price: bestPrice.price,
      conditionNote: "",
      observedAt: new Date().toISOString(),
      confidence: 0.74,
      rawText: scopedClean
    });
  }

  return dedupeParsedQuotes(quotes);
}

function parseAhKdocsOcrLayout(ocr, sourceName = "AH OCR") {
  const quotes = [];
  const lineTexts = extractAhLayoutLineTexts(ocr);

  for (const originalText of lineTexts) {
    const rowText = normalizeAhLayoutRow(originalText);
    if (!rowText || /收货行情|行情报价|注意|仅供参考|默认出货|私聊|停收|不要/.test(rowText)) continue;

    const skuName = canonicalizeAhLayoutSku(rowText);
    if (!skuName) continue;

    const activationMatch = rowText.match(/预\s*激\s*活/);
    const regularPart = activationMatch ? rowText.slice(0, activationMatch.index) : rowText;
    const activationPart = activationMatch ? rowText.slice((activationMatch.index || 0) + activationMatch[0].length) : "";
    const regularPrices = extractAhPricesV2(regularPart);
    const fallbackPrices = regularPrices.length ? regularPrices : extractAhPricesV2(rowText);
    if (!fallbackPrices.length) continue;

    quotes.push(makeAhLayoutQuote(sourceName, skuName, Math.min(...fallbackPrices.map((item) => item.price)), rowText, ""));

    const activationPrices = extractAhPricesV2(activationPart);
    if (activationPrices.length) {
      quotes.push(makeAhLayoutQuote(
        sourceName,
        `${skuName} 预激活`,
        Math.min(...activationPrices.map((item) => item.price)),
        rowText,
        "预激活"
      ));
    }
  }

  return dedupeParsedQuotes(quotes);
}

function extractAhLayoutLineTexts(ocr) {
  const width = Math.max(1, Number(ocr?.width || 0));
  const gapThreshold = Math.max(110, width * 0.045);
  const texts = [];

  for (const line of ocr?.lines || []) {
    const words = [...(line.words || [])].sort((left, right) => Number(left.x) - Number(right.x));
    if (words.length < 2) {
      if (String(line.text || "").trim()) texts.push(String(line.text).trim());
      continue;
    }

    const groups = [[]];
    let previousRight = Number(words[0].x || 0);
    for (const word of words) {
      const x = Number(word.x || 0);
      if (groups[groups.length - 1].length && x - previousRight > gapThreshold) groups.push([]);
      groups[groups.length - 1].push(String(word.text || ""));
      previousRight = x + Number(word.width || 0);
    }
    for (const group of groups) {
      const text = group.join(" ").replace(/\s+/g, " ").trim();
      if (text) texts.push(text);
    }
  }

  return texts;
}

function normalizeAhLayoutRow(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[|｜]/g, " ")
    .replace(/([一小红华荣苹])\s+(?=[加米为耀果])/g, "$1")
    .replace(/一\s*力\s*[日囗口]/g, "一加")
    .replace(/i\s*Phone/gi, "iPhone")
    .replace(/A\s*i\s*r\s*Pods?/gi, "AirPods")
    .replace(/AirP0ds/gi, "AirPods")
    .replace(/Turb0/gi, "Turbo")
    .replace(/Pr\s*o/gi, "Pro")
    .replace(/至\s*尊/g, "至尊")
    .replace(/\bK90\s*ro\s*max\b/gi, "K90 ProMax")
    .replace(/\bK90\s*max\b/gi, "K90 Max")
    .replace(/\b1\s+5(?=t?\b)/gi, "15")
    .replace(/巧\s*12G/gi, "512G")
    .replace(/TBG/gi, "TB")
    .replace(/(\d)\s*[+＋路]\s*(\d)/g, "$1+$2")
    .replace(/\b14\s*\(\s*4\+64(?=\s*\(\s*无\s*充)/g, "14C 4+64")
    .replace(/\b14C(?=\d+\+\d+)/gi, "14C ")
    .replace(/\(\s*(无|有)\s*充\s*\)/g, "($1充)")
    .replace(/\b(\d)\s+(\d)(?=\+\d)/g, "$1$2")
    .replace(/\+\s*[lI]tb\b/gi, "+1TB")
    .replace(/\bITB\b/gi, "1TB")
    .replace(/\+\s*(?:lt|it|1t)\b/gi, "+1TB")
    .replace(/\+1\s*t\b/gi, "+1TB")
    .replace(/(\d)\s+\+(?=\d)/g, "$1+")
    .replace(/\b(?:ro|r0)\b/gi, "Pro")
    .replace(/(\d)\s*[.·．。]\s*(?=\d{3}G\b)/g, "$1 ")
    .replace(/\b(\d)M0\b/g, (_, first) => `${first}640`)
    .replace(/\b(\d{2})S0\b/g, (_, first) => `${first}50`)
    .replace(/\b(\d{2})S00\b/g, (_, first) => `${first}500`)
    .replace(/\b(\d{2})S\b/g, (_, first) => `${first}5`)
    .replace(/\b(\d)\s*S(\d{2})\b/g, (_, first, rest) => `${first}5${rest}`)
    .replace(/\b1\s*S50\b/g, "1550")
    .replace(/\b(\d{2,3})\s*[m佣]\b/g, (_, first) => `${first}00`)
    .replace(/\b1\s+(1\d{3})\b/g, (_, rest) => `1${rest}`)
    .replace(/钅\s*良/g, "银")
    .replace(/钅\s*艮/g, "银")
    .replace(/裉/g, "银")
    .replace(/黑\s*[恨很]\s*蓝/g, "黑 银 蓝")
    .replace(/臼/g, "白")
    .replace(/[％%](?=\d{2,3}\b)/g, "6")
    .replace(/r(?=\d{3}\b)/gi, " ")
    .replace(/(17Pro-256G[^\n]*?橙)\s*7\s*0\b/i, "$1 7640")
    .replace(/\s+/g, " ")
    .trim();
}

function canonicalizeAhLayoutSku(rowText) {
  const text = String(rowText || "").trim();
  const compact = text.replace(/\s+/g, "");
  let match = null;

  match = compact.match(/^17e[-一·．。]?((?:128|256|512)G)/i);
  if (match) return `iPhone17e ${match[1].toUpperCase()}`;

  match = compact.match(/^17(?:PRO|Pro)[-一·．。]?((?:256|512)G|[12]TB)/i);
  if (match) return `iPhone17 Pro ${match[1].toUpperCase()}`;

  match = compact.match(/^17(?:MAX|M)[-一·．。]?((?:256|512)G|[12]TB)/i);
  if (match) return `iPhone17 ProMax ${match[1].toUpperCase()}`;

  match = compact.match(/^17[-一·．。]?((?:256|512)G)/i);
  if (match) return `iPhone17 ${match[1].toUpperCase()}`;

  match = compact.match(/^Air((?:256|512)G)/i);
  if (match) return `iPhone Air ${match[1].toUpperCase()}`;

  match = compact.match(/^(16(?:Pro|pro)?)[-一·．。]?((?:128|256|512)G|1TB)/i);
  if (match) return `iPhone${match[1].replace(/pro/i, " Pro")} ${match[2].toUpperCase()}`;

  match = text.match(/^一加\s*([A-Za-z0-9]+(?:\s*至尊)?)\s*(\d+\+\d+(?:TB?)?)/i);
  if (match) return `一加 ${match[1].replace(/\s+/g, " ")} ${normalizeMemorySpec(match[2])}`;

  if (/^24\s*年\s*不.*AirPods/i.test(text)) return "";
  const airPodsCodes = {
    P63: "AirPods4 标准版 (P63)",
    P93: "AirPods4 降噪版 (P93)",
    E73: "AirPods3 无线 (E73)",
    NY3: "AirPods3 有线 (NY3)",
    "7N2": "AirPods2 (7N2)",
    HP4: "AirPods3 Pro 无线耳机 (HP4)"
  };
  const airPodsCode = Object.keys(airPodsCodes).find((code) => new RegExp(code, "i").test(text));
  if (airPodsCode) return airPodsCodes[airPodsCode];
  if (/AirPods/i.test(text)) return "";

  const prices = extractAhPricesV2(text);
  if (!prices.length) return "";
  const prefix = text.slice(0, prices[0].index)
    .replace(/[：:，,、/*]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (prefix.length < 4 || prefix.length > 70) return "";
  if (!hasAhProductMarkerV2(prefix.replace(/\s+/g, ""))) return "";
  return prefix;
}

function normalizeMemorySpec(value) {
  return String(value || "")
    .replace(/(?:1t|lt|it)$/i, "1TB")
    .replace(/(\d+)\+(\d+)(?:T|TB)$/i, "$1+$2TB")
    .replace(/(\d+)\+(\d+)$/i, "$1+$2");
}

function makeAhLayoutQuote(sourceName, skuName, price, rawText, conditionNote) {
  return {
    id: makeId("quote", `${sourceName}:${skuName}:${price}`),
    skuName: `${skuName} 全新`,
    sourceType: "recycler",
    sourceName,
    price,
    conditionNote,
    observedAt: new Date().toISOString(),
    confidence: 0.88,
    rawText
  };
}

function scopeAhProductSegmentV2(text) {
  const value = String(text || "");
  const productPattern = /i\s*phone\s*\d{1,2}|i\s*pad(?:\s*(?:mini|air|pro)?\s*\d*)?|air\s*pods|p\s*s\s*5|n\s*s\s*2|switch|steam\s*deck|红\s*米|小\s*米|一\s*加|华\s*为|荣\s*耀|oppo|vivo|iqoo|instax|insta\s*360|osmo/gi;
  const starts = [...value.matchAll(productPattern)].map((match) => match.index || 0);
  if (starts.length < 2) return value;
  return value.slice(0, starts[1]).trim();
}

function normalizeAhOcrTextV2(text) {
  return String(text || "")
    .replace(/\r/g, "\n")
    .replace(/[|｜]/g, " ")
    .replace(/([小红一华荣苹任戴拍])\s+(?=[米加为耀果天森立])/g, "$1")
    .replace(/i\s*Phone/gi, "iPhone")
    .replace(/Pr\s*o\s*Max|Pro\s*MAX|Promay/gi, "ProMax")
    .replace(/uItra/gi, "Ultra")
    .replace(/Turb0|TurbO/gi, "Turbo")
    .replace(/(\d)\s*[·．。]\s*(\d)/g, "$1.$2")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanupAhSegmentV2(segment) {
  return String(segment || "")
    .replace(/[<>《》#]/g, " ")
    .replace(/([A-Za-z])\s+([A-Za-z])/g, "$1$2")
    .replace(/(\d)\s*(?:\+|路|·|．|＋)\s*(\d)/g, "$1+$2")
    .replace(/(\d)\s*(?:TB|T8|lt|lT|IT)\b/gi, "$1TB")
    .replace(/(\d)\s*(?:GB|G)\b/gi, "$1G")
    .replace(/\s+/g, " ")
    .trim();
}

function extractAhPricesV2(text) {
  const matches = [];
  for (const match of String(text || "").matchAll(/\b(\d{3,5})\b/g)) {
    const price = Number(match[1]);
    const index = match.index || 0;
    if (price < 300 || price > 30000) continue;
    if (isAhStorageNumberV2(text, index, match[1])) continue;
    matches.push({ price, index });
  }
  return matches;
}

function isAhStorageNumberV2(text, index, value) {
  const before = String(text || "").slice(Math.max(0, index - 4), index);
  const after = String(text || "").slice(index + String(value).length, index + String(value).length + 4);
  if (/[+＋]\s*$/.test(before)) return true;
  if (/^\s*(G|GB|TB|T8|lt|lT|IT)\b/i.test(after)) return true;
  return ["128", "256", "512"].includes(String(value)) && /[A-Za-z0-9]\s*$/.test(before);
}

function hasAhProductMarkerV2(compactText) {
  return /(iphone|ipad|airpods|mini\d|air\d|ps5|ns2|任天堂|steam|一加|小米|红米|vivo|oppo|荣耀|华为|戴森|拍立得|instax)/i.test(compactText);
}

function mergeImportResults(primary, secondary) {
  return {
    imported: (primary.imported || 0) + (secondary.imported || 0),
    items: [...(primary.items || []), ...(secondary.items || [])],
    state: secondary.state || primary.state
  };
}

function diagnoseKdocsSnapshot(session, imported, imageOcr = null) {
  const snapshot = session.latestJsonPath && fs.existsSync(session.latestJsonPath)
    ? loadJson(session.latestJsonPath, null)
    : null;
  const text = [snapshot?.tableText, snapshot?.text].filter(Boolean).join("\n");
  const sampleText = (snapshot?.apiSamples || [])
    .map((sample) => `${sample.status || ""} ${sample.url || ""} ${sample.text || ""} ${sample.error || ""}`)
    .join("\n");
  const loginRequired = /用户未登录|userNotLogin|no_login|permissionDenied|立即登录/.test(`${text}\n${sampleText}`);
  const quoteLikeLines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /iphone|ipad|airpods|switch|ps5|macbook|安卓|苹果/i.test(line) && /\b\d{3,5}\b/.test(line));

  let level = "ok";
  let message = `AH 采集完成：页面文本 ${session.textLength || 0} 字，截图 ${imageOcr?.imageCount || 0} 张，OCR ${imageOcr?.textLength || 0} 字，入库 ${imported.imported || 0} 条。`;
  if ((imported.imported || 0) > 0) {
    level = "ok";
  } else if ((imageOcr?.imageCount || 0) > 0 && (imageOcr?.textLength || 0) > 0) {
    level = "ocr-no-quotes";
    message = `AH 已改走图片 OCR：截图 ${imageOcr.imageCount} 张，OCR ${imageOcr.textLength} 字，但还没解析出报价；需要按 AH 图片格式补解析规则。`;
  } else if ((imported.imported || 0) === 0 && loginRequired) {
    level = "login";
    message = "AH 只采到目录/访客壳：独立 Chrome 还没登录 WPS，或登录态没有带上。请在弹出的授权浏览器里登录后再采集。";
  } else if ((imported.imported || 0) === 0 && quoteLikeLines.length === 0) {
    level = "no-quotes";
    message = "AH 采集到了页面文本，但没有型号+价格行；这份文档正文可能是内部渲染，需要改走截图 OCR 或内部接口解析。";
  }

  return {
    level,
    message,
    loginRequired,
    quoteLikeLines: quoteLikeLines.slice(0, 20),
    apiIssues: (snapshot?.apiSamples || [])
      .filter((sample) => sample.status >= 400 || sample.error)
      .slice(0, 10)
      .map((sample) => ({
        status: sample.status || 0,
        url: sample.url || "",
        text: String(sample.text || sample.error || "").slice(0, 200)
      }))
  };
}

function observeQuoteScreen(mode = "active") {
  const capture = captureWindow(mode === "screen" ? "capture-screen.ps1" : "capture-active-window.ps1", mode === "screen" ? "quote-screen" : "quote-window");
  const ocr = ocrImageWindows(capture.imagePath);
  const source = detectOcrSource(ocr.text);
  const warning = !ocr.text.trim()
    ? "未识别到文字。如果截图是黑屏，请从你的桌面 PowerShell 或双击启动脚本运行 automation-server.js，不要用 Codex 后台隐藏进程。"
    : "";
  const imported = importQuoteText(ocr.text, source);

  return {
    mode,
    imagePath: capture.imagePath,
    relativePath: capture.relativePath,
    engine: ocr.engine,
    text: ocr.text,
    source,
    warning,
    imported: imported.imported,
    items: imported.items,
    state: imported.state
  };
}

function detectOcrSource(text) {
  const value = String(text || "");
  if (/小鸽|小鸽手机回收|回收参考价/.test(value)) return "小鸽";
  if (/踏浪|行情报价|寄售报价/.test(value)) return "踏浪";
  return "屏幕OCR";
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

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

async function runAutomation(reason = "manual") {
  const config = loadConfig();
  const state = loadState();
  const startedAt = new Date().toISOString();
  const inbox = importInbox(config, state);
  const scan = await scanSources(config, state);
  const run = {
    id: makeId("run", `${startedAt}:${reason}`),
    reason,
    startedAt,
    finishedAt: new Date().toISOString(),
    addedLeads: inbox.addedLeads.length + scan.added.length,
    addedQuotes: inbox.addedQuotes.length,
    errors: scan.errors
  };

  state.runs.unshift(run);
  state.runs = state.runs.slice(0, 50);
  state.leads = state.leads.slice(0, 500);
  state.quotes = state.quotes.slice(0, 1000);
  saveState(state);
  return { run, inbox, scan, state };
}

function loadSchedulerStatus() {
  return loadJson(schedulerStatusPath, {
    active: false,
    lastAttemptAt: "",
    lastSuccessAt: "",
    lastFailureAt: "",
    lastError: "",
    lastImported: 0,
    lastEvidencePath: ""
  });
}

function saveSchedulerStatus(patch) {
  const next = { ...loadSchedulerStatus(), ...patch };
  saveJson(schedulerStatusPath, next);
  return next;
}

function publicEvidencePath(imagePath) {
  if (!imagePath) return "";
  const absolutePath = path.resolve(imagePath);
  if (!absolutePath.startsWith(root)) return "";
  return `/${path.relative(root, absolutePath).replace(/\\/g, "/")}`;
}

function recordKdocsSuccess(result) {
  const imagePaths = result?.session?.latestImagePaths || [];
  return saveSchedulerStatus({
    active: false,
    lastSuccessAt: new Date().toISOString(),
    lastError: "",
    lastImported: Number(result?.imported?.imported || 0),
    lastEvidencePath: publicEvidencePath(imagePaths[0] || ""),
    lastCloudSyncAt: result?.cloudSync?.ok ? result.cloudSync.syncedAt || new Date().toISOString() : "",
    lastCloudSyncError: result?.cloudSync?.configured && !result.cloudSync?.ok ? result.cloudSync.error || result.cloudSync.message || "云端同步失败" : "",
    lastReason: result?.reason || "manual"
  });
}

function collectKdocsWithStatus(id = "ah-kdocs") {
  if (schedulerProcess || kdocsCollectionActive) {
    throw new Error("AH 采集正在进行，请等待当前任务完成。");
  }
  kdocsCollectionActive = true;
  saveSchedulerStatus({ active: true, lastAttemptAt: new Date().toISOString() });
  try {
    const result = collectKdocsSource(id);
    recordKdocsSuccess(result);
    return result;
  } catch (error) {
    saveSchedulerStatus({
      active: false,
      lastFailureAt: new Date().toISOString(),
      lastError: error.message
    });
    throw error;
  } finally {
    kdocsCollectionActive = false;
  }
}

function runScheduledRefresh(reason = "timer") {
  if (schedulerProcess || kdocsCollectionActive) return false;
  saveSchedulerStatus({ active: true, lastAttemptAt: new Date().toISOString(), lastReason: reason });

  const scriptPath = path.join(root, "scripts", "scheduled-refresh.js");
  const child = spawn(process.execPath, [scriptPath, reason], {
    cwd: root,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  schedulerProcess = child;
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const timeout = setTimeout(() => child.kill(), 5 * 60 * 1000);

  child.on("close", (code) => {
    clearTimeout(timeout);
    schedulerProcess = null;
    let result = null;
    try {
      result = JSON.parse(stdout.trim());
    } catch (error) {}

    if (code === 0 && result?.ok) {
      saveSchedulerStatus({
        active: false,
        lastSuccessAt: result.finishedAt || new Date().toISOString(),
        lastError: "",
        lastImported: Number(result.imported || 0),
        lastEvidencePath: result.evidencePath || "",
        lastCloudSyncAt: result.cloudSync?.ok ? result.cloudSync.syncedAt || result.finishedAt || new Date().toISOString() : "",
        lastCloudSyncError: result.cloudSync?.configured && !result.cloudSync?.ok ? result.cloudSync.error || result.cloudSync.message || "云端同步失败" : ""
      });
    } else {
      saveSchedulerStatus({
        active: false,
        lastFailureAt: new Date().toISOString(),
        lastError: result?.error || stderr.trim() || `scheduled refresh exited ${code}`
      });
    }
  });
  return true;
}

function startTimer() {
  const config = loadConfig();
  const ms = Math.max(1, Number(config.intervalMinutes || 1440)) * 60 * 1000;
  if (timer) clearTimeout(timer);
  const lastSuccessAt = Date.parse(loadSchedulerStatus().lastSuccessAt || "");
  const due = !Number.isFinite(lastSuccessAt) || Date.now() - lastSuccessAt >= ms;
  const delay = due ? 2000 : Math.max(2000, ms - (Date.now() - lastSuccessAt));
  timer = setTimeout(() => {
    runScheduledRefresh(due ? "startup-due" : "daily");
    timer = setInterval(() => runScheduledRefresh("daily"), ms);
  }, delay);
}

function stopTimer() {
  if (timer) clearTimeout(timer);
  timer = null;
}

function sendJson(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${host}:${port}`);
  const pathname = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const filePath = path.normalize(path.join(root, pathname));

  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": staticTypes[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(data);
  });
}

function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${host}:${port}`);

    try {
      if (url.pathname === "/api/automation/status") {
        sendJson(res, {
          running: Boolean(timer),
          scheduler: loadSchedulerStatus(),
          config: loadConfig(),
          state: summarizeState(loadState())
        });
        return;
      }

      if (url.pathname === "/api/automation/state") {
        sendJson(res, loadState());
        return;
      }

      if (url.pathname === "/api/automation/config") {
        sendJson(res, loadConfig());
        return;
      }

      if (url.pathname === "/api/automation/scan" && req.method === "POST") {
        sendJson(res, await runAutomation("manual-scan"));
        return;
      }

      if (url.pathname === "/api/automation/import-inbox" && req.method === "POST") {
        const config = loadConfig();
        const state = loadState();
        const inbox = importInbox(config, state);
        saveState(state);
        sendJson(res, { inbox, state: summarizeState(state) });
        return;
      }

      if (url.pathname === "/api/automation/import-quote-text" && req.method === "POST") {
        const body = await readJsonBody(req);
        sendJson(res, importQuoteText(body.text || "", body.fallbackSource || "OCR"));
        return;
      }

      if (url.pathname === "/api/automation/capture-active-window" && req.method === "POST") {
        const body = await readJsonBody(req);
        sendJson(res, captureWindow("capture-active-window.ps1", body.label || "active-window"));
        return;
      }

      if (url.pathname === "/api/automation/capture-screen" && req.method === "POST") {
        const body = await readJsonBody(req);
        sendJson(res, captureWindow("capture-screen.ps1", body.label || "screen"));
        return;
      }

      if (url.pathname === "/api/automation/ocr-image" && req.method === "POST") {
        const body = await readJsonBody(req);
        sendJson(res, await ocrImageOpenAI(body.imagePath || ""));
        return;
      }

      if (url.pathname === "/api/automation/ocr-image-free" && req.method === "POST") {
        const body = await readJsonBody(req);
        sendJson(res, ocrImageWindows(body.imagePath || ""));
        return;
      }

      if (url.pathname === "/api/automation/observe-quote-screen" && req.method === "POST") {
        const body = await readJsonBody(req);
        sendJson(res, observeQuoteScreen(body.mode || "active"));
        return;
      }

      if (url.pathname === "/api/automation/import-xiaoge-long-screenshot" && req.method === "POST") {
        const body = await readJsonBody(req);
        sendJson(res, importXiaogeLongScreenshot(body.imagePath || ""));
        return;
      }

      if (url.pathname === "/api/automation/upload-image" && req.method === "POST") {
        const body = await readJsonBody(req);
        sendJson(res, uploadImage(body));
        return;
      }

      if (url.pathname === "/api/kdocs/open" && req.method === "POST") {
        const body = await readJsonBody(req);
        sendJson(res, openKdocsSource(body.id || "ah-kdocs"));
        return;
      }

      if (url.pathname === "/api/kdocs/collect" && req.method === "POST") {
        const body = await readJsonBody(req);
        sendJson(res, collectKdocsWithStatus(body.id || "ah-kdocs"));
        return;
      }

      if (url.pathname === "/api/automation/start" && req.method === "POST") {
        startTimer();
        sendJson(res, { running: true });
        return;
      }

      if (url.pathname === "/api/automation/stop" && req.method === "POST") {
        stopTimer();
        sendJson(res, { running: false });
        return;
      }

      serveStatic(req, res);
    } catch (error) {
      sendJson(res, { error: error.message }, 500);
    }
  });
}

function summarizeState(state) {
  return {
    leads: state.leads.length,
    quotes: state.quotes.length,
    runs: state.runs.length,
    lastRun: state.runs[0] || null
  };
}

function main() {
  fs.mkdirSync(path.join(root, "data", "inbox", "quotes"), { recursive: true });
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  if (!fs.existsSync(statePath)) saveState({ leads: [], quotes: [], runs: [] });

  createServer().listen(port, host, () => {
    console.log(`好羊毛自动化服务：http://${host}:${port}`);
    console.log("API: /api/automation/status /api/automation/scan /api/automation/state");
    startTimer();
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  captureWindow,
  extractDealLines,
  importInbox,
  importAhKdocsOcrText,
  importAhKdocsQuotes,
  importXiaogeLongScreenshot,
  importQuoteText,
  collectKdocsSource,
  loadConfig,
  loadState,
  openKdocsSource,
  observeQuoteScreen,
  ocrImageWindowsJson,
  ocrImageWindows,
  parseAhKdocsOcrTextV2,
  parseAhKdocsOcrLayout,
  parseLeadLine,
  parseQuoteLine,
  parseRecyclerOcrText,
  recordKdocsSuccess,
  runAutomation,
  scanSources,
  uploadImage,
  syncCloudSnapshot
};
