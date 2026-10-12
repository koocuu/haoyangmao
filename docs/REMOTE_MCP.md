# Grok Bot 远程核价接入

远程接口运行在现有 Vercel 项目，沿用 GitHub 主分支自动部署、Node、现有网页和报价/利润计算代码。核验记录使用独立的私有 Vercel Blob，原有公开 AH 报价存储保持不变；没有引入数据库、队列或新平台。

生产 MCP 地址：`https://haoyangmao.koocuu.com/api/mcp`。电脑无需常驻运行。验证结果及尚未配置的环节见 [验证记录](REMOTE_MCP_VALIDATION.md)。

## 地址与运行

实际本地 MCP 地址：`http://127.0.0.1:8766/mcp`。本地网页：`http://127.0.0.1:8765`。

需要 Node 22。项目根目录运行：

```powershell
Copy-Item config/remote-mcp.example.json config/remote-mcp.local.json
$env:HYM_GROK_TOKEN = node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))"
$env:HYM_DASHBOARD_TOKEN = node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))"
npm run mcp:remote
```

凭证请通过你已有的秘密管理方式分别配置到服务端与 Bot/只读网页，不要提交 Git、写进 URL 或聊天记录。重启后需要提供相同凭证，或同时更新客户端完成轮换。配置文件只引用环境变量名，不保存凭证。

另一个终端运行 `npm start`，在现有网页「Grok 商品核验」中展开连接设置，填写 `http://127.0.0.1:8766/mcp` 和独立只读凭证。连接后自动更新。MCP 进程不启动 AH 采集、上传或本地截图工具。`HYM_MCP_PORT` 可修改端口；`HYM_MCP_CONFIG` 可指定本地受信配置文件。监听地址固定为 `127.0.0.1`。

### Vercel 配置及部署

在现有项目 `haoyangmao` 的 Production 环境设置以下变量；更改后重新部署才会生效。Preview 不共享生产 MCP 凭证或私有数据。

| 变量 | 用途 |
|---|---|
| `HYM_MCP_CONFIG_JSON` | 受信配置 JSON，参考 `config/remote-mcp.example.json`；删除 `localImportWorkspace`，Host 设为 `haoyangmao.koocuu.com`，Origin 设为 `https://haoyangmao.koocuu.com` |
| `HYM_MCP_BLOB_READ_WRITE_TOKEN` | 独立 **Private** Blob 的读写凭证；不要替换原 `BLOB_READ_WRITE_TOKEN` |
| `HYM_GROK_TOKEN` | 至少 32 字节随机值，授权四个工具；交给 Bot |
| `HYM_DASHBOARD_TOKEN` | 独立随机值，仅授权 `get_status`；用于网页 |
| `HYM_TELEGRAM_BOT_TOKEN` | 提醒机器人凭证；未设置时通知为 `not_configured` |
| `HYM_TELEGRAM_CHAT_ID` | 提醒接收会话，由 workspace 的 `telegramChatEnv` 引用 |

Blob 与 Functions 使用同一区域 `iad1`。私有存储为 `haoyangmao-mcp-private`，公开 AH 存储为 `haoyangmao-blob`。服务端凭证不进入网页构建内容。

执行 `npm test` 后提交并推送 `main`，现有 GitHub 集成自动部署。确认 Production 部署为对应提交且 READY，再用 MCP POST 验证。浏览器直接 GET `/api/mcp` 返回拒绝/405 属正常行为。不要公开本地 8765/8766/9223 端口、stdio MCP 或截图工具。

本机凭证交接文件为项目根目录 `.env.production-mcp.json`（Git/部署忽略，Windows ACL 限制为当前账户）。只复制所需凭证到受信客户端，不要放入聊天、Git 或公开文档。轮换凭证需同步更新客户端并重新部署。

## MCP 协议及客户端

