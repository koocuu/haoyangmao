const crypto = require("crypto");

const KNOWN_SOURCES = ["小鸽", "小鸽手机回收", "踏浪", "踏浪数码"];
const COLOR_WORDS = [
  "黑色",
  "白色",
  "深蓝色",
  "青雾蓝色",
  "鼠尾草绿色",
  "薰衣草紫色",
  "薰衣草紫",
  "橙色",
  "银色",
  "粉色",
  "绿色",
  "蓝色",
  "金色",
  "原色"
];

const COLOR_ALIASES = {
  青霉蓝色: "青雾蓝色",
  顸激活: "预激活",
  預激活: "预激活"
};

function parseRecyclerOcrText(text, options = {}) {
  const sourceName = options.sourceName || detectSource(text) || options.fallbackSource || "OCR";
  const lines = normalizeLines(text);
  const quotes = parseColumnarOcrText(text, sourceName);
  if (quotes.length > 0 && lines.length === 1 && lines[0].length > 200) {
    return dedupeQuotes(quotes);
  }
  let currentModel = "";
  let currentStorage = "";
  let pendingColor = "";

  for (const line of lines) {
    const modelInfo = parseModelLine(line);
    if (modelInfo) {
      currentModel = modelInfo.model || currentModel;
      currentStorage = modelInfo.storage || currentStorage;

      if (modelInfo.price) {
        quotes.push(buildQuote({
          sourceName,
          model: currentModel,
          storage: currentStorage,
          color: modelInfo.color,
          price: modelInfo.price,
          rawText: line
        }));
      }
      continue;
    }

    const color = detectColor(line);
    const price = detectPrice(line);

    if (color && price && currentModel) {
      quotes.push(buildQuote({
        sourceName,
        model: currentModel,
        storage: currentStorage,
        color,
        price,
        rawText: line
      }));
      pendingColor = "";
      continue;
    }

    if (color) {
      pendingColor = color;
      continue;
    }

    if (price && pendingColor && currentModel) {
      quotes.push(buildQuote({
        sourceName,
        model: currentModel,
        storage: currentStorage,
        color: pendingColor,
        price,
        rawText: `${pendingColor} ${line}`
      }));
      pendingColor = "";
    }
  }

  return dedupeQuotes(quotes);
}

function normalizeLines(text) {
  return normalizeOcrText(text)
    .replace(/\r/g, "\n")
    .replace(/[|｜]/g, " ")
    .replace(/[（]/g, "(")
    .replace(/[）]/g, ")")
    .replace(/[Ｇｇ]/g, "G")
    .replace(/[Ｔｔ]/g, "T")
    .split(/\n|(?<=\d{4,5})\s+(?=[\u4e00-\u9fa5A-Za-z])/)
    .filter((line) => !line.trim().startsWith("#"))
    .map((line) =>
      line
        .replace(/\s+/g, " ")
        .replace(/iPhone\s+/gi, "iPhone")
        .replace(/ProMa\s*x/gi, "ProMax")
        .replace(/Pro\s*Max/gi, "ProMax")
        .replace(/(\d)\s*(G|GB)\b/gi, "$1G")
        .replace(/(\d)\s*(T|TB)\b/gi, "$1TB")
        .trim()
    )
    .filter(Boolean);
}

function normalizeOcrText(text) {
  let normalized = String(text || "");
  for (const color of COLOR_WORDS) {
    const spaced = color.split("").join("\\s*");
    normalized = normalized.replace(new RegExp(spaced, "g"), color);
  }
  for (const [from, to] of Object.entries(COLOR_ALIASES)) {
    const spaced = from.split("").join("\\s*");
    normalized = normalized.replace(new RegExp(spaced, "g"), to);
  }
  return normalized
    .replace(/i\s*Phone/gi, "iPhone")
    .replace(/lPhone/gi, "iPhone")
    .replace(/顸\s*激\s*活/g, "预激活")
    .replace(/预\s*激\s*活/g, "预激活");
}

function parseColumnarOcrText(text, sourceName) {
  const normalized = normalizeOcrText(text).replace(/\s+/g, " ").trim();
  const modelRegex = /(iPhone\s*\d{1,2}\s*(?:Pro\s*Max|ProMax|Pro|Air|e)?)[^\d]{0,8}(\d{2,4}\s*G|1\s*TB|2\s*TB)\s*(?:[（(]\s*\d{3,5}\s*[)）])?/gi;
  const matches = [...normalized.matchAll(modelRegex)];
  const quotes = [];

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const next = matches[index + 1];
    const block = normalized.slice(match.index + match[0].length, next ? next.index : normalized.length);
    const nextBlock = next ? normalized.slice(next.index + next[0].length, matches[index + 2] ? matches[index + 2].index : normalized.length) : "";
    const model = normalizeModel(match[1].replace(/\s+/g, ""));
    const storage = normalizeStorage(match[2].replace(/\s+/g, ""));
    const colors = extractColors(block);
    let prices = extractPrices(block);
    if (colors.length > 0 && prices.length === 0 && nextBlock) {
      prices = extractPrices(nextBlock);
    }

    const pairCount = Math.min(colors.length, prices.length);
    for (let i = 0; i < pairCount; i += 1) {
      quotes.push(buildQuote({
        sourceName,
        model,
        storage,
        color: colors[i],
        price: prices[i],
        rawText: `${colors[i]} ${prices[i]}`
      }));
    }
  }

  return quotes;
}

