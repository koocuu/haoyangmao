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

另一个终端运行 `npm start`，在网页右上角打开「设置」，填写 `http://127.0.0.1:8766/mcp` 和独立只读凭证。连接后自动更新。MCP 进程不启动 AH 采集、上传或本地截图工具。`HYM_MCP_PORT` 可修改端口；`HYM_MCP_CONFIG` 可指定本地受信配置文件。监听地址固定为 `127.0.0.1`。

### Vercel 配置及部署

在现有项目 `haoyangmao` 的 Production 环境设置以下变量；更改后重新部署才会生效。Preview 不共享生产 MCP 凭证或私有数据。

| 变量 | 用途 |
|---|---|
| `HYM_MCP_CONFIG_JSON` | 受信配置 JSON，参考 `config/remote-mcp.example.json`；删除 `localImportWorkspace`，Host 设为 `haoyangmao.koocuu.com`，Origin 设为 `https://haoyangmao.koocuu.com` |
| `HYM_MCP_BLOB_READ_WRITE_TOKEN` | 独立 **Private** Blob 的读写凭证；不要替换原 `BLOB_READ_WRITE_TOKEN` |
| `HYM_GROK_TOKEN` | 至少 32 字节随机值；工具权限由 `clients[].tools` 明确授权，样例为七个工具；交给 Bot |
| `HYM_DASHBOARD_TOKEN` | 独立随机值，仅授权 `get_status`；网页登录复用其服务端权限，过渡期支持手动回退 |
| `HYM_TELEGRAM_BOT_TOKEN` | 提醒机器人凭证；未设置时通知为 `not_configured` |
| `HYM_TELEGRAM_CHAT_ID` | 提醒接收会话，由 workspace 的 `telegramChatEnv` 引用 |

Blob 与 Functions 使用同一区域 `iad1`。私有存储为 `haoyangmao-mcp-private`，公开 AH 存储为 `haoyangmao-blob`。服务端凭证不进入网页构建内容。

执行 `npm test` 后提交并推送 `main`，现有 GitHub 集成自动部署。确认 Production 部署为对应提交且 READY，再用 MCP POST 验证。浏览器直接 GET `/api/mcp` 返回拒绝/405 属正常行为。不要公开本地 8765/8766/9223 端口、stdio MCP 或截图工具。

本机凭证交接文件为项目根目录 `.env.production-mcp.json`（Git/部署忽略，Windows ACL 限制为当前账户）。只复制所需凭证到受信客户端，不要放入聊天、Git 或公开文档。轮换凭证需同步更新客户端并重新部署。

## MCP 协议及客户端

使用 [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) 的无会话 JSON 响应模式，支持 `2025-11-25`、`2025-06-18` 和 `2025-03-26`。GET/DELETE 返回 405，不提供旧 HTTP+SSE `/sse`。每个 POST 是一条 JSON-RPC 消息，通知接受后返回空 202；工具业务错误为 `isError: true`。

这是面向私人 Bot 的预配置 Bearer 接口，**没有 OAuth 自动发现或交互授权**。Grok Bot 的 MCP 客户端需要支持自定义 Authorization 和上述 Streamable HTTP 协议。用户已报告实际 Bot 调用；本次来源与 Huawei 规则更新后的主流程仍需由用户重新提交验收，这不等于所有线索已完成真实条件核验。

客户端配置所需的四个值：

| 项 | 值 |
|---|---|
| URL | `https://haoyangmao.koocuu.com/api/mcp`；本地为 `http://127.0.0.1:8766/mcp` |
| transport | Streamable HTTP |
| Authorization | `Bearer <HYM_GROK_TOKEN>` |
| headers | `Content-Type: application/json`、`Accept: application/json, text/event-stream`、初始化后 `MCP-Protocol-Version: 2025-11-25` |

