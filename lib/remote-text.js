"use strict";
const crypto = require("crypto");
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


module.exports = { parseLeadLine, parseQuoteLine, hasLikelyProduct };
