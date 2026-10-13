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
const sku = { ...string(300), description: "完整品牌、型号、内存/容量、精确颜色、地区、成色、激活状态与套装等；Mac 另含芯片、统一内存。未知字段写字段名 unknown，不自动补齐；不支持的或不完整规格只会待确认。仍为字符串，不增加 JSON 字段。" };
const quoteItem = object({
  idempotencyKey: string(100), sku, price: { ...money, minimum: 1 }, text: string(4000), evidence,
  conditions: object({ specification: verification, acceptance: verification, deductions: verification, settlement: verification })
}, ["idempotencyKey", "sku", "price", "evidence", "conditions"]);
const quotes = { type: "array", minItems: 1, maxItems: 10, items: quoteItem };
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
    inputSchema: object({ checkId: string(100), includeVoided: { type: "boolean" }, offset: { type: "integer", minimum: 0, maximum: 10000 }, limit: { type: "integer", minimum: 1, maximum: 50 } }, []),
    annotations: { readOnlyHint: true }
  },
  {
    name: "submit_quotes", description: "同 checkId 批量提交最多10条回收报价。每项独立沿用submit_quote幂等语义；逐项返回成功/失败，全部处理后才计算与尝试一次通知。",
    inputSchema: object({ checkId: string(100), quotes }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  },
  {
    name: "preview_check", description: "纯内存预览购买线索与最多10条回收报价；零存储读写、零通知。沿用真实workspace策略，返回缺规格/条件和报价差异。",
    inputSchema: null,
    annotations: { readOnlyHint: true }
  },
  {
    name: "void_check", description: "作废本空间核验并保留近期审计；不可复活。重复调用保留首次原因/操作者/时间；不能撤回已开始发送的通知。",
    inputSchema: object({ checkId: string(100), reason: string(1000) }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
  }
];
tools.find(tool => tool.name === "preview_check").inputSchema = object({
  ...tools.find(tool => tool.name === "submit_lead").inputSchema.properties,
  quotes: { ...quotes, minItems: 0 }
});

// Validates exactly the bounded JSON Schema subset used above; unknown fields fail closed.
function validate(value, schema, location = "arguments") {
  const fail = () => { throw new Error(`Invalid ${location}`); };
  if (schema.enum && !schema.enum.includes(value)) fail();
  if (schema.type === "array") {
    if (!Array.isArray(value) || value.length < schema.minItems || value.length > schema.maxItems) fail();
    value.forEach((item, index) => validate(item, schema.items, `${location}.${index}`));
  }
  if (schema.type === "boolean" && typeof value !== "boolean") fail();
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

// Public Schema describes every item strictly. Runtime validates bounded outer
// shape first, then each quote separately so one bad item cannot swallow a batch.
function validateArguments(name, args) {
  const schema = tools.find(tool => tool.name === name)?.inputSchema;
  if (!schema) throw new Error("Tool not authorized");
  const outer = ["submit_quotes", "preview_check"].includes(name)
    ? { ...schema, properties: { ...schema.properties, quotes: { ...schema.properties.quotes, items: {} } } } : schema;
  validate(args, outer);
}
module.exports = { tools, validate, validateArguments, quoteItem };
