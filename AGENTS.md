# AGENTS.md — backend（共享后端源码）

Hono + Cloudflare Workers + TypeScript 后端。**一套源码，四个部署目标**——先看部署矩阵再动 `wrangler*.jsonc`。

## 部署矩阵

| 配置文件 | Worker | 用途 | 部署命令 |
|---|---|---|---|
| `wrangler.jsonc` | （无 name routes） | **仅 `wrangler dev` 本地开发**，assets 指 `../frontend/dist` | `npx wrangler dev` |
| `wrangler.x.jsonc` | `xingchen-forum-x` | **starlr.tech（主站）+ www.starlr.tech** + x.182030.xyz + forum.182030.xyz：frontend-x 静态资源 + 同源 API | `npx wrangler deploy -c wrangler.x.jsonc` |
| `wrangler.backend.jsonc` | `forum-backend` | i.182030.xyz：**纯 API**（无 assets；根/未定义路径空 404） | `npx wrangler deploy -c wrangler.backend.jsonc` |
| `wrangler.frontend.jsonc` | `forum-frontend` | f.182030.xyz：**纯前端**（assets 指 `../frontend-x/dist-f`，无代码） | `npx wrangler deploy -c wrangler.frontend.jsonc` |

⚠️ 红线：
- 永远不要裸 `npx wrangler deploy`（那是 `package.json` 里 `deploy` 脚本的老路径，无 routes，但也不是正式发布）。
- 经典 Worker `xingchen-forum` 已删除，**不要重建**；它的 RESEND_API_KEY 也随之无法找回。
- 不要改 D1/KV/R2 绑定名与 `run_worker_first`。

## 验证命令

```bash
npx tsc --noEmit          # 改完代码必跑（无 vitest 覆盖时这是唯一门禁）
pnpm test                 # vitest（部分 lib 有用例）
npx wrangler dev          # 本地 @ :8787；登录测试账号 nebula/nebula12345（uid 4）
npx wrangler tail xingchen-forum-x   # 生产实时日志
```

本地 `.dev.vars` 有独立 JWT 密钥（kid 202610-lny7）且 **Turnstile 禁用**，本地登录不需要验证码。

## 目录结构

```
src/
  index.ts          # Hono app 装配：CORS、安全头、notFound、路由挂载
  types.ts          # AppEnv（DB/CACHE/UPLOADS 绑定 + vars 声明）
  middleware/auth.ts# requireAuth / requireAdmin / requireModerator
  routes/           # auth me users posts replies categories search notifications
                    # reports upload admin oauth well-known
  lib/              # tokens(刷新轮换) session-info password(jwt) mail audit
                    # rate-limit moderation mentions notify queries ids http(错误/响应)
migrations/         # 0001-0009 手写 SQL，序号递增，不加只改
scripts/generate-jwt-keys.mjs  # 生成 RS256 密钥
wrangler*.jsonc     # 部署矩阵（见上）
```

## 架构约定（改动前必读）

**响应与错误**
- 成功 `ok(c, data)`；失败抛 `errors.*`（`lib/http.ts`）→ 统一 `{ error: { code, message, details? } }`，前端按此解析。
- 输入一律 `parseJson(c, zodSchema)`；`lib/validate.ts` 有共用 schema（`imageUrlSchema` 接受相对路径 `/api/...`，**不要用 `.url()`**）。

**认证/会话**
- JWT RS256，`kid` 头 + `/.well-known/jwks.json`；`JWT_ISSUER` 按 Worker 不同（x=https://x.182030.xyz，backend=https://i.182030.xyz）。
- Access 30min / Refresh 30d 轮换（`lib/tokens.ts` 设备链：root_id + 重放检测整链撤销）。设备信息 JSON（UA/IP/位置/colo）由 `lib/session-info.ts` 从 `request.cf` 提取，存 `refresh_tokens.device_info`。
- 密码 PBKDF2-SHA256，迭代 `PASSWORD_ITERATIONS=100000`。
- 生产注册/登录需 Turnstile token（`lib/turnstile.ts`）；`TURNSTILE_SECRET_KEY` 为 secret，写后不可读。

