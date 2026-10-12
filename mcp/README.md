# 好羊毛自动化 MCP

此文件描述本地 stdio 工具。Grok Bot 应接入独立的 [远程核价 MCP](../docs/REMOTE_MCP.md)，不要把本地 stdio 工具桥接到公网。

这个 MCP 是给“报价自动化”准备的本地工具层。

它不负责下单、不发送微信消息、不绕过平台风控，只做：

- 截取你当前打开到前台的授权窗口
- 可选 OCR 截图
- 导入 OCR/复制得到的报价文本
- 导入羊毛线索文本
- 读取自动化状态

## 和 QQ/微信截图的关系

QQ/微信截图能很好地完成“截屏”和手动 OCR。

这个 MCP 做的是程序化通道：在你把微信 PC 小程序、安卓模拟器或群聊窗口打开到前台后，帮你保存截图、可选调用 OCR、把报价文本导入报价库。

最务实的第一版流程：

```text
QQ/微信截图 OCR
  -> 复制识别文字
  -> MCP import_quote_text
  -> data/state.json
```

或者：

```text
MCP capture_active_window
  -> MCP ocr_image_openai
  -> MCP import_quote_text
```

## 为什么需要它

小鸽/踏浪如果有稳定 API，优先接 API。

但小程序报价大概率会遇到登录态、签名、风控、接口变动。MCP 的意义是保底：

```text
打开小鸽/踏浪/微信群窗口
  -> MCP 截图
  -> OCR 提取报价
  -> import_quote_text 入库
  -> 雷达自动算利润
```

## 工具

- `capture_active_window`：截取当前前台窗口
- `capture_screen`：截取全屏
- `ocr_image_openai`：可选 OpenAI Vision OCR，需要 `OPENAI_API_KEY`
- `import_quote_text`：解析报价文本并写入 `data/state.json`
- `import_lead_text`：解析羊毛线索文本并写入 `data/state.json`
- `read_state`：读取当前状态

## 配置示例

MCP 客户端命令：

```text
node D:\AS\Projects\haoyangmao\mcp\haoyangmao-mcp.js
```

可选环境变量：

```text
OPENAI_API_KEY=你的 key
OPENAI_VISION_MODEL=gpt-4.1-mini
```

## 使用边界

使用前请把要识别的小程序、安卓模拟器、微信聊天窗口打开到前台。

这个工具不会自动读取隐藏窗口，也不会自动翻聊天记录；如果要监控微信群，建议把群消息同步/转存到 `data/inbox/leads.txt` 或截图后 OCR。