先调用 `initialize`，再发 `notifications/initialized`，然后 `tools/list` 获取当前凭证有权使用的工具。原四个工具向后兼容，新增三工具需管理员在 Production `HYM_MCP_CONFIG_JSON` 的 Bot `tools` 列表明确加入；不会自动扩大旧凭证权限，Dashboard 仍仅 `get_status`。客户端缓存旧 Schema 时先重新连接、对照实时 `tools/list`，不能为兼容缓存放宽服务端校验。接口不提供支付、下单、桌面控制或平台风控绕过能力。

## 工具 Schema

完整可直接交给 Bot 的 JSON Schema：[remote-tools.schema.json](remote-tools.schema.json)。单一运行时来源为 `mcp/remote-schema.js`；`node scripts/remote-schema.js` 输出同样的 JSON。`tools/list` 只返回凭证授权的工具子集。

| 工具 | 参数 | 返回 |
|---|---|---|
| `get_pending_checks` | 可选 `offset`、`limit`（1–50） | `items`、`nextOffset`、`total` |
| `submit_lead` | `idempotencyKey`、`opportunityKey`、`text`、`sku`、`buyPrice`、`evidence`、`conditions` | 核验记录、计算结果、通知状态、`submissionId`、`replayed` |
| `submit_quote` | `idempotencyKey`、`checkId`、`sku`、`price`、`evidence`、`conditions`；可选 `text` | 同上 |
| `get_status` | 可选 `checkId`；列表模式支持 `offset`、`limit`、`includeVoided`（默认 false） | 单条核验或分页列表，读取时重新判断有效期；指定 checkId 可审计作废记录 |
| `submit_quotes` | `checkId`、`quotes`（1–10条）；每项为单条报价参数，去掉 `checkId` | 核验投影（顶层 `id`、`result`、`notification`）及逐项 `items` |
| `preview_check` | `submit_lead` 全部参数及 `quotes`（0–10条；每项同批量报价） | `preview: true`、`result`、`items`、`diagnostics`；不返回可用于正式提交的 checkId |
| `void_check` | `checkId`、`reason` | 核验投影、不可覆写的 `voided: { reason, by, at }`、`replayed`；`result.status` 为 `voided` |

所有对象拒绝未知字段。金额为人民币，最多两位小数，不接受调用方利润/成本/门槛/身份/通知状态。字符串、请求体、分页、队列与记录总量均设上限。

`evidence` 必须包含：

- `source`：真实直接证据出处，且必须来自管理员配置的来源白名单。样例包含 `什么值得买`、`小红书`、`微信群`、`酷安`；生产仍需同步修改 `HYM_MCP_CONFIG_JSON` 并部署代码，修改样例文件本身不会改变线上授权。
- `reference`：来源链接、截图 ID 或可追溯的证据编号。作为普通文本保存，服务端不会请求该地址、读取本地路径或执行内容。
- `excerpt`：支持价格、规格和条件的原文摘要；不要包含密码、账号令牌等秘密。
- `observedAt`、`validUntil`：带时区的 ISO 时间。拒绝未来观测和 7 天前的观测；服务端 TTL 仍会限制有效期，Bot 不能延长它。

每个条件是 `{ "status": "verified|unknown|failed", "detail": "核验依据或缺失项" }`。

- 购买条件：`finalPrice`（最终实付）、`eligibility`（账号/地区/会员/券资格）、`stock`（库存）、`purchaseRules`（补贴、限购、以旧换新等限制）。
- 回收条件：`specification`（SKU/颜色/版本/激活/封装/套装）、`acceptance`（收货资格、地区与时效）、`deductions`（扣款/手续费，price 必须是扣款后的净回收额）、`settlement`（付款与结算条件）。

`verified` 是授权 Bot 基于证据的核验声明，不等于系统独立访问平台验证。拿不准必须报 `unknown`。系统交叉核验文本、规格、金额、时间和完整性，无法凭字符串证明截图真实性。

### 来源、SKU 与新鲜度的提交约定