**用户资料序列化（重要坑）**
- 用户公开字段有两处序列化路径：`routes/auth.ts` 的 `publicUser()`（/auth/me、login、register）与 `routes/me.ts`（GET/PATCH /api/me）。**新增 users 列时两处都要加**（例如 0009 的 `likes_public`/`background_url` 当时就漏了 auth.ts，导致「设置背景图刷新后显示未设置」）。
- `PATCH /api/me` 必须返回 `{ success, user }` 且 user 为**全新查询行**——前端靠它直接 `setUser`。

**图片/上传**
- 接口返回的图片地址一律**相对路径**（`/api/files/<r2key>`、`/api/avatars/<uid>?v=`）；跨域前端用 `assetUrl()` 拼前缀。上传用途 purpose：`post|reply|avatar|category|background`。

**权限**
- 角色 `admin > moderator > user`；`users.site_wide_moderator` + `moderators` 表（category 维度）；已删除内容仅管理员与辖区版主可见。
- 审计日志 `lib/audit.ts` → `GET /api/admin/audit-logs`。

**CORS / notFound**
- CORS 白名单走 var `ALLOWED_ORIGINS`（逗号分隔）；当前仅 `forum-backend` 配了 `https://f.182030.xyz`。
- `app.notFound`：有 ASSETS → SPA fallback；无 ASSETS（纯 API）→ **空 404**，不要加回任何 JSON 说明。

## D1 迁移

```bash
# 本地（wrangler dev 的 miniflare D1）
npx wrangler d1 execute xingchen-forum-db --local  --file migrations/00XX.sql
# 生产（真 D1，先备份心智：ALTER 不可逆）
npx wrangler d1 execute xingchen-forum-db --remote --file migrations/00XX.sql
```

- 迁移文件一旦提交过生产就不要再改内容；修正用新迁移。
- 两边都要执行；先本地验证再 remote。

## Secrets（写后不可读）

```bash
echo '<key>' | npx wrangler secret put JWT_SIGNING_KEYS --name <worker>   # 每 Worker 独立
node scripts/generate-jwt-keys.mjs --print                                # 生成格式见脚本
npx wrangler secret put TURNSTILE_SECRET_KEY --name forum-backend
npx wrangler secret put RESEND_API_KEY      --name forum-backend          # 尚未配置，邮件静默跳过
```

## Git

独立仓库 `github.com/wwwaaa123122/starlr-forum-backend`（main，**中文提交信息**，一行主题即可）。当前工作区可能有未提交改动——属于最近功能开发，改完相关文件顺手提交。

## 第三方服务配置（2026-10-07 起）

- **凭据一律存 KV**（不放 wrangler vars/secrets，改配置无需重新部署）：`config:mail`（Resend 邮件）、`config:s3`（S3 兼容存储）、`config:oauth:github`（GitHub OAuth 登录）。
- 管理后台「服务配置」页（/admin/services，仅 admin）可视化维护：掩码回显、来源标注（后台/环境）、连通测试、清空回退。
- 邮件发送读取顺序：KV `config:mail` → env（RESEND_API_KEY / MAIL_FROM）兜底；生产当前无 env 兜底，填了后台配置邮件即通。

## SEO 层（2026-10-07 起）