使用 [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) 的无会话 JSON 响应模式，支持 `2025-11-25`、`2025-06-18` 和 `2025-03-26`。GET/DELETE 返回 405，不提供旧 HTTP+SSE `/sse`。每个 POST 是一条 JSON-RPC 消息，通知接受后返回空 202；工具业务错误为 `isError: true`。

这是面向私人 Bot 的预配置 Bearer 接口，**没有 OAuth 自动发现或交互授权**。Grok Bot 的 MCP 客户端需要支持自定义 Authorization 和上述 Streamable HTTP 协议；尚未连接真实 Grok 账号，也未假定 Grok 产品界面支持任意远程 MCP。

客户端配置所需的四个值：

| 项 | 值 |
|---|---|
| URL | `https://haoyangmao.koocuu.com/api/mcp`；本地为 `http://127.0.0.1:8766/mcp` |
| transport | Streamable HTTP |
| Authorization | `Bearer <HYM_GROK_TOKEN>` |
| headers | `Content-Type: application/json`、`Accept: application/json, text/event-stream`、初始化后 `MCP-Protocol-Version: 2025-11-25` |

先调用 `initialize`，再发 `notifications/initialized`，然后 `tools/list` 获取当前凭证有权使用的工具。服务端只公开下面四个工具，不提供支付、下单、桌面控制或平台风控绕过能力。

## 工具 Schema

完整可直接交给 Bot 的 JSON Schema：[remote-tools.schema.json](remote-tools.schema.json)。单一运行时来源为 `mcp/remote-schema.js`；`node scripts/remote-schema.js` 输出同样的 JSON。`tools/list` 只返回凭证授权的工具子集。

| 工具 | 参数 | 返回 |
|---|---|---|
| `get_pending_checks` | 可选 `offset`、`limit`（1–50） | `items`、`nextOffset`、`total` |
| `submit_lead` | `idempotencyKey`、`opportunityKey`、`text`、`sku`、`buyPrice`、`evidence`、`conditions` | 核验记录、计算结果、通知状态、`submissionId`、`replayed` |
| `submit_quote` | `idempotencyKey`、`checkId`、`sku`、`price`、`evidence`、`conditions`；可选 `text` | 同上 |
| `get_status` | 可选 `checkId`；列表模式支持 `offset`、`limit` | 单条核验或分页列表，读取时重新判断有效期 |

所有对象拒绝未知字段。金额为人民币，最多两位小数，不接受调用方利润/成本/门槛/身份/通知状态。字符串、请求体、分页、队列与记录总量均设上限。

`evidence` 必须包含：

- `source`：来自管理员配置的来源白名单。
- `reference`：来源链接、截图 ID 或可追溯的证据编号。作为普通文本保存，服务端不会请求该地址、读取本地路径或执行内容。
- `excerpt`：支持价格、规格和条件的原文摘要；不要包含密码、账号令牌等秘密。
- `observedAt`、`validUntil`：带时区的 ISO 时间。拒绝未来观测和 7 天前的观测；服务端 TTL 仍会限制有效期，Bot 不能延长它。

每个条件是 `{ "status": "verified|unknown|failed", "detail": "核验依据或缺失项" }`。

- 购买条件：`finalPrice`（最终实付）、`eligibility`（账号/地区/会员/券资格）、`stock`（库存）、`purchaseRules`（补贴、限购、以旧换新等限制）。
- 回收条件：`specification`（SKU/颜色/版本/激活/封装/套装）、`acceptance`（收货资格、地区与时效）、`deductions`（扣款/手续费，price 必须是扣款后的净回收额）、`settlement`（付款与结算条件）。

`verified` 是授权 Bot 基于证据的核验声明，不等于系统独立访问平台验证。拿不准必须报 `unknown`。系统交叉核验文本、规格、金额、时间和完整性，无法凭字符串证明截图真实性。

### 一轮调用示例