- 直接看到什么值得买爆料就使用 `source: "什么值得买"`；直接核实小红书原文就使用 `source: "小红书"`。仅看到微信群转述时使用 `source: "微信群"`，`reference` 可包含脱敏群标识、消息编号/时间和真实小红书原文链接，例如 `群代号/消息编号；原文 https://www.xiaohongshu.com/<真实引用>`。链接只是引用文本，不会由服务端抓取。
- 群消息自称「AH 报价」不等于已亲自核实 AH。未直接确认 AH 的报价、规格、扣费与结算条件时，不能借 `source: "AH"` 绕过来源授权，也不能把转述条件填成 `verified`。来源白名单是权限边界，不是对证据真实性的背书。
- 「踏浪」「小鸽」都是微信小程序。只有 Bot 亲自打开对应小程序，直接看到并核实报价、完整规格与回收条件后，`submit_quote` 的 `evidence.source` 才能使用中文原名 `"踏浪"` 或 `"小鸽"`；不使用英文别名。群里转述的小程序报价仍使用 `"微信群"`，未亲自核实的条件保持 `unknown`。
- 只有 Bot 直接读到酷安原帖、亲自核实对应内容时才使用 `source: "酷安"`；群里转述的酷安内容仍使用 `"微信群"`，不能凭引用链接宣称已直接核实。
- `text` 必须包含与结构化 `sku` 相同的完整 SKU，保留品牌前缀、型号、RAM/容量、颜色、地区、激活与成色等实际已知字段。比较会规范化大小写/空白，但不会补出缺失信息；例如 `sku` 带 `Apple` 而 `text` 只写 `iPhone`，仍可能触发「购买文本未包含完整结构化 SKU」。金额文本与 `buyPrice` 也须相符，小数价格不能舍去小数。
- Huawei 当前增量识别仅包括明确的 `nova 15`、`nova 15 Pro`。**以下是完整 SKU 格式示例，不是用户当前真实线索的已核实规格**：`华为 nova 15 Pro 12+256 国行 黑色 全新未激活`。未知型号、缺少 RAM/容量、单一颜色、地区、激活或成色仍保持 `pending_confirmation`。不要给实际仅知道 `华为 nova 15 Pro 12+256` 的线索编造黑色/国行/未激活等字段；未确认国补资格、地区资格或库存时分别填 `eligibility: unknown`、`stock: unknown`，其余待确认条件同理。
- `observedAt` 是源内容被实际观察、价格/条件被实际核验的时间，使用带时区 ISO 时间，不是请求发送时间，也不能把旧内容重新盖成当前时间。已知记录 `09:40Z` 等于北京时间 `17:40`，服务器默认购买有效期到 `10:40Z` / `18:40`；即使源 `validUntil` 填到次日，60 分钟 TTL 截短仍正确。此例用于说明时间规则，不表示该记录发生过金额解析错误。
- 默认购买 TTL 为 60 分钟、回收 TTL 为 30 分钟（管理员配置可变）。每份证据的有效期为 `min(源 validUntil, observedAt + 对应 TTL)`；完整机会再取购买与可用回收证据的较早截止。优惠活动截止时间可约束源 `validUntil`，不能代替一次新鲜核验，也不能延长服务端 TTL。
- 实际补做价格、资格、库存或回收条件核验后，保留同一个 `opportunityKey`、完整 SKU、直接来源和稳定 `reference`，使用**新的 `idempotencyKey`**并填真实新的 `observedAt`。重放同一幂等键只能发送完全相同业务参数；重放旧请求不会刷新核验时间，改内容重用旧键会冲突。缺失条件不要为获得利润结论而捏造。
- 同一 `opportunityKey` 已绑定直接 `source`、`reference` 和规范化完整 SKU 的身份，不允许改变实际规格或证据归属。若先用不完整 SKU 建立待确认，随后实际核验补齐 SKU，须使用**新的 `opportunityKey` + 新的 `idempotencyKey`**建立完整规格机会，否则会返回 `Opportunity identity cannot change`。只有条件、价格或时间更新且身份保持不变，才沿用原 `opportunityKey`。下述明确等价别名可以兼容原记录，但不会改写其旧 identity；作废也不是删除或改变身份。