- **唯一收录主域 = `starlr.tech`**（KV `config:seo.canonical_host`，改它无需改代码）。x / forum / f / www 域页面 canonical 一律归并到主域，不做用户可见 301。
- 主站地址 = x Worker 的 `SITE_URL`（`https://starlr.tech`）：邮件链接、OAuth 回跳、APP 协议链接都跟它；`JWT_ISSUER` 与 `APP_AUTH_ORIGIN` **刻意保持 x.182030.xyz**（改前者会让全部用户掉线，改后者会让旧 APK 登录桥接失配）。
- **爬虫动态渲染**：`backend/src/routes/seo.ts` 对搜索引擎/社交爬虫 UA 直接输出真实正文 HTML（h1/正文/回复/JSON-LD），真人继续走 SPA。新增爬虫或页面类型都在此文件扩展。
- **SEO 路径必须进 Worker**：`wrangler.x.jsonc` 的 `assets.run_worker_first` 已含页面路径 + `/robots.txt` `/sitemap.xml` `/feed.xml`；**新增 SEO 页面路由时同步加进去**，否则会被静态资源层截胡。
- 爬虫兜底走 `index.ts` 的 `notFound`（`seoFallback`）——**不要在 seo.ts 里写 `app.get('*')` 通配**，它会吞掉后挂载的 `/api/*` 路由（曾出过该事故）。
- f 站（`forum-frontend`）已从"纯 assets 无绑定"升级为薄 Worker（`src/index-f.ts`）：仅 robots/sitemap/feed 三个路径进 Worker（`run_worker_first` 白名单），其余保持 assets 直出；**零 D1/KV 绑定**不变。
- 站内 SEO 配置在管理后台「服务配置 → SEO / 搜索引擎」：canonical 主域、百度/Google/Bing 站长验证码、百度主动推送 token（填后发帖自动推送）。
- 方案全文见 `docs/SEO方案.md`。

### 邮件发件人说明（Resend Return-Path）

- 显示发件人（`From:` 头）统一为 `星辰旅人论坛 <no-reply@182030.xyz>`（vars `MAIL_FROM`，KV `config:mail.from` 可覆盖，代码兜底同值）。
- 收到形如 `010601a...-<uuid>-000000@rsend.182030.xyz` 的地址**不是发件人**，而是 Resend 自动生成的**退信信封地址（Return-Path / MAIL FROM）**，用于接收 bounce；其 MX（`rsend.182030.xyz` → Amazon SES）与 SPF/DKIM 由 Resend 域名验证时配置，**不要试图改成 no-reply@**（会造成退信丢失且可能 SPF 不对齐）。
- 邮件客户端里的「由 rsend.182030.xyz 代发」提示同理，是 From 域与信封域不同导致的，属正常。
- 管理后台「服务配置 → 邮件 → 测试连通」会回显实际生效的 From 与配置来源，便于核对。

### 邮件多账号轮询（2026-10-07 起）

- 发件账号池：KV `config:mail.accounts`（`[{api_key, from}]`）+ env `RESEND_API_KEY`（secret 不可读，自动作为兜底成员追加，不进 KV）。
- 轮询：秒级时间片取模分摊限额；当前账号发送失败（限速/余额/域名问题）自动顺移下一个，全部失败才报错并附最后错误。
- 新账号的 From 域必须在对应 Resend 账号里验证（API `GET /domains` 可查）。
- 管理后台「服务配置 → 邮件」可视化增删账号；api_key 留空 = 保持原值；env 兜底行只读展示。

## 自部署模板与初始化脚本（开源适配）

- `wrangler.example.jsonc`（单 Worker 同域）/ `wrangler.api.example.jsonc`（纯 API 分离部署）是**给别人的模板**，不含真实 ID；`scripts/setup.mjs` 读模板生成 `wrangler.prod.jsonc` / `wrangler.api.jsonc`（已 gitignore）。
- 作者自己的 `wrangler.x.jsonc` / `.backend` / `.frontend` 保持原样，只用于作者生产；不要把它们改成通用模板。
- 首个注册用户自动 admin 用**单条原子 UPDATE**（`NOT EXISTS (SELECT 1 FROM users WHERE id <> ?)`）：并发只有一个管理员，且管理员被删后不会把权限白送给新注册者。改这段逻辑务必保住这两个性质。
- 所有站点相关的硬编码域名都走环境变量：`SITE_URL` / `APP_AUTH_ORIGIN` / `CANONICAL_SITE_URL` / `ALLOWED_ORIGINS` / `OAUTH_REDIRECT_ORIGINS` / `SSO_ALLOWED_ORIGINS`。新增代码**不得**再写死域名。
- 默认值集中在 `src/config/defaults.json`，不要在代码里新增魔法默认值。