先用真实当前时间生成证据时间，以下占位时间需要替换，不可照抄过去日期：

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "submit_lead",
    "arguments": {
      "idempotencyKey": "pdd-activity-001-check-1",
      "opportunityKey": "pdd-activity-001",
      "text": "PDD iPhone 16 256G 国行 黑色 全新未激活 券后 5599",
      "sku": "iPhone 16 256G 国行 黑色 全新未激活",
      "buyPrice": 5599,
      "evidence": {
        "source": "PDD",
        "reference": "activity-001/product-001/screenshot-001",
        "excerpt": "券后实付5599，国行黑色256G全新未激活；库存及购买资格已核对",
        "observedAt": "<当前ISO时间>",
        "validUntil": "<当前时间后30分钟>"
      },
      "conditions": {
        "finalPrice": { "status": "verified", "detail": "结算页显示5599" },
        "eligibility": { "status": "verified", "detail": "目标用户已满足券资格" },
        "stock": { "status": "verified", "detail": "目标地区有货" },
        "purchaseRules": { "status": "verified", "detail": "无以旧换新；限购一件，资格可用" }
      }
    }
  }
}
```

保存返回的 `structuredContent.id` 作为 `checkId`，随后调用：

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "submit_quote",
    "arguments": {
      "idempotencyKey": "quote-activity-001-check-1",
      "checkId": "<submit_lead 返回的 id>",
      "sku": "iPhone 16 256G 国行 黑色 全新未激活",
      "price": 5800,
      "text": "iPhone 16 256G 国行 黑色 全新未激活 回收 5800",
      "evidence": {
        "source": "小鸽",
        "reference": "quote-screen-001",
        "excerpt": "对应规格净回收5800，无额外扣费，收货地区与结算条件已确认",
        "observedAt": "<当前ISO时间>",
        "validUntil": "<当前时间后30分钟>"
      },
      "conditions": {
        "specification": { "status": "verified", "detail": "完整SKU和封装状态一致" },
        "acceptance": { "status": "verified", "detail": "地区与寄送时效满足" },
        "deductions": { "status": "verified", "detail": "净额5800，无额外扣款" },
        "settlement": { "status": "verified", "detail": "验收后当日结算" }
      }
    }
  }
}
```

默认结果：`5800 - 5599 - 20运费 - 0平台费 - 30风险缓冲 = 151`。门槛 80，因此在所有条件满足且报价未过期时为 `eligible`。

Bot 每轮先读 `get_pending_checks`，再逐条补充购买和回收证据，用 `get_status` 确认处理。待办中本地导入的 `opportunityKey` 必须原样用于 `submit_lead`。同一机会补充证据时保持 `opportunityKey`、SKU、来源和 `reference` 稳定，另换 `idempotencyKey`；相同幂等键重试必须发送相同业务参数。

## 匹配、利润与提醒

前后端复用 `lib/deal-engine.js`；单行/OCR 文本复用现有解析器。SKU 模糊识别仅用于候选，自动提醒额外要求规范化完整 SKU 一致，避免把近似颜色、容量、激活、套装当成同款。文字别名或不支持的型号可能保守地留待确认。手机必须含容量、单一颜色、地区、激活、成色；平板要求容量/地区；主机要求地区；所有产品要求可识别的型号与成色。未能识别的型号不会自动放行。

有效报价按同一来源/规格取最近核验，再从有效且已核实的匹配报价取最低价。其他来源旧 AH 行情不会自动当作 Bot 已核实的回收保证。结构化 `price` 是净回收额，购买实付含购买端费用；配置中的运费是额外寄出成本，避免重复扣费。

在 `HYM_MCP_CONFIG_JSON`（本地为 `config/remote-mcp.local.json`）各 workspace 的 `policy` 中配置 `minimumProfit`、`shippingCost`、`platformCost`、`riskBuffer` 及购买/报价有效分钟数，重新部署/重启后生效。默认 80 / 20 / 0 / 30 元，购买 60 分钟、报价 30 分钟。条件缺失、失败、价格文本冲突、旧报价均返回 `pending_confirmation`；完整但未过门槛为 `below_threshold`。

