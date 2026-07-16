# 自动操作采样指南

目标是把「微信 PC 小程序窗口 -> 自动截图/OCR -> 报价入库」做稳。

## 你提供录屏可以，最好这样录

录 20-40 秒即可，内容包含：

1. 打开微信 PC 里的小鸽/踏浪小程序。
2. 进入报价页。
3. 搜索或切换一个型号，例如 `iPhone17` / `iPhone17ProMax`。
4. 切换容量或滑动价格表。
5. 停在完整报价页 2 秒。

录屏要求：

- 不需要露脸，不需要声音。
- 尽量固定窗口大小，不要频繁移动窗口。
- 遮掉手机号、微信号、聊天头像等隐私。
- 最好同时给一张最终页面截图，便于做模板定位。

## 做自动操作需要的信息

| 信息 | 用途 |
| --- | --- |
| 微信 PC 版本 | 判断窗口行为是否稳定 |
| 屏幕缩放比例 | 坐标点击是否偏移 |
| 小程序窗口大小 | 截图/OCR 区域定位 |
| 目标品类列表 | 决定自动遍历哪些型号 |
| 录屏和截图 | 做点击路径和 OCR 区域模板 |

## 第一版自动操作策略

不直接从聊天记录乱翻，也不自动发送消息。

第一版只做你明确打开的小程序窗口：

```text
定位前台窗口
  -> 截图
  -> OCR
  -> 解析报价
  -> 入库
```

第二版再做半自动点击：

```text
点击搜索
  -> 输入型号
  -> 等待结果
  -> 截图/OCR
  -> 下一型号
```

第三版才考虑批量遍历型号、容量和页面滚动。

## API 抓取需要你提供什么

如果要判断小鸽/踏浪能不能接 API，最有用的是 HTTP 抓包结果。

推荐工具：

- Reqable
- Proxyman
- HTTP Toolkit
- mitmproxy

需要导出：

- HAR 文件，或
- 请求 cURL，或
- 请求 URL + headers + body + response 样例

重点接口：

```text
搜索型号
获取报价列表
切换容量/成色
```

注意：只分析你自己账号授权访问到的数据，不做绕过登录、绕过风控或批量刷接口。

## 现在项目里的工具

列出当前窗口：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\list-windows.ps1
```

截前台窗口：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\capture-active-window.ps1 -OutputPath data\screenshots\front.png
```

Windows 免费 OCR：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\ocr-windows.ps1 -ImagePath data\screenshots\front.png
```