在**纯模拟、规格完整且购买与回收全部条件均已核实**的测试中，`2320 − 1964 − 20 − 0 − 30 = 306` 可达到门槛。用户当前真实线索的国补资格、库存及其他缺失条件未核实，不能据这个算式称为已核实机会，也不由本轮代提交。

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

Bot 可先用 `preview_check` 检查完整 SKU、条件和多家回收报价；真正提交时 `submit_lead` 建立机会，再用 `submit_quotes` 一次提交同一机会的多家报价，最后 `get_status` 确认。待办仍可通过 `get_pending_checks` 读取，原 `submit_quote` 单条调用保留。待办中本地导入的 `opportunityKey` 必须原样用于 `submit_lead`。同一机会补充证据时保持 `opportunityKey`、SKU、来源和 `reference` 稳定，另换 `idempotencyKey`；相同幂等键重试必须发送相同业务参数。

### 批量、预览与作废

`submit_quotes` 的形状为 `{ "checkId": "<现有id>", "quotes": [<报价项>, ...] }`。每个报价项必须有 `idempotencyKey/sku/price/evidence/conditions`，可选 `text`，不再带 `checkId`。逐项结果为 `{ index, success: true, submissionId, replayed }` 或 `{ index, success: false, error }`。每项独立复用 `submit_quote` 的幂等收据：单条与跨批重放一致，同键异参失败，不产生重复报价。外层格式、工具权限、checkId 跨空间或已作废错误整批拒绝；条目 Schema、来源、品类、时间、幂等或容量错误只回滚该项。未知存储/CAS 结果不返回虚假的已保存成功，也不自动重试外部通知。成功项及收据一起提交后，只根据全部报价的最终结果决定通知，避免先高价通知、后低价跌破门槛。

`preview_check` 是 `submit_lead` 参数加 `quotes` 数组，允许空数组。两个 key 仅用于与真实提交一致的临时计算，不产生任何持久化幂等收据。它不读取已有记录、不 prune/import/save、不构造 Blob、不 acquire/release、不通知；只在纯内存中复用真实计算引擎、当前凭证 workspace 的可信 policy、同样的证据/条件/授权校验。临时报价 ID 与正式保存的 ID 无关。`result.reasons` 给出缺失条件；`diagnostics.missingSpecs` 列出购买 SKU 缺项，`diagnostics.quotes` 逐项列出 `missingSpecs`、`differences`（如 model/storage/colors/activation/fullSku）及条件/时间/文本原因。条目验证失败还会在 `items` 和诊断中明确返回错误。

`void_check({ checkId, reason })` 自然幂等，不要求额外 key。首次原因、操作者与时间不可被后续请求覆盖。作废记录不进入默认 `get_status` 列表、计数、分页或 `get_pending_checks`；`get_status({ checkId })` 或 `includeVoided: true` 可审计本空间记录。保留期内禁止单条/批量/旧幂等重放或等价别名复活，利润为 null，不再发起通知；原收据与通知摘要保留。发送前会重新检查状态，但不能撤回已经开始的外部发送，也不能把 `sent` 或 `delivery_unknown` 宣称为已取消。作废审计沿用近期核验的7天保留条件（同时受线索观测时间限制），不是永久 tombstone；本轮不删除或作废用户已有记录。

## 匹配、利润与提醒

前后端复用 `lib/deal-engine.js`；单行/OCR 文本复用现有解析器。SKU 模糊识别仅用于候选，自动提醒额外要求规范化完整 SKU 一致，避免把近似颜色、容量、激活、套装当成同款。文字别名或不支持的型号可能保守地留待确认。手机必须含容量、单一颜色、地区、激活、成色；安卓手机另要求 RAM，iPhone 无需补造 RAM。平板要求容量/地区；主机要求地区；所有产品要求可识别的型号与成色。未能识别的型号不会自动放行。

