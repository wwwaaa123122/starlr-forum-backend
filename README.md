# 星辰旅人论坛 — 后端（Cloudflare Workers）

> Hono + TypeScript REST API · D1 数据库 · KV 缓存/限流 · R2 存储 · Resend 邮件 · Turnstile 反机器人
>
> 前端仓库：`starlr-forum-frontend`（React 19 + Vite + Tailwind v4 + shadcn/ui）
> 本仓库与前端仓库 **前后端分离、独立部署**；生产为单个 Worker 同时承载 API 与前端静态资源。

**线上地址：** https://i.182030.xyz

## 仓库结构

```
starlr-forum-backend/
├── src/
│   ├── routes/        # REST API（auth/posts/replies/search/users/notifications/...）
│   ├── middleware/    # 认证与权限（optionalAuth/requireAuth/requireRole）
│   ├── lib/           # JWT/密码/限流/Turnstile/邮件(Resend)/审计/通知
│   ├── types.ts       # 绑定与环境变量类型
│   └── index.ts       # Hono 应用装配
├── migrations/        # D1 迁移（含 FTS5 全文索引、UID 计数器）
├── test/              # Vitest + @cloudflare/vitest-pool-workers（113 个用例）
├── scripts/           # JWT 密钥生成
└── wrangler.jsonc     # Workers 配置（绑定/变量/自定义域名）
```

> **部署约定：** `wrangler.jsonc` 的 assets 指向 `../frontend/dist`。请把前端仓库克隆为同级的 `frontend` 目录：
> `git clone git@github.com:wwwaaa123122/starlr-forum-frontend.git frontend`。
> 也可用 `wrangler deploy --assets <任意 dist 目录>` 覆盖。

---

## 架构总览

```
                ┌──────────────────────┐
                │  React + shadcn/ui   │  frontend/（Vite 构建，静态资源）
                └──────────┬───────────┘
                           │ REST API (Bearer JWT)
                           ▼
                ┌──────────────────────┐
                │  Cloudflare Worker   │  backend/（Hono 路由）
                │                      │
                │  REST API            │
                │  JWT Authentication  │  RS256 + kid + JWKS
                │  Forum / Admin       │  RBAC + audit logs
                └───────┬──────┬───────┘
                        │      │
              ┌─────────┘      └─────────┐
              ▼                          ▼
        ┌───────────┐              ┌───────────┐
        │    D1     │              │    KV     │
        │  SQLite   │              │ 缓存/限流  │
        └───────────┘              └───────────┘
              │
              ▼
        ┌───────────┐     ┌─────────────────────┐
        │    R2     │     │ Turnstile 反机器人   │
        │  Uploads  │     │（注册/登录校验）      │
        └───────────┘     └─────────────────────┘

                 Future
                    │
                    ▼
          ┌───────────────────┐
          │ OAuth 2.0 / OIDC  │
          │ Identity Provider │
          └───────────────────┘
```

**部署形态：** 单个 Worker 同时承载 REST API（`/api/*`）与前端静态资源（`run_worker_first` 保证 API 优先命中 Worker，其余路径由 Assets 层直接服务并做 SPA fallback）。

---

## 核心功能

| 领域 | 功能 |
| --- | --- |
| 邮件 | Resend 发件（no-reply@182030.xyz）：注册欢迎邮件、密码重置（30 分钟一次性令牌）、管理告警（新举报/权限变更） |
| 论坛 | 分类 → 帖子（标题/正文/标签/浏览/回复/点赞）→ 回复（楼中楼/引用）|
| 互动 | 点赞、收藏、浏览量（KV 去重防刷）、分享、举报 |
| Markdown | 标题/粗斜体/列表/引用/链接/图片/表格/代码块 + 语法高亮，严格白名单 sanitize |
| 通知 | 被回复、被 @、被点赞、被收藏、管理通知；未读数/单条已读/全部已读 |
| 搜索 | D1 FTS5（trigram，支持中文子串）+ LIKE 自动回退；帖子/用户搜索（支持按 UID）；防注入/限流/分页 |
| 用户 | 每个 UID 从 1 开始唯一自增（管理员为 UID 1）；修改密码；忘记/重置密码 |
| 图片 | R2 存储；服务端校验大小/MIME/魔数（拒绝可执行与伪装文件）；头像/帖子图片 |
| 管理后台 | 用户（封禁/解封/禁言/角色）、帖子（删/恢复/置顶/精华）、回复、分类 CRUD、举报处理、审计日志、**按 UID 授权多管理员**（admin/moderator，至少保留一位管理员） |
| 安全 | 见下方「安全设计」章节 |

