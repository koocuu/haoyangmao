# 远程 MCP 验证记录

验证日期：2026-10-12；Windows，Node v22.16.0。

用户流程：模拟 Grok 通过 HTTP MCP 提交购买与回收证据 → 后台持久化和条件/利润计算 → 只读 MCP 查询 → 现有网页展示 → 注入的通知器去重发送。

## 已验证

`npm test` 共 9 组通过：原有 smoke、automation、quote OCR、quote cleaner、cloud snapshot、cloud API、本地 MCP，以及 remote MCP E2E、cloud MCP E2E。

云端 E2E 使用三个独立 Node 进程和模拟 Blob HTTP 服务，验证首次创建互斥、ETag CAS 冲突重试、跨进程幂等、利润 151 元、过期及保留策略、跨实例限速/并发占位。通知占位的写入响应丢失后不发送；通知响应丢失后不重发。只读查询不触发提醒。

使用真实 `@vercel/blob` 2.6.1 SDK 的 MockAgent 传输测试，验证 `useCache:false`、首次写入禁止覆盖、`ifMatch` 请求头和确定冲突分类；不确定的 503 写入只有一次尝试。部署依赖闭包测试确认 `/api/mcp` 不加载 Windows、本地自动化服务或 stdio MCP。

`npm audit --omit=dev --ignore-scripts`：0 项漏洞。现有传递依赖 undici 从 6.27.0 更新至 6.29.0，安装禁用脚本；Blob SDK 保持 2.6.1。对应修复见 [上游安全公告](https://github.com/nodejs/undici/security/advisories/GHSA-rfgv-xxqx-mfg5)。

新增端到端测试使用随机 loopback 端口、临时文件和随机测试凭证，不修改真实 `data/state.json`；通知只注入模拟器。覆盖：

| 边界 | 验证结果 |
|---|---|
| MCP 初始化、tools/list、tools/call、通知 | 四个指定工具；initialized 返回 202；只读凭证仅看到 get_status |
| 鉴权与网络 | 错误凭证 401；非法 Origin/Host 403；合法 CORS 预检 204；不支持协议 400；超大请求 413 |
| 工具边界 | 本地 capture_screen 等工具拒绝；本地 API 不在远程监听器路由中 |
| 授权 | 另一空间看不到、不能写入该 checkId；只读凭证不能提交；伪造 tenantId 被 Schema 拒绝 |
| 幂等/并发 | 8 个同时重复提交只有一个新提交；同键不同参数冲突；换键重复机会不重发 |
| 业务条件 | 缺失资格、未知扣款、错容量、不完整 SKU、结构化价格与文本冲突、过期报价均待确认 |
| 利润门槛 | 5800 − 5599 − 20 − 0 − 30 = 151；满足 80 门槛；低于门槛不提醒；金额按分计算 |
| 时效和更新 | 时间推进 31 分钟后不再 eligible；新失败核验覆盖同来源旧成功核验 |
| 通知 | 模拟成功发送一次；重启后不重发；模拟超时状态 delivery_unknown，定时维护不重试 |
| 持久化/资源 | 第二个写入实例被锁拒绝；时间推进后清理记录/收据/通知摘要；存储不含凭证 |
| 网页与文件 | HTML 包含核验面板；私有文件、配置、Git 路径不可下载；只读 MCP 返回利润和状态 |
| 通知适配器 | 模拟 HTTP 响应验证 Telegram 固定主机、目标、禁重定向；没有发送真实 Telegram |

## 浏览器核对

使用 Cockpit browser 打开测试页面，通过独立只读测试凭证连接真实本地 MCP 监听器，完成 initialize、initialized 和 get_status。DOM 检查实际返回：

```json
{"cards":7,"eligible":true,"credentialFieldEmpty":true,"storedKeys":[],"overflow":false}
```

已目视检查页面截图，中文显示正常，现有 AH 页面保留，核验面板显示待确认、未达门槛及净利润 ¥151 的记录。点击「断开并清除凭证」后检查：

```json
{"cards":0,"credentialFieldEmpty":true,"storedKeys":[]}
```

没有凭证写入 localStorage。浏览器预览和测试进程已停止，临时测试数据已清理。

## 本轮修复与剩余边界

从旧前端抽取共用的 SKU/利润模块时，测试发现原逻辑去掉型号和容量间空格后，`iPhone 16 256G` 会丢失容量。已修复并加入回归断言。

真实 Grok 客户端兼容性和实际 Telegram 送达尚未验证；当前生产尚未配置 Telegram 通道。通知采用“最多一次尝试”，网络结果不确定时不自动重发，不能保证恰好一次送达。别名、无法识别的 SKU 或证据不足会保守留待确认。

安全自查：新增接口及网页读取均要求 Bearer；工具/空间/来源/品类范围、幂等、CAS 并发写入、输入上限、证据时效、纯文本输出和私有存储隔离已检查。提交引用不触发抓取；外部请求仅到受信 Blob/固定 Telegram API。凭证不进入 Git、部署静态文件、应用日志或浏览器持久存储。