明确颜色别名仅包括 `星宇橙 ↔ cosmic orange`、`深蓝/深蓝色 ↔ deep blue`、`银色/银 ↔ silver`、`勃艮第酒红 ↔ burgundy`、`冰川蓝 ↔ glacier blue`。星宇橙不等于泛橙，深蓝不等于冰川蓝或泛蓝，勃艮第酒红不等于泛红。`Pro Max/ProMax` 等价；`PM` 只在已支持的 iPhone 型号及明确规格边界内等价，不能替换任意英文 PM。`未激活/预激活/已激活` 是三个不同状态；未知或互相矛盾的状态仍待确认。别名不补成色、地区、容量或其他缺项。

旧身份规范化函数与已存 identity 不改写。服务端在本 workspace 有界扫描近期记录，以原 source/reference/完整 SKU 和明确别名作兼容比较；近期记录清理后，对30天旧通知摘要仍使用有限旧别名 hash 候选保护去重，新通知同时保留规范身份摘要。不能用别名换 key 绕过旧通知，也不会批量迁移生产状态。

等价提交若曾使用不同 `opportunityKey`，物理 checkId 仍可保持原值；服务端同样绑定当前及保留在 `leadHistory` 的活动 key。换一个新的 `idempotencyKey` 不能让这些 key 改用其他 source/reference/完整 SKU。历史 key 的保护沿用近期记录与最多10个旧版本的保留边界，不增加永久审计或批量重写。

有效报价按同一来源/规格取最近核验，再从有效且已核实的匹配报价取最低价。其他来源旧 AH 行情不会自动当作 Bot 已核实的回收保证。结构化 `price` 是净回收额，购买实付含购买端费用；配置中的运费是额外寄出成本，避免重复扣费。

在 `HYM_MCP_CONFIG_JSON`（本地为 `config/remote-mcp.local.json`）各 workspace 的 `policy` 中配置 `minimumProfit`、`shippingCost`、`platformCost`、`riskBuffer` 及购买/报价有效分钟数，重新部署/重启后生效。默认 80 / 20 / 0 / 30 元，购买 60 分钟、报价 30 分钟。条件缺失、失败、价格文本冲突、旧报价均返回 `pending_confirmation`，此时 `netProfit` 为 null，来源价格仍可作为证据查看；完整但未过门槛为 `below_threshold`。同一 SKU 同时含冲突容量、地区或成色时保持待确认，不能靠购买和回收两边复制同一段矛盾文字通过核验；重复同一规格不算冲突。

提醒使用 Telegram 固定 API（`api.telegram.org`，禁重定向、10 秒超时、限制响应体）。配置 `HYM_TELEGRAM_BOT_TOKEN` 及 workspace 的 `telegramChatEnv` 所指定的目标 ID。未配置时保存 `not_configured`，网页仍可看；配置并重新部署后，后续提交或幂等回放只会提醒该条**当时仍有效**的机会。只读查询不触发提醒。Vercel 不依赖常驻进程或后台定时器。测试注入模拟通知器，不发送真实消息。

通知先原子落盘占位，再进行一次发送。确认成功为 `sent`；断网/超时/崩溃留下 `delivery_unknown`，**不自动重发**，避免第三方已收到但响应丢失时重复提醒。此设计保证最多尝试一次，不能保证第三方恰好送达一次；需要人工检查不确定记录。相同 workspace + 来源 + reference + 完整 SKU 在 30 天内最多提醒一次，即使更换幂等键或 opportunityKey。新的真实活动应使用新的来源活动编号。

## 存储、权限与网页

