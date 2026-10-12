# 好羊毛

数码羊毛套利雷达 MVP。

Grok Bot 远程核价接口：`https://haoyangmao.koocuu.com/api/mcp`，运行在现有 Vercel，复用私有 Blob 保存近期核验。[接入步骤、配置和工具 Schema](docs/REMOTE_MCP.md)。本地开发仍可运行 `npm run mcp:remote`；远程只提供四个核价工具。

当前版本包含三部分：

1. 自动化服务：每日完整采集 AH 行情、扫描优惠源并导入线索箱。
2. 雷达控制台：同步自动化数据，计算利润，输出可冲/可关注/待确认/别碰。
3. Vercel 云端模式：本机每日上传 AH 报价快照，网页从 Vercel Blob 读取数据。

## 快速开始

推荐启动方式：

```text
node automation-server.js
```

然后访问：

```text
http://127.0.0.1:8765
```

也可以只打开静态页面，但那样没有自动化服务：

```text
index.html
```

示例输入：

```text
PDD 百亿补贴 iPhone 16 256G 国行 黑色 券后 5599
```

## 当前边界

当前版本已经把自动化骨架打通：

```text
自动扫描/导入 -> 服务端状态 -> 同步到雷达 -> SKU 识别 -> 报价匹配 -> 利润计算 -> 结论
```

闲鱼、什么值得买、酷安等后续自动化采集会继续接入 `connectors/` 和 `automation-server.js`。小鸽/踏浪因无法稳定无人值守采集，已退出正式渠道。

## 自动化入口

配置文件：

```text
config/automation.json
```

手机端/群消息线索箱：

```text
data/inbox/leads.txt
```

小鸽/踏浪/贩子报价箱：

```text
data/inbox/quotes/*.txt
```

详细说明见：

```text
AUTOMATION.md
```

## 浏览器插件

插件目录：

```text
extension/
```

安装方式：

1. 打开 Chrome/Edge 扩展管理页面。
2. 开启开发者模式。
3. 选择“加载已解压的扩展程序”。
4. 选择 `D:\AS\Projects\haoyangmao\extension`。

插件保留为辅助入口。PDD、淘宝、酷安主要在安卓 App 内使用，主路径应走手机截图/OCR/分享和自动化服务，不再把浏览器插件当核心入口。

## URL 投喂

也可以直接用 URL 参数投喂：

```text
index.html?source=pdd&auto=1&lead=PDD%20iPhone%2016%20256G%20券后%205599
```

## 数据存储

本地自动化数据保存在 `data/state.json`，最近分析保存在浏览器 `localStorage`。

Vercel 部署使用 Blob 保存最新 AH 报价快照；不会上传本机线索、截图、登录态或分析历史。部署说明见：

```text
docs/VERCEL.md
```

## 推荐下一步

1. 完成 Vercel 首次部署和本机快照同步。
2. 手机截图 OCR 到报价箱/线索箱。
3. 闲鱼参考价抓取。
4. SMZDM / 酷安线索抓取和推送。

## 自动化 MCP

报价 API 不稳定时，使用本地 MCP 做截图/OCR 自动化保底：

```text
node mcp/haoyangmao-mcp.js
```

说明见：

```text
mcp/README.md
```

## 小鸽/踏浪 OCR 解析

项目已支持小鸽/踏浪截图 OCR 后的表格文本解析：

- [lib/quote-ocr-parser.js](lib/quote-ocr-parser.js)
- [data/inbox/quotes/talang-ocr-sample.txt](data/inbox/quotes/talang-ocr-sample.txt)
- [data/inbox/quotes/xiaoge-ocr-sample.txt](data/inbox/quotes/xiaoge-ocr-sample.txt)

把 OCR 文本放进 `data/inbox/quotes/*.txt`，再在控制台点击“导入报价/线索箱”即可。

DeepSeek 暂不作为 OCR 主线：它适合文本推理，但不负责识别小鸽/踏浪截图。报价识别优先走 Windows 免费 OCR、QQ/微信 OCR 文本粘贴，或配置真正支持图片的 Vision API。

## 自动操作采样

录屏、窗口定位、API 抓包需要提供什么，见：

```text
docs/automation-sampling-guide.md
```