---

## 邮箱验证与账号状态

- 注册后账号为**未验证**（`email_verified = 0`）：可登录浏览，但发帖 / 回复 / 上传图片返回 `403 EMAIL_NOT_VERIFIED`
- 注册即发送**激活邮件**（Resend，24 小时一次性令牌，KV `emailverify:{sha256}`）；`POST /api/auth/verify-email` 激活
- 未验证用户可在站内**重新发送验证邮件**（`POST /api/auth/resend-verification`，3 次/小时）
- 管理员兜底：`POST /api/admin/users/:id/verify` 手动激活（邮件未送达时）
- 账号状态优先级：`banned`（封禁）> `unverified`（未验证邮箱）> `active`（正常），通过 `me` 与注册响应的 `accountStatus` 下发
- 存量用户通过迁移默认为已验证，不受影响

## 身份认证系统（核心设计）

### Access Token（JWT / RS256，24 小时）

```json
{
  "iss": "https://xingchen-forum.wwwaaa123122.workers.dev",
  "sub": "a6c39wmxpayuon33",        // 稳定随机用户 ID，绝不用用户名
  "aud": "api",
  "iat": 1791202351,
  "exp": 1791288751,                // iat + 86400（24h）
  "jti": "p7xtigxpeypx3bau2zqyuzcr",
  "typ": "access",
  "role": "user"
}
```

- JWT 中不包含密码，也不携带大量用户资料（role 除外，且服务端以数据库为准）
- 服务端逐项验证：**签名 → iss → aud → exp → iat → typ → 用户状态 → 权限**
- Header 携带 `kid`，支持多密钥并存与平滑轮换

### 密钥管理

- 私钥只存于 Cloudflare Secret `JWT_SIGNING_KEYS`，格式：

```json
[{ "kid": "202610-ab12", "jwk": { "...RS256 私钥 JWK..." }, "active": true }]
```

- 生成（本地或生产）：

```bash
# 本地开发：自动写入 backend/.dev.vars（已被 .gitignore 忽略）
node scripts/generate-jwt-keys.mjs

# 生产：直接管道写入 Secret，私钥不落盘不打印
node scripts/generate-jwt-keys.mjs --print | wrangler secret put JWT_SIGNING_KEYS   # 在本仓库内执行
```

- **轮换流程：** 生成新密钥 → 数组中加入新条目（新 `active:true`，旧条目改 `active:false`）→ 更新 Secret。旧公钥保留在 JWKS 中，旧 Token 在旧 kid 下仍可验证，直到确认全部过期后再移除旧条目。

### JWKS（未来 OIDC 的基础）

- `/.well-known/jwks.json` 公开全部验证公钥（仅 `n/e/kty/alg/kid/use`，绝不包含私钥参数）
- `/.well-known/openid-configuration` 提供 OIDC 发现元数据

### Refresh Token（Rotation + Replay 检测）

- 高熵随机值（32 字节），数据库只存 **SHA-256 哈希**，有效期 30 天
- 刷新流程：`校验 → 旧 Token 标记 rotated → 签发新 Refresh Token → 签发新 24h Access Token`
- **Replay 检测：** 已轮换的 Token 再次出现 → 撤销**整条 Token 链**（`root_id`），返回 `TOKEN_REPLAY`
- 支持主动撤销：登出当前设备 / 登出所有设备 / 管理员封禁即时全设备失效 / 密码修改与重置后强制全设备下线

### UID 与多管理员

- 用户注册时通过 `counters` 表原子分配 UID（从 1 开始、全局唯一；管理员固定为 UID 1）
- 管理后台「管理员」Tab：输入 UID 即可授予/撤销管理员或版主权限（仅 admin 可操作；不能撤销自己；至少保留一位管理员），并邮件通知被授权人

### 文件与头像存储

