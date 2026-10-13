# AH 快照兼容部署（Vercel）

本页说明原 AH 公开快照接口与本机采集器，供保留脚本使用。当前首页只读展示 Grok 提交的私有 MCP 核验记录；新增环境配置及验收请看 [远程 MCP 文档](REMOTE_MCP.md)。不要将下方 Public Blob 与 MCP 的独立 Private Blob 混用。

## 架构

```text
Windows 本机
  Chrome + KDocs + Windows OCR
  每日生成完整 AH 报价快照
            |
            | Bearer HYM_SYNC_TOKEN
            v
Vercel /api/automation/snapshot
            |
            v
Vercel Blob: haoyangmao/latest-state.json
            |
            v
公开 AH 兼容 API（已有脚本读取）
```

Vercel 不负责打开 KDocs、截图或 OCR。当前首页已移除本机采集及手动分析入口，AH 快照不会自动成为已核实的商品机会。

## 1. 部署项目

在 Vercel 中导入 GitHub 仓库 `koocuu/haoyangmao`，保持默认项目根目录，不需要填写构建命令。

## 2. 创建 Blob

1. 在 Vercel 项目的 Storage 页面创建 Blob Store。
2. 选择 Public Blob，并连接到当前项目的 Production 环境。
3. Vercel 会自动注入 `BLOB_READ_WRITE_TOKEN`，不需要手工复制该值。

## 3. 配置上传密钥

生成一个至少 32 位的随机字符串，在 Vercel Production 环境变量中添加：

```text
HYM_SYNC_TOKEN=你的随机密钥
```

修改环境变量后重新部署一次。

## 4. 配置 Windows 采集器

将部署域名和同一个密钥写入 Windows 用户环境变量：

```powershell
[Environment]::SetEnvironmentVariable("HYM_CLOUD_URL", "https://你的域名.vercel.app", "User")
[Environment]::SetEnvironmentVariable("HYM_SYNC_TOKEN", "与 Vercel 相同的随机密钥", "User")
```

关闭并重新打开 PowerShell，然后执行第一次同步：

```powershell
cd C:\Users\zhangtong03\Documents\Codex\2026-07-03\1-2-3-4-5-mvp\work\haoyangmao
node scripts\cloud-sync.js
```

成功输出示例：

```json
{"ok":true,"configured":true,"quotes":145}
```

以后每日 AH 采集成功后会自动上传，不需要单独运行同步命令。

## 5. 验收

访问以下地址：

```text
https://haoyangmao.koocuu.com/api/automation/status
https://haoyangmao.koocuu.com/api/automation/state
```

状态接口应显示：

```json
{
  "mode": "cloud",
  "scheduler": {
    "lastImported": 145
  }
}
```

以两个兼容 API 的响应验收 AH 快照。当前首页不展示旧 `AH 云端快照` 面板，也不提供“打开授权浏览器”或“采集一次”；首页验收须通过私有 MCP 的只读连接，不能用公开 AH 行情代替真实核验。

## 安全边界

- 此公开快照链路只保存清洗后的 AH 报价；Grok 核验记录只进入独立 Private Blob。
- 本机线索、最近分析、截图、WPS 登录态和 Chrome Profile 不会上传。
- 上传接口只接受正确的 `HYM_SYNC_TOKEN`。
- Blob 中不保存同步密钥。
