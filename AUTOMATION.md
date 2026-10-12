# 自动化路线

> 网页主流程已改为 Grok Bot 提交核验、服务端计算利润、机会列表查看结果。下方本机采集、OCR、导入和旧控制台操作是兼容能力说明，不是新网页操作步骤；旧面板入口已移除，相关模块与数据保留。当前不启用 Telegram，用户在网页查看结果。

## Grok Bot 核价闭环

远程 Bot 通过独立 MCP 提交购买线索与回收核验，后台匹配 SKU、校验条件/时效、计算净利润，现有网页展示近期记录，满足门槛时最多尝试一次提醒。详见 [REMOTE_MCP.md](docs/REMOTE_MCP.md)。这条新链路不等待小程序自动采集验证，也不改变现有 AH 日采集路线。

部署入口为现有 Vercel 的 `https://haoyangmao.koocuu.com/api/mcp`，推送 GitHub 主分支自动部署。Grok 核验使用私有 Blob，不依赖本机常驻服务；下方的本机采集路线继续为 AH 快照服务。

> 当前状态：正式自动报价源只保留 AH。小鸽/踏浪截图 OCR 和窗口采集内容为实验性保留，不在主界面展示，也不参与当前利润判断。

这个项目的主线不是手动投喂，而是自动盯盘和自动报价。

## 当前自动化服务

启动：

```text
node automation-server.js
```

打开：

```text
http://127.0.0.1:8765
```

服务提供：

- 自动扫描公开优惠源，当前配置在 `config/automation.json`
- 导入手机端/微信群转存线索：`data/inbox/leads.txt`
- 导入小鸽/踏浪/贩子报价文本：`data/inbox/quotes/*.txt`
- 持久化服务端状态：`data/state.json`
- 前端“自动化盯盘”面板一键同步到雷达

## 手机端真实工作流

PDD、淘宝、酷安主要在安卓端刷，网页和浏览器插件不是主入口。

推荐流程：

```text
安卓 App 看到羊毛/报价
  -> 截图或复制文本
  -> OCR/微信文件传输/LocalSend 转成文本
  -> 写入 data/inbox/leads.txt 或 data/inbox/quotes/*.txt
  -> 自动化服务导入
  -> 雷达自动判断
```

## 报价箱格式

格式不强制，系统会尽量解析来源、SKU、价格：

```text
小鸽 iPhone 16 256G 国行 全新未激活 5730
踏浪 Switch OLED 日版 白色 全新 1660
贩子A PS5 Slim 国行 光驱版 全新 3050
```

也支持小鸽/踏浪截图 OCR 后的表格文本，例如：

```text
踏浪数码
iPhone17ProMax 256G
深蓝色 8910
橙色 8900
银色 8960
iPhone17ProMax 512G
深蓝色 10920
```

```text
小鸽手机回收
iPhone17 256G(5999)
黑色 5670 0
白色 5690 0
青雾蓝色 5630 0
```

## 线索箱格式

每行一条：

```text
PDD 百亿补贴 iPhone 16 256G 国行 黑色 券后 5599
淘宝 iPhone 16 256G 平台券+淘金币后实付 5599
酷安 薅羊毛小分队 Switch OLED 日版 到手 1500
```

## 接下来最重要的连接器

1. 小鸽/踏浪自动报价
   - API 优先。
   - 找不到稳定 API 时，用安卓模拟器/投屏窗口/微信 PC 小程序自动搜索 + 截图 OCR。
   - OCR 结果进入 `data/inbox/quotes/`。

2. 闲鱼参考价
   - Playwright 搜索。
   - 聚合挂价区间，不做保底价。

3. 酷安/值得买线索
   - 值得买优先 Web 抓取。
   - 酷安优先手机端分享/截图/OCR，后续再看接口可行性。

4. 推送
   - 只推满足利润阈值的机会。
   - 企业微信 / Telegram / Bark 三选一。

## 浏览器插件定位

插件保留，但不是核心入口。

它只适合：

- 什么值得买 Web
- 电脑浏览器偶然看到的优惠
- 调试 URL 投喂协议

PDD、淘宝、酷安的主路径应该走手机端截图/OCR/分享，而不是浏览器插件。

## API 和 MCP 判断

小鸽/踏浪如果存在官方或稳定授权 API，应该优先接 API。

如果只有小程序内部接口，不建议把它作为唯一方案，因为它通常依赖登录态、签名、风控和接口版本。项目里已经增加 MCP 保底方案：

```text
mcp/haoyangmao-mcp.js
```

它可以截取当前前台窗口、可选 OCR、导入报价文本。后续可以接安卓模拟器、scrcpy 或微信 PC 小程序窗口。

### OCR 选择

截图工具和 OCR 是两件事：

- QQ/微信截图：适合手动框选和自带 OCR，复制文字后调用 `import_quote_text`。
- MCP 截图：适合后台把当前前台窗口保存成图片。
- OpenAI Vision：配置 `OPENAI_API_KEY` 后可直接识别截图。
- 本地开源 OCR：后续可接 PaddleOCR / Tesseract，作为离线方案。

当前最稳的最小闭环：

```text
微信 PC 打开小鸽/踏浪小程序
  -> QQ/微信截图 OCR 复制文字
  -> 粘贴到控制台「报价 OCR 工作台」
  -> 点击「解析并入库」
```

自动操作和 API 抓取采样说明见：

```text
docs/automation-sampling-guide.md
```

## Vercel 云端同步

本机仍负责 KDocs 截图和 Windows OCR。配置以下环境变量后，每次 AH 完整采集成功会自动上传清洗后的报价快照：

```text
HYM_CLOUD_URL=https://你的域名.vercel.app
HYM_SYNC_TOKEN=与 Vercel 相同的随机密钥
```

手动验证：

```text
node scripts/cloud-sync.js
```

完整部署步骤见 `docs/VERCEL.md`。

也可以走文件箱：

```text
OCR 文字放进 data/inbox/quotes/*.txt
  -> 控制台点击「导入报价/线索箱」
```

或走半自动截图：

```text
微信 PC 打开小鸽/踏浪小程序并置前
  -> 控制台点击「截前台窗口」
  -> 有 OPENAI_API_KEY 时点击「OpenAI OCR」
  -> 检查文本后点击「解析并入库」
```