- **头像**：上传后存入 KV（键 `avatar:{uid}`，≤2MB，带 contentType 元数据），经 `GET /api/avatars/:uid` 读取；URL 带 `?v=` 时间戳做缓存失效；用户头像改动即时生效
- **帖子/回复图片**：存入 R2，经 `GET /api/files/{key}` 读取（一年不可变缓存）
- 两者共用 `POST /api/upload`（purpose=avatar/post/reply），服务端强校验 MIME + 魔数字节

### 邮件（Resend）

- 域名 `182030.xyz` 已完成 Resend 验证，发件人 `no-reply@182030.xyz`
- 变量：`MAIL_FROM`（发件人）；Secret：`RESEND_API_KEY`
- 触发场景：注册欢迎、密码重置链接（KV 一次性令牌，30 分钟）、新举报告警、管理员授权通知
- **收件人一律按 UID 定位**：管理告警发送至 **UID 1（站长）** 的邮箱（UID 1 无有效邮箱时回退到其他在职管理员）
- 失败不阻塞业务主流程（仅记录日志）；本地/测试用 `MAIL_TRANSPORT=memory` 捕获到内存 outbox

### 密码找回与修改

- `POST /api/auth/forgot-password`：发送重置邮件（统一响应防邮箱枚举，限流 5 次/小时）
- `POST /api/auth/reset-password`：`token + 新密码`，一次性令牌，成功后撤销全部登录状态
- `PATCH /api/me/password`：登录态修改密码（验证当前密码，成功后全设备重新登录）

### 前端会话

- Access Token 内存 + localStorage；401 时自动单飞刷新并重试；到期前 10 分钟主动轮换
- Bearer Token 认证（非 Cookie），天然免疫 CSRF；配合严格输出转义防御 XSS

---

## 安全设计

| 威胁 | 防护 |
| --- | --- |
| XSS | Markdown 渲染不引入 `rehype-raw`（原始 HTML 永远按纯文本显示）；`rehype-sanitize` 白名单过滤；链接协议仅 `http/https/mailto`；CSP 禁止内联脚本 |
| SQL 注入 | 全部参数化查询（D1 prepared statements），LIKE 通配符转义，测试覆盖 |
| CSRF | API 全部使用 `Authorization: Bearer`，不依赖 Cookie |
| JWT 攻击 | 固定 `RS256`（拒绝 `none`/算法混淆）、校验 `kid`/`iss`/`aud`/`exp`/`iat`/`typ`、恒定时间比较、私钥不出 Secret |
| Token Replay | Refresh Token Rotation + 整链撤销 |
| 暴力破解 | KV 限流（登录 10 次/10 分钟，注册 5 次/小时），按 IP+UA 指纹 |
| 用户枚举 | 登录/注册统一错误文案；登录失败仍执行哈希校验均衡时序 |
| IDOR/越权 | 所有写操作校验资源归属；RBAC（user < moderator < admin）；封禁状态每次请求实时校验 |
| 恶意上传 | 大小 ≤5MB、MIME 白名单（JPEG/PNG/GIF/WEBP）、**魔数字节校验**（拒绝伪装的可执行/脚本/HTML） |
| 刷浏览量 | KV 按 访客×帖子 去重（1 小时窗口） |
| Spam/Bot | Cloudflare Turnstile（注册/登录服务端 siteverify 校验） |
| Open Redirect | 无服务端重定向参数；OAuth 预留 redirect_uri 严格匹配设计 |
| 信息泄露 | 统一 JSON 错误格式，服务端日志不回传客户端 |

密码哈希：**PBKDF2-HMAC-SHA256**（WebCrypto 原生实现，100,000 次迭代，可经 `PASSWORD_ITERATIONS` 调整），格式 `pbkdf2$sha256$<iter>$<salt>$<hash>`，不自行实现密码学算法。

---

## 数据库（D1）

17 张表：`users`、`refresh_tokens`、`categories`、`posts`、`replies`、`tags`、`post_tags`、`likes`、`favorites`、`notifications`、`reports`、`bans`、`attachments`、`audit_logs`、`oauth_clients`、`oauth_authorization_codes`、`oauth_consents`，外加 FTS5 虚拟表 `posts_fts`（trigram 中文全文检索 + 触发器同步）。

