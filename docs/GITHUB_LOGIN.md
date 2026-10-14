# 好羊毛 GitHub 登录

原网页要求手填 `HYM_DASHBOARD_TOKEN`，且只放当前页面内存。新手机、刷新或重新打开显示「接口未连接」是旧设计，不证明数据库为空。新版将未读取的数量显示为「—」，GitHub 登录成功后自动连接只读看板。

## 方案与接口

不更换 HTML/CSS/Node/Vercel 技术栈，不加数据库、付费认证平台或新依赖。复用已有 Private Blob 的独立认证文件；与商品核验文件分离，不迁移业务状态。沿用已有配额，登录产生少量认证存储请求，不承诺平台用量永远为零；没有开通付费计划。

- `GET /api/auth/session`：返回登录功能状态、是否登录；兼容字段 `legacyEnabled` 固定为 `false`。验证过会话才返回 `user.login` 和 CSRF 值，不返回任何 OAuth/MCP Token。
- `GET /api/auth/login`、`GET /api/auth/callback`：GitHub 授权往返，成功固定回首页；失败仅带 `login=failed`，不回显 provider 错误。
- `POST /api/auth/logout`：同源及 `X-CSRF-Token`，服务端撤销会话后返回 204。
- `POST /api/dashboard`：Cookie、同源及 CSRF 检查，内部复用原只读 Dashboard principal，仅允许 MCP initialize、initialized 和 get_status，不获得七工具写权限。
- `/api/mcp` 仍是 Grok 的 Bearer 接口，地址、Token 与七工具协议不变。

只按 GitHub 认证 `/user` 的数字 `id=68145231` 授权，不按用户名、邮件或前端传入的 ID。这个数字已通过当前 GitHub profile 核实属于 koocuu。登录不请求 repo、邮箱或 offline_access 权限，不保存 GitHub access/refresh token。

回调使用固定 `https://haoyangmao.koocuu.com/api/auth/callback`，不从不可信 Host 或 forwarded header 构造。Vercel 自带域名转向正式域名，不为每个随机部署建立登录。Cookie host-only，不共享给其它 koocuu.com 子域。

认证入口采用 `api/auth/session.js`、`login.js`、`callback.js`、`logout.js` 四个固定文件，避免 Vercel 动态路由注入查询参数触发严格参数拒绝。别名跳转按“Host 不等于正式域名”判断，目标始终固定；不使用在本项目首次部署中未匹配的 Host 正则字符串。不为兼容部署而放宽回调参数、Host 或 Origin 校验。

OAuth state 10 分钟、PKCE S256；跨实例消费一次的 nonce 存在 Private Blob。拒绝重复参数及错误 state；可选 `iss` 若存在必须精确为 `https://github.com/login/oauth`。固定 GitHub token/user 端点，禁止重定向，有超时及响应体上限。会话为随机 opaque ID，服务端仅存摘要，8 小时到期；新登录轮换当前会话，登出撤销服务端会话。Blob 沿用 identity GET、同响应强 ETag 与 CAS，未知写入结果不自动重试。

## Production 配置

专用 OAuth App：`Haoyangmao private login`，注册页面 `https://github.com/settings/applications/3927759`。Homepage 为 `https://haoyangmao.koocuu.com`；唯一精确回调为上述 callback，不开启 wildcard 或 Device Flow。生成 secret 时可能要求 GitHub 本人 Confirm access，不能绕过或通过聊天收集验证码。

变量均仅在 Vercel `haoyangmao` 项目的 Production 服务端环境中配置，不带 `NEXT_PUBLIC_`，不复制其它项目凭据，不写 Git、本机秘密文件、页面或日志。使用 Vercel CLI 标准输入传值；不要放 `--value` 命令参数。

| 变量 | 用途 |
| --- | --- |
| `GITHUB_CLIENT_ID` | 专用 OAuth App Client ID，非 App ID |
| `GITHUB_CLIENT_SECRET` | 专用 Client Secret，Secret 类型 |
| `AUTH_SECRET` | 独立密码学随机密钥，Secret 类型 |
| `HYM_GITHUB_LOGIN_ENABLED` | `1` 开启；缺省关闭，配置不齐也关闭 |
| `HYM_LEGACY_DASHBOARD_ENABLED` | 已弃用；Production 设为 `0`，代码不再读取，无法开启公网旧口令回退 |

修改环境配置后需新部署。开发直接在 main，未准备好的登录保持关闭。Ray 已确认手机登录成功，网页及公网接口的手动只读口令回退已删除；保留服务端只读 principal 以沿用原 workspace，不迁移记录。无需新增 Neon、消息队列或付费服务。

## 验收与故障处理