function extractColors(text) {
  const hits = [];
  for (const color of COLOR_WORDS) {
    let start = 0;
    while (true) {
      const index = text.indexOf(color, start);
      if (index === -1) break;
      hits.push({ color, index });
      start = index + color.length;
    }
  }
  const accepted = [];
  for (const hit of hits.sort((a, b) => a.index - b.index || b.color.length - a.color.length)) {
    const start = hit.index;
    const end = hit.index + hit.color.length;
    const overlaps = accepted.some((item) => start < item.end && end > item.start);
    if (!overlaps) accepted.push({ ...hit, start, end });
  }
  return accepted.sort((a, b) => a.index - b.index).map((hit) => hit.color);
}

function extractPrices(text) {
  return [...text.matchAll(/\b(\d{4,5})\b/g)]
    .map((match) => Number(match[1]))
    .filter((price) => price >= 500 && price <= 30000);
}

function parseModelLine(line) {
  const normalized = line
    .replace(/\s+/g, "")
    .replace(/ProMaX/gi, "ProMax")
    .replace(/ProMax/gi, "ProMax");

  const modelMatch = normalized.match(/(iPhone\d{1,2}(?:ProMax|Pro|Air|e)?)/i);
  if (!modelMatch) return null;

  const rest = normalized.slice(modelMatch.index + modelMatch[1].length);
  const storageMatch = rest.match(/(\d{2,4}G|1TB|2TB)/i);
  const color = detectColor(line);
  const price = color ? detectPrice(line) : null;

  return {
    model: normalizeModel(modelMatch[1]),
    storage: storageMatch ? normalizeStorage(storageMatch[1]) : "",
    color,
    price
  };
}

function normalizeModel(value) {
  return value
    .replace(/^iphone/i, "iPhone")
    .replace(/promax$/i, "ProMax")
    .replace(/pro$/i, "Pro")
    .replace(/air$/i, "Air");
}

function normalizeStorage(value) {
  const normalized = String(value).toUpperCase().replace(/GB$/, "G").replace(/^1T$/, "1TB").replace(/^2T$/, "2TB");
  if (normalized === "1L") return "1TB";
  return normalized;
}

function detectSource(text) {
  return KNOWN_SOURCES.find((source) => String(text || "").includes(source)) || "";
}

function detectColor(line) {
  return COLOR_WORDS.find((color) => line.includes(color)) || "";
}

function detectPrice(line) {
  const clean = String(line || "").replace(/[,，]/g, "");
  const candidates = [...clean.matchAll(/\b(\d{4,5})\b/g)]
    .map((match) => Number(match[1]))
    .filter((price) => price >= 500 && price <= 30000);
  if (!candidates.length) return null;
  return candidates[candidates.length - 1];
}

function buildQuote({ sourceName, model, storage, color, price, rawText }) {
  const skuName = [model, storage, color, "全新"].filter(Boolean).join(" ");
  return {
    id: makeId("quote", `${sourceName}:${skuName}:${price}`),
    skuName,
    sourceType: "recycler",
    sourceName,
    price,
    conditionNote: color || "",
    observedAt: new Date().toISOString(),
    confidence: sourceName.includes("小鸽") || sourceName.includes("踏浪") ? 0.92 : 0.82,
    rawText
  };
}

function parseXiaogeOcrLayout(ocrResult, options = {}) {
  const sourceName = options.sourceName || options.fallbackSource || "小鸽";
  const width = Number(ocrResult.width || 599);
  const priceMinX = width * 0.62;
  const priceMaxX = width * 0.84;
  const leftMaxX = width * 0.61;
  const lines = (ocrResult.lines || [])
    .map((line) => {
      const words = line.words || [];
      const x = words.length ? Math.min(...words.map((word) => Number(word.x || 0))) : 0;
      const y = words.length ? Math.min(...words.map((word) => Number(word.y || 0))) : 0;
      return {
        text: normalizeLayoutText(line.text),
        rawText: line.text || "",
        x,
        y
      };
    })
    .filter((line) => line.text);

  const productAnchors = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!isDateLine(lines[index].text)) continue;
    const productLine = findProductLineBefore(lines, index, leftMaxX);
    if (productLine) {
      productAnchors.push({ name: productLine.text, y: lines[index].y });
    }
  }

  const quotes = [];
  for (const line of lines) {
    if (line.x < priceMinX || line.x > priceMaxX) continue;
    const price = parseLayoutPrice(line.text);
    if (!price) continue;

    const labelLine = findSameRowLabel(lines, line.y, leftMaxX);
    if (!labelLine) continue;
    const label = cleanupVariant(labelLine.text);
    if (!label || hasBrokenText(label) || isNoiseLine(label) || isDateLine(label)) continue;

    const anchor = [...productAnchors].reverse().find((item) => item.y < line.y + 8);
    let product = anchor?.name || "";
    let variant = label;
    if (!product && !isLikelyLayoutProduct(label)) continue;
    if (!product || isLikelyLayoutProduct(label)) {
      product = label;
      variant = "";
    }
    if (!product || isNoiseLine(product)) continue;
    if (hasBrokenText(product)) continue;

    quotes.push(buildLayoutQuote({
      sourceName,
      product,
      variant,
      price,
      rawText: `${product} ${variant} ${price}`.trim()
    }));
  }

  return dedupeQuotes(quotes);
}