- 全部通过 **Migration** 管理（`backend/migrations/`），禁止手工改生产表结构
- 唯一约束（用户名/邮箱/点赞/收藏/标签）、必要索引（分类列表/作者维度/通知未读等）、外键关系完整
- 列表查询 JOIN 一次取回、标签批量 IN 查询 —— 避免 N+1

常用命令：

```bash
pnpm db:migrate:local     # 本地迁移
pnpm db:migrate:remote    # 生产迁移
```

---

## 本地开发

```bash
pnpm install
node scripts/generate-jwt-keys.mjs   # 生成 .dev.vars（JWT 密钥 + 关闭 Turnstile）
pnpm db:migrate:local                # 本地迁移
pnpm dev                             # Worker @ :8787
```

前端另起 `starlr-forum-frontend` 仓库的 Vite（:5173，/api 代理到 8787）。本地默认跳过 Turnstile 校验、邮件写入内存。

## 部署（Cloudflare）

```bash
# 先在前端仓库构建产物（或克隆为同级 frontend 目录后执行其 pnpm build）
pnpm deploy           # wrangler deploy（Worker + 静态资源）
pnpm test             # 自动化测试（113 个用例）
```

生产 Secret（首次部署或轮换时）：

```bash
node scripts/generate-jwt-keys.mjs --print | wrangler secret put JWT_SIGNING_KEYS   # 在本仓库内执行
wrangler secret put TURNSTILE_SECRET_KEY   # Turnstile widget secret
```

## 提升管理员

注册目标账号后：

方式一：管理后台「管理员」Tab 输入 UID 授权（推荐）。方式二（首次引导/CLI）：

```bash
wrangler d1 execute xingchen-forum-db --remote \
  --command "UPDATE users SET role='admin' WHERE username='你的用户名'"
```

管理告警固定发送至 **UID 1 的邮箱**——把站长账号的邮箱设置好即可，无需额外配置变量。站长邮箱在数据库中更新：

```bash
wrangler d1 execute xingchen-forum-db --remote \
  --command "UPDATE users SET email='you@example.com' WHERE uid=1"
```

## Turnstile

- Widget 已创建（managed 模式）：`wrangler turnstile widget create ...`
- 站点密钥（公开）：`wrangler.jsonc` 的 `TURNSTILE_SITE_KEY` → 前端 `/api/config` 获取并渲染
- 服务端密钥（保密）：Secret `TURNSTILE_SECRET_KEY` → 注册/登录时 siteverify 校验
- 本地开发：`.dev.vars` 设 `TURNSTILE_DISABLED=true` 跳过

## 自动化测试

```bash
pnpm test    # vitest + @cloudflare/vitest-pool-workers（真实 workerd + 隔离 D1/KV/R2）
```

覆盖（113 个用例）：

- **用户**：注册（唯一性/弱密码/非法用户名/密码哈希格式）、登录（用户名/邮箱/统一错误）、JWT claims（iss/sub/aud/iat/exp/jti/kid）、Refresh Rotation、Replay 整链撤销、登出/登出全部设备、资料修改
- **论坛**：发帖/列表/回复/楼中楼/编辑/删除/点赞防重/收藏/浏览去重/搜索（中英文/用户/注入安全）/通知/@ 上限/举报
- **权限**：普通用户 × 管理员 API、越权修改/删除他人内容、跨帖引用、RBAC 边界（moderator vs admin）、封禁/禁言即时生效、审计日志
- **安全**：`alg:none`、错误 iss/aud/iat、过期 Token、伪造 kid、篡改签名、Refresh Replay、恶意上传（ELF/Shell/HTML 伪装）、暴力登录限流、SQL 注入、错误格式统一、OAuth 元数据

## 已知边界与后续阶段

- OAuth/OIDC IdP：表结构与发现端点已就绪，`/oauth/*` 返回 501；下一阶段实现 Authorization Code + PKCE
- 邮箱验证：注册后的邮箱所有权验证暂未实现（当前邮件用于欢迎/重置/告警）
- 限流为 KV 基础防护，建议叠加 Cloudflare WAF Rate Limiting 规则
- 搜索的 FTS5 trigram 需要 ≥3 字符关键词，短词自动回退 LIKE