提醒使用 Telegram 固定 API（`api.telegram.org`，禁重定向、10 秒超时、限制响应体）。配置 `HYM_TELEGRAM_BOT_TOKEN` 及 workspace 的 `telegramChatEnv` 所指定的目标 ID。未配置时保存 `not_configured`，网页仍可看；配置并重新部署后，后续提交或幂等回放只会提醒该条**当时仍有效**的机会。只读查询不触发提醒。Vercel 不依赖常驻进程或后台定时器。测试注入模拟通知器，不发送真实消息。

通知先原子落盘占位，再进行一次发送。确认成功为 `sent`；断网/超时/崩溃留下 `delivery_unknown`，**不自动重发**，避免第三方已收到但响应丢失时重复提醒。此设计保证最多尝试一次，不能保证第三方恰好送达一次；需要人工检查不确定记录。相同 workspace + 来源 + reference + 完整 SKU 在 30 天内最多提醒一次，即使更换幂等键或 opportunityKey。新的真实活动应使用新的来源活动编号。

## 存储、权限与网页

- 私有 Blob 保存最近 7 天的核验、来源、证据、报价、最多 10 次线索旧版本、幂等收据及通知状态；去重通知摘要保存 30 天。本地开发保存到 `data/private/remote-checks.json`。
- 最多 200 个近期机会、每机会 20 条报价、5000 条幂等收据、10000 条通知摘要。达到上限拒绝新写入，不提前清空幂等或通知保护。云端在请求中清理过期数据；过期读取实时计算。
- 云端使用 Blob ETag 条件写入，首次创建禁止覆盖，读取不使用缓存；跨实例冲突有界重试，提交结果不确定时不发送通知。文件损坏或存储失败时拒绝处理，不能静默清空重建。本地使用进程锁和原子文件替换；仅本地崩溃遗留锁需要人工确认旧进程已停止后清理。
- 跨实例限速与并发占位也写入私有 Blob，因此一次 MCP 请求会使用数次 Blob 操作。Hobby 配额需在 Storage/Usage 监控；网页仅连接且可见时轮询，不自动升级套餐。适合个人低频核价。
- token 固定映射 workspace 与工具权限；不信任请求传入身份。`get_status`、`submit_quote` 都按 workspace 校验 checkId。来源与商品品类由配置白名单限制。
- 仅本地开启 `localImportWorkspace` 时，现有 `data/state.json` 中最近 7 天且品类获准的线索成为该空间待办；云端由 Bot 提交线索，不访问本机文件。
- 本地网页也必须使用只读 Bearer 凭证连接 MCP，没有新增匿名核验读取接口。静态文件服务改为页面资源及图片证据白名单，私有文件、配置、`.env` 和 Git 目录不可下载。
- 云端网页展开「连接商品核验」，默认地址为本站 `/api/mcp`，填写 **HYM_DASHBOARD_TOKEN**；它只有 `get_status` 权限，凭证仅存页内内存，断开/刷新即清除。无需把写入凭证交给网页。
- 将网页的精确 HTTPS Origin 加入 `allowedOrigins`。CORS 不支持任意来源、不使用 Cookie，服务端始终要求 Bearer。生产配置只允许自定义域名与其 Origin。
- 网页每 30 秒更新净利润、待确认原因、证据时间及通知状态；原 AH 报价和手动分析继续工作，核验记录不进入公开 Blob。

## 本地验证

```powershell
npm test
npm run test:remote
node tests/remote-mcp-e2e.js --preview
```

`--preview` 仅启动随机 loopback 端口和临时模拟核验数据，输出网页地址；按 Enter 继续剩余测试并清理。测试不启动采集、不修改实际 state.json、不发消息、不部署。

2026-10-12 已执行的结果见 [REMOTE_MCP_VALIDATION.md](REMOTE_MCP_VALIDATION.md)。模拟 Bot 验证不等同于真实 Grok 账号接入，Telegram 实际送达取决于通道配置。