2026-10-14 空列表诊断：真实 koocuu GitHub 会话正常，Cookie 看板、旧只读口令和 Grok 的默认查询均为 0；同空间审计查询返回 8 条，全部已有 `voided` 标记，最新一批由 Grok 于北京时间 10:10–10:12 作废。不是 GitHub 身份映射错误、报价过期隐藏或跨凭证分库。未恢复、迁移或改写这些历史记录。网页新增「已作废」只读审计及全作废空态，保持默认机会列表排除作废。审计仍受既有 7 天保留条件约束。

回归覆盖：Grok 提交记录后 Cookie 看板读取同一 ID；作废后默认 0、审计可读原原因/身份；异 workspace 记录不泄露；审计读取不改历史对象。公网旧 Dashboard Bearer 即使旧开关为 `1` 也在存储前返回 401，Grok 七工具保持可用。以下 2026-10-13 内容是过渡期验收历史，不代表当前仍保留回退。

2026-10-13 本地验收：负责人独立运行 `npm test`（十组）、`npm run test:remote`、`npm run test:auth` 和 `git diff --check` 均通过。隔离测试覆盖跨实例 nonce 单次消费、会话轮换/撤销、登出与兑换并发、未知写入结果、CSRF、只读看板、Grok 权限隔离和共同请求截止时间。320px 浏览器页面已用本地模拟会话检查布局与登录/退出展示；这不是实际 GitHub 登录验收。

2026-10-13 发布准备：专用 OAuth App 已创建，Ray 已完成 GitHub 本人 Confirm access；Production 的三项凭据已通过内存及 Vercel CLI 标准输入配置为 Secret，无本机秘密文件。登录开关及手动回退均设为 `1`，新部署生效。真实 GitHub 往返、云端会话撤销及手机登录须在发布后另行验收，不能以本地测试替代。

2026-10-13 Production 实测：路由修正提交 `d505c685717619828d3ef12838ac389c8524ebda` 达到 READY；koocuu 完成真实 GitHub 授权（仅 Public data），会话和只读看板返回 200，读取 4 条现有记录，网页自动显示 4 条；刷新保留会话。错误 CSRF 返回 403；点击退出返回 204，随后 session 显示未登录、dashboard 返回 401、页面清空；再次登录成功。运行日志抽查 22 条均为 info，未见 OAuth 查询值或秘密赋值；MCP 的 Drains 查询返回 404，随后通过 Vercel CLI 同一项目只读查询确认 0 个 Drain。没有新增模拟商品或发送通知。手机真实登录仍待 Ray 确认，因此保留手动回退。

首页别名跳转补丁 `6d4e9c4a97d207e2c82e3ed57e4c6bccf1f9f7f2` 达到 READY 后再次核验：正式域名 200，`haoyangmao-peach.vercel.app/` 返回 307 到正式域名；会话跨部署仍有效、页面显示 4 条。团队受保护的 Vercel 别名会先进入 Vercel SSO，不关闭平台保护；日常使用正式域名。七工具 Schema、纯内存预览及发布静态资源一致性检查通过。

1. `npm test`、`npm run test:remote`、`npm run test:auth`；本地隔离测试不能充当真实 GitHub 登录证明。
2. Production READY 且 SHA 与发布提交一致；匿名 dashboard 401，session 不泄露私有记录，伪造/重复回调不得签发会话。
3. koocuu 从未登录页面完成真实 GitHub 往返，自动读到列表；刷新保持登录，退出后 API 401，再次登录可用。没有记录时明确空态。
4. 手机确认登录成功。不具备第二账号时，账号拒绝只能标注为本地模拟覆盖，不能写成生产实测。
5. 保持七工具和 Grok 鉴权回归；本轮不提交或作废任何模拟商品，不发送通知。

登录故障时可将登录开关设为 `0` 后重新部署以暂停网页登录，排查配置及认证日志；这不会恢复手动口令入口，不轮换 Grok 或其它项目凭据。认证状态损坏时拒绝读取，不能清空认证/业务文件绕过。应用不记录 callback query、Cookie、code 或 OAuth 响应；如启用平台 log drain，须在采集端去掉这些字段，不分享真实回调地址栏截图。

依据：[personalSkills 第8节](https://github.com/koocuu/personalSkills/blob/main/deploy-github-vercel-neon/SKILL.md)、[Afterglow 运维记录](https://github.com/koocuu/Afterglow/blob/main/docs/architecture/github-auth-operations.md)、[World 登录记录](https://github.com/koocuu/World/blob/main/docs/github-login.md)、[GitHub OAuth 文档](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)。保留它们对数字 ID、固定 issuer、回调域名、Cookie 与配置范围的经验，并补上本项目服务端 nonce 消费和注销撤销。
