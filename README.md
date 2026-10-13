# 好羊毛

个人商品机会看板：Grok Bot 查优惠和回收报价，服务端核对条件、匹配 SKU 并计算净利润，网页展示近期核验结果。

- 网页：https://haoyangmao.koocuu.com
- 远程 MCP：`https://haoyangmao.koocuu.com/api/mcp`
- [Bot 接入、鉴权及工具 Schema](docs/REMOTE_MCP.md)
- [接口验证记录](docs/REMOTE_MCP_VALIDATION.md)

## 当前流程

```text
Grok Bot 发现优惠并核实购买条件、回收规格与报价
  → preview_check 预览条件与规格问题（不保存、不提醒）
  → submit_lead + submit_quote / submit_quotes 保存核验
  → 服务端校验 SKU、条件、证据时效并计算净利润
  → 网页机会列表、筛选和只读详情
```

`get_pending_checks` 供 Bot 读取待核价商品，`get_status` 供 Bot 和只读网页查询结果。接口上线不代表真实 Grok 客户端已经接入；客户端必须支持带 Bearer 凭证的 MCP Streamable HTTP。

`submit_quotes` 支持同一机会的多家报价逐条提交结果；`void_check` 作废本空间记录并保留近期审计。作废记录不进入默认机会列表，通过 `get_status(checkId)` 仍可查看。详细参数和边界见 [Bot 接入说明](docs/REMOTE_MCP.md)。

网页的「设置」收纳 MCP 地址与只读凭证（`HYM_DASHBOARD_TOKEN`）。凭证只留在当前页面内存中，连接后输入框立即清空，刷新页面需重新填写；断开会清除当前结果和凭证。网页连接状态仅代表看板与接口的连接，不代表 Bot 在线。

主界面只展示机会与证据，不再提供手动分析、OCR、报价导入、原始报价库或本机采集操作。支持商品搜索、品类和核验状态筛选，以及价格/利润比较；窄屏点开商品查看详情。条件不足或过期的记录不显示有效净利润，条件完整但未达到门槛的记录单独标识。没有真实记录时显示空态，不填充概念图中的示例商品。

当前不启用 Telegram，也没有支付或自动下单功能。

## 部署与存储

沿用 HTML/CSS/JavaScript、Node 和 Vercel；推送 GitHub 的 `main` 自动部署。远程核验保存于独立私有 Blob，保留近期记录、证据、时效和幂等信息；原有公开 AH 快照保持独立，不自动变成已核实机会。部署配置见 [远程 MCP 文档](docs/REMOTE_MCP.md) 和 [原 AH 快照部署说明](docs/VERCEL.md)。

不要把 Token 写进源码、URL、聊天或浏览器持久化存储；不要把本地 MCP 或整个本机服务开放到公网。

## 本地开发与验证

需要 Node 22 或更新版本。按 [远程 MCP 文档](docs/REMOTE_MCP.md) 配置本地凭证后，分别启动：

```text
npm start
npm run mcp:remote
```

网页为 `http://127.0.0.1:8765`，本地 MCP 为 `http://127.0.0.1:8766/mcp`。在设置中连接本地 MCP 与只读凭证。

```text
npm test
```

测试覆盖解析与利润引擎、已有采集/云端接口、远程 MCP 的鉴权、幂等、并发、过期和前端状态。模拟测试不会发送真实提醒。

## 保留的兼容能力

原本机采集、报价解析、OCR、插件和线索箱仍保留供已有脚本使用，不再是网页主流程；本地自动化数据仍在 `data/state.json`，不会因网页精简被删除。历史浏览器手动分析数据不再由新页面读取或更新。旧网页 URL 投喂和手动操作教程不适用于新机会列表。

- [本机自动化说明](AUTOMATION.md)
- [本地自动化 MCP](mcp/README.md)
- [OCR 解析器](lib/quote-ocr-parser.js)
- [自动操作采样说明](docs/automation-sampling-guide.md)