- 私有 Blob 保存最近 7 天的核验、来源、证据、报价、最多 10 次线索旧版本、幂等收据及通知状态；去重通知摘要保存 30 天。本地开发保存到 `data/private/remote-checks.json`。
- 最多 200 个近期机会、每机会 20 条报价、5000 条幂等收据、10000 条通知摘要。达到上限拒绝新写入，不提前清空幂等或通知保护。云端在请求中清理过期数据；过期读取实时计算。
- 云端使用 Blob ETag 条件写入，首次创建禁止覆盖，读取不使用缓存；跨实例冲突有界重试，提交结果不确定时不发送通知。文件损坏或存储失败时拒绝处理，不能静默清空重建。本地使用进程锁和原子文件替换；仅本地崩溃遗留锁需要人工确认旧进程已停止后清理。
- `get_status/get_pending_checks` 在业务状态未变化且无保留期清理时跳过业务 CAS 写回，正常请求只保留 admission/release 两次写入；需要清理时仍条件写入，未知写入结果仍不重试。网页成功同步仍每30秒读取；失败按30/60/120/240/300秒退避，429/503 的 Retry-After 可延长等待（最多1小时）。隐藏页不轮询，切回前台和手动刷新不能绕过当前退避；成功同步后恢复正常间隔。
- 跨实例限速与并发占位也写入私有 Blob，因此一次持久化 MCP 请求会使用数次 Blob 操作。纯预览例外：32KiB 请求、最多10报价、响应大小上限保持，使用每个 warm serverless handler 实例的进程内限速（每凭证120/分钟、总600/分钟）；同步有界计算不排无界队列。它不是跨实例总限额，冷启动/多个实例各自计数；不为预览新增数据库、队列或云端写入。本地服务沿用120/600限速和20请求有界串行队列。Hobby 配额需在 Storage/Usage 监控；网页仅连接且可见时轮询，不自动升级套餐。
- token 固定映射 workspace 与工具权限；不信任请求传入身份。`get_status`、单条/批量报价、作废都按 workspace 校验 checkId；预览只能用本凭证 workspace 策略。来源与商品品类由配置白名单限制。
- 仅本地开启 `localImportWorkspace` 时，现有 `data/state.json` 中最近 7 天且品类获准的线索成为该空间待办；云端由 Bot 提交线索，不访问本机文件。
- 本地网页也必须使用只读 Bearer 凭证连接 MCP，没有新增匿名核验读取接口。静态文件服务改为页面资源及图片证据白名单，私有文件、配置、`.env` 和 Git 目录不可下载。
- 云端网页启用 [GitHub 登录](GITHUB_LOGIN.md) 后，仅 koocuu 数字 ID 可登录，安全 Cookie 自动恢复看板；同源 `/api/dashboard` 通过 CSRF 校验后内部复用只读 principal，不向浏览器发送 MCP Token。七工具的 `/api/mcp` 仍独立使用 Bearer，Cookie 不能调用写工具。
- 过渡期「设置 → 高级：手动只读连接」保留本站 `/api/mcp` 和 **HYM_DASHBOARD_TOKEN**；凭证仅存页内内存，断开/刷新即清除。Ray 确认手机 GitHub 登录后可关闭 `HYM_LEGACY_DASHBOARD_ENABLED`，不影响 Grok。无需把写入凭证交给网页。
- 将网页的精确 HTTPS Origin 加入 `allowedOrigins`。`/api/mcp` 的 CORS 不支持任意来源，该接口不使用 Cookie、始终要求 Bearer。Production 只允许自定义域名与其 Origin；新增网页登录接口独立要求会话和同源 CSRF。
- 网页连接且可见时每 30 秒刷新机会记录，展示净利润、待确认原因和证据时间；待确认或过期时隐藏有效净利润。网页连接成功不代表真实 Bot 已接入。手动分析、原始报价库、OCR 和本机采集入口已从首页移除，底层模块与原数据保留；核验记录不进入公开 Blob。当前不启用 Telegram，网页不提供通知配置入口。

## 本地验证

```powershell
npm test
npm run test:remote
node tests/remote-mcp-e2e.js --preview
```

`--preview` 仅启动随机 loopback 端口和临时模拟核验数据，输出网页地址；按 Enter 继续剩余测试并清理。测试不启动采集、不修改实际 state.json、不发消息、不部署。

2026-10-12 已执行的结果见 [REMOTE_MCP_VALIDATION.md](REMOTE_MCP_VALIDATION.md)。用户已报告实际 Bot 调用；本次更新后的新线索正式提交与条件核验仍需重新验收。本地模拟回归不替代真实来源核验，也不产生新的生产记录或通知。
