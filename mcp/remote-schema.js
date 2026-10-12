"use strict";

const string = (maxLength = 200) => ({ type: "string", minLength: 1, maxLength });
const object = (properties, required = Object.keys(properties)) => ({ type: "object", additionalProperties: false, properties, required });
const timestamp = { ...string(40), format: "date-time" };
const money = { type: "number", minimum: 0, maximum: 200000 };
const verification = object({
  status: { enum: ["verified", "unknown", "failed"] },
  detail: string(1000)
});
const evidence = object({
  source: string(100),
  reference: string(500),
  excerpt: string(2000),
  observedAt: timestamp,
  validUntil: timestamp
});
const sku = { ...string(300), description: "完整型号、内存/容量、精确颜色、地区、激活/封装状态、套装等；不支持的或不完整规格只会待确认。" };
const tools = [
  {
    name: "get_pending_checks", description: "读取当前凭证授权空间内待核价商品；分页最多 50 条。",
    inputSchema: object({ offset: { type: "integer", minimum: 0, maximum: 10000 }, limit: { type: "integer", minimum: 1, maximum: 50 } }, []),
    annotations: { readOnlyHint: true }
  },
  {
    name: "submit_lead", description: "提交或补充优惠核验。不能设置利润、门槛、通知状态或身份；相同机会不会重复提醒。",
    inputSchema: object({
      idempotencyKey: string(100), opportunityKey: { ...string(100), description: "稳定的商品活动 ID；补充核验时保持不变。" },
      text: string(4000), sku, buyPrice: { ...money, minimum: 1 }, evidence,
      conditions: object({ finalPrice: verification, eligibility: verification, stock: verification, purchaseRules: verification })
    }), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  },
  {
    name: "submit_quote", description: "针对 checkId 提交单个回收报价及证据。支持结构化价格及可选单行/OCR 文本交叉校验。",
    inputSchema: object({
      idempotencyKey: string(100), checkId: string(100), sku, price: { ...money, minimum: 1 },
      text: string(4000), evidence,
      conditions: object({ specification: verification, acceptance: verification, deductions: verification, settlement: verification })
    }, ["idempotencyKey", "checkId", "sku", "price", "evidence", "conditions"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  },
  {
    name: "get_status", description: "读取当前核验结果、证据、净利润与通知状态；省略 checkId 时分页列出当前空间记录。",
    inputSchema: object({ checkId: string(100), offset: { type: "integer", minimum: 0, maximum: 10000 }, limit: { type: "integer", minimum: 1, maximum: 50 } }, []),
    annotations: { readOnlyHint: true }
  }
];

// Validates exactly the bounded JSON Schema subset used above; unknown fields fail closed.
function validate(value, schema, location = "arguments") {
  const fail = () => { throw new Error(`Invalid ${location}`); };
  if (schema.enum && !schema.enum.includes(value)) fail();
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail();
    if (Object.keys(value).some((key) => !Object.hasOwn(schema.properties, key))) fail();
    for (const key of schema.required) if (!Object.hasOwn(value, key)) fail();
    for (const key of Object.keys(value)) validate(value[key], schema.properties[key], `${location}.${key}`);
  }
  if (schema.type === "string") {
    if (typeof value !== "string" || value.trim().length < schema.minLength || value.length > schema.maxLength || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) fail();
    if (schema.format === "date-time" && (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value)))) fail();
  }
  if (schema.type === "number" || schema.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value) || value < schema.minimum || value > schema.maximum) fail();
    if (schema.type === "integer" && !Number.isInteger(value)) fail();
    if (schema.type === "number" && Math.abs(value * 100 - Math.round(value * 100)) > 0.000001) fail();
  }
}

module.exports = { tools, validate };