function normalizeLayoutText(text) {
  let normalized = String(text || "")
    .replace(/\s+/g, " ")
    .replace(/OSmO/gi, "Osmo")
    .replace(/NanO/gi, "Nano")
    .replace(/VIog/gi, "Vlog")
    .replace(/lnsta/gi, "Insta")
    .replace(/U ltra/gi, "Ultra")
    .replace(/2C24/g, "2024")
    .trim();
  normalized = normalized.replace(/([\u4e00-\u9fa5])\s+(?=[\u4e00-\u9fa5])/g, "$1");
  normalized = normalized
    .replace(/\s+([）)])/g, "$1")
    .replace(/([（(])\s+/g, "$1")
    .replace(/引/g, ")")
    .replace(/(\d)\s+(G|GB|TB)\b/gi, "$1$2");
  return normalized.trim();
}

function isDateLine(text) {
  return /\d{2}\s*[．.]\s*\d{2}\s*\d{2}\s*[：:]\s*\d{2}/.test(text);
}

function findProductLineBefore(lines, dateIndex, leftMaxX) {
  for (let index = dateIndex - 1; index >= Math.max(0, dateIndex - 4); index -= 1) {
    const line = lines[index];
    if (line.x > leftMaxX) continue;
    if (isNoiseLine(line.text) || isDateLine(line.text)) continue;
    return line;
  }
  return null;
}

function findSameRowLabel(lines, y, leftMaxX) {
  let best = null;
  let bestDistance = Infinity;
  for (const line of lines) {
    if (line.x > leftMaxX) continue;
    if (isDateLine(line.text) || isNoiseLine(line.text)) continue;
    const distance = Math.abs(line.y - y);
    if (distance <= 12 && distance < bestDistance) {
      best = line;
      bestDistance = distance;
    }
  }
  return best;
}

function parseLayoutPrice(text) {
  const compact = String(text || "").replace(/\s+/g, "");
  const match = compact.match(/^\d{2,5}$/);
  if (!match) return null;
  const price = Number(match[0]);
  if (price < 50 || price > 30000) return null;
  return price;
}

function cleanupVariant(text) {
  return String(text || "")
    .replace(/查看更多.*/g, "")
    .replace(/暂时不收/g, "")
    .trim();
}

function isNoiseLine(text) {
  return /^(全新|其他|任天堂|索尼|戴森|大疆|影石|拍立得|饮品配件|首页|回收价|定价|我的|查看更多|暂无|0|·)$/.test(String(text || "").trim());
}

function hasBrokenText(text) {
  return /[\uFFFD�]/.test(String(text || ""));
}

function isLikelyLayoutProduct(text) {
  return /(Osmo|Insta360|instax|吹风机|吸尘器|Digital Slim|相纸|手柄|支架|Pocket|Action|Ace Pro)/i.test(text);
}

function buildLayoutQuote({ sourceName, product, variant, price, rawText }) {
  const cleanedProduct = cleanupProduct(product);
  const skuName = [cleanedProduct, variant, "全新"].filter(Boolean).join(" ");
  return {
    id: makeId("quote", `${sourceName}:${skuName}:${price}`),
    skuName,
    sourceType: "recycler",
    sourceName,
    price,
    conditionNote: variant,
    observedAt: new Date().toISOString(),
    confidence: 0.88,
    rawText
  };
}

function cleanupProduct(text) {
  return String(text || "")
    .replace(/^》\s*0\s*Nano/i, "Osmo Nano")
    .replace(/^0\s*Nano/i, "Osmo Nano")
    .replace(/^O\s*smo/i, "Osmo")
    .replace(/礻目纸/g, "相纸")
    .replace(/^Insta360\s+GO\s+U\s*ltra/i, "Insta360 GO Ultra")
    .trim();
}

function dedupeQuotes(quotes) {
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

function makeId(prefix, value) {
  const hash = crypto.createHash("sha1").update(value).digest("hex").slice(0, 12);
  return `${prefix}-${hash}`;
}

module.exports = {
  parseRecyclerOcrText,
  parseXiaogeOcrLayout,
  normalizeLines,
  parseModelLine
};
