# Starlr Forum — 后端（Cloudflare Workers）

> Hono + TypeScript REST API · D1 · KV · R2 · Resend 邮件 · Turnstile 反机器人
>
> 配套前端：[`starlr-forum-frontend-x`](https://github.com/wwwaaa123122/starlr-forum-frontend-x)（React 19 + Vite + Tailwind v4）
> 许可：GPL-3.0-or-later · 作者线上实例：<https://forum.182030.xyz>（仅作效果参考，自部署不依赖它）

**这是一个可以完全独立部署的论坛后端。** 你只需要一个 Cloudflare 账号和一个自己的域名，
不需要原作者的 D1 / KV / R2 / 域名 / 密钥，也不需要修改任何源码即可跑起来。

---

## 目录

- [10 分钟从零部署](#10-分钟从零部署)
- [部署模式](#部署模式)
- [配置参考](#配置参考)
- [初始化：第一个管理员](#初始化第一个管理员)
- [数据库：迁移、备份、恢复、升级](#数据库迁移备份恢复升级)
- [本地开发](#本地开发)
- [测试与 CI](#测试与-ci)
- [故障排查](#故障排查)
- [功能状态（哪些要额外配置）](#功能状态哪些要额外配置)
- [认证与安全设计](#认证与安全设计)
- [目录结构](#目录结构)
- [许可](#许可)

---

## 10 分钟从零部署

### 0. 前置条件

| 需要 | 说明 |
|---|---|
| Cloudflare 账号 | 免费版即可（Workers 免费额度足够小论坛起步） |
| 一个域名 | 已托管在**你自己的** Cloudflare 账号下（Nameserver 指向 Cloudflare） |
| Node.js ≥ 20 | `node -v` 检查 |
| 两个仓库 | `git clone` 本仓库 + 前端仓库，放在**同一父目录**下 |

```bash
git clone https://github.com/wwwaaa123122/starlr-forum-backend.git
git clone https://github.com/wwwaaa123122/starlr-forum-frontend-x.git
cd starlr-forum-backend
npm ci
```

### 1. 登录 Cloudflare

```bash
npx wrangler login          # 浏览器授权（推荐）
# 或（CI / 无浏览器）：
export CLOUDFLARE_API_TOKEN=<你的 API Token>
# Token 权限：Workers Scripts:Edit、D1:Edit、Workers KV Storage:Edit、R2:Edit
```

### 2. 一键创建资源并生成配置

```bash
npm run setup
```

脚本会（**幂等，可重复执行**）：

1. 检查登录状态；
2. 创建 D1 数据库 / KV 命名空间 / R2 桶（已存在则复用，不会重复创建）；
3. 生成 RS256 JWT 签名密钥写入 `.dev.vars`（本地开发用，已 gitignore）；
4. 用模板生成 **`wrangler.prod.jsonc`**（含你的资源 ID、域名、SITE_URL）；
5. 打印剩余的手动步骤。

非交互（脚本化）：

```bash
node scripts/setup.mjs --yes \
  --site-url https://forum.example.com \
  --domain forum.example.com \
  --worker my-forum \
  --db my-forum-db --kv my-forum-kv --r2 my-forum-uploads \
  --mode single
```

> 想手动创建也可以，命令见 [手动创建资源](#手动创建资源cloudflare-控制台--cli)。

### 3. 设置生产密钥（必须手动，密钥不进仓库）

```bash
# JWT 签名密钥：生成后直接管道写入 Secret，私钥不落盘
node scripts/generate-jwt-keys.mjs --print | npx wrangler secret put JWT_SIGNING_KEYS -c wrangler.prod.jsonc
```

> 每个 Worker 的 `JWT_SIGNING_KEYS` 必须各自设置一份（同一个值也行；分离部署时建议不同）。

### 4. 建表

```bash
npx wrangler d1 migrations apply my-forum-db --remote -c wrangler.prod.jsonc
```

### 5. 构建前端

```bash
cd ../starlr-forum-frontend-x
npm ci
npm run build          # 同域部署：产物在 dist/（API 走相对路径 /api）
cd ../starlr-forum-backend
```

### 6. 部署 Worker

```bash
npx wrangler deploy -c wrangler.prod.jsonc
```

### 7. 注册第一个账号 = 管理员

打开 `https://forum.example.com` → 注册 → **这个账号自动成为管理员（admin）**，邮箱视为已验证。
登录后进入 `/admin` 完成后续配置（站点名、注册开关、邮件、Turnstile…）。

### 8. 验证部署成功

```bash
curl -s https://forum.example.com/api/config          # 应返回 JSON（siteName 等）
curl -s -o /dev/null -w '%{http_code}\n' https://forum.example.com/          # 200
curl -s -o /dev/null -w '%{http_code}\n' https://forum.example.com/api/posts # 200
```

### 最短流程速查

```bash
npm ci && npx wrangler login
npm run setup
node scripts/generate-jwt-keys.mjs --print | npx wrangler secret put JWT_SIGNING_KEYS -c wrangler.prod.jsonc
npx wrangler d1 migrations apply <db名> --remote -c wrangler.prod.jsonc
(cd ../starlr-forum-frontend-x && npm ci && npm run build)
npx wrangler deploy -c wrangler.prod.jsonc
```

---

## 部署模式

### A. 单 Worker 同域（推荐，最简单）

```
https://forum.example.com/          → 前端静态资源（assets）
https://forum.example.com/api/...   → Worker 里的 API
```

- 模板：`wrangler.example.jsonc` → 生成 `wrangler.prod.jsonc`
- CORS：**不需要**（同源）
- 前端构建：`npm run build`（不设置 `VITE_API_BASE`）
- 优点：零 CORS 配置、存储同源、一条命令部署

### B. 前后端分离（前端在 Pages/别的域名，API 独立）

```
https://forum.example.com           → 前端（构建时 VITE_API_BASE=https://api.example.com）
https://api.example.com/api/...     → 本仓库 Worker（纯 API）
```

- 模板：`wrangler.api.example.jsonc` → 生成 `wrangler.api.jsonc`
- **必须**把前端源写进 `ALLOWED_ORIGINS`（否则浏览器被 CORS 拦截）
- 前端构建：`VITE_API_BASE=https://api.example.com npm run build`
- `SITE_URL` 填**前端**地址（邮件链接、OAuth 回跳用它），`JWT_ISSUER` 填本 Worker 地址
- 图片走 `/api/files/*`，前端用 `assetUrl()` 自动拼 API 前缀

> 两种模式可以同时存在并共享同一套 D1/KV/R2（例如网页同域 + App 直连 API 域名）。

### 手动创建资源（Cloudflare 控制台 / CLI）

```bash
# D1（记下输出的 database_id）
npx wrangler d1 create my-forum-db

# KV（记下输出的 id）
npx wrangler kv namespace create my-forum-kv

# R2（桶名即可，无需 ID）
npx wrangler r2 bucket create my-forum-uploads
```

控制台路径：**Workers & Pages → D1 / KV / R2**。把三个值填进 `wrangler.prod.jsonc`
（或复制 `wrangler.example.jsonc` 手动改）。

---

## 配置参考

### 优先级

```
KV 运行时配置（管理后台）  >  环境变量 / Secret  >  src/config/defaults.json  >  代码兜底
```

- **站点名、注册开关、邮件、S3、GitHub 登录**等都能在管理后台改，改完立即生效，**不用重新部署**。
- 想改「全新部署时的初始默认值」，改 `src/config/defaults.json`。

### 普通变量（`vars`，明文，随代码部署）

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `SITE_URL` | ✅ | — | 站点根地址，无尾斜杠。用于邮件链接、OAuth 回跳、APP 协议链接 |
| `JWT_ISSUER` | ✅ | — | JWT `iss`，一般等于 `SITE_URL`；分离部署填 API 域名 |
| `JWT_AUDIENCE` | ✅ | `api` | JWT `aud` |
| `ACCESS_TOKEN_TTL` | | `1800` | Access Token 有效期（秒） |
| `REFRESH_TOKEN_TTL` | | `2592000` | Refresh Token 有效期（秒，30 天） |
| `PASSWORD_ITERATIONS` | | `100000` | PBKDF2 迭代次数 |
| `TURNSTILE_SITE_KEY` | | 空 | Turnstile 站点密钥（**公开值**，会下发给前端）；留空则不渲染验证组件 |
| `MAIL_FROM` | | defaults 兜底 | 发件人，如 `My Forum <no-reply@example.com>` |
| `ALLOWED_ORIGINS` | 分离部署必填 | 空 | 允许跨域的前端源，逗号分隔 |
| `OAUTH_REDIRECT_ORIGINS` | | 空（用 `ALLOWED_ORIGINS` + `SITE_URL`） | OAuth 登录后可回跳的前端源，逗号分隔 |
| `SSO_ALLOWED_ORIGINS` | | 空 | 允许「登录状态同步」的第三方站点源，逗号分隔 |
| `APP_AUTH_ORIGIN` | | `SITE_URL` 的 origin | Android 客户端登录桥接页（`/app-auth`）所在站点源 |
| `CANONICAL_SITE_URL` | | `SITE_URL` 的 origin | SEO canonical / sitemap 归并目标 |
| `MAIL_TRANSPORT` | | — | 设 `memory` = 邮件只写内存不外发（测试用） |
| `TURNSTILE_DISABLED` | | — | 设 `true` 跳过人机验证。**生产禁止设置** |

### Secrets（`wrangler secret put`，写后不可读）

| Secret | 必填 | 说明 |
|---|---|---|
| `JWT_SIGNING_KEYS` | ✅ | RS256 私钥 JWK 数组 JSON，见 [密钥管理](#密钥管理) |
| `TURNSTILE_SECRET_KEY` | 启用 Turnstile 时 | Turnstile 服务端密钥（**必须保密**） |
| `RESEND_API_KEY` | 需要发邮件时 | Resend API Key（`re_...`）。也可在管理后台配置，支持多账号池 |

```bash
npx wrangler secret put JWT_SIGNING_KEYS     -c wrangler.prod.jsonc
npx wrangler secret put TURNSTILE_SECRET_KEY -c wrangler.prod.jsonc
npx wrangler secret put RESEND_API_KEY       -c wrangler.prod.jsonc
npx wrangler secret list -c wrangler.prod.jsonc   # 只看名称，不看值
```

### 哪些值可以公开、哪些必须保密

| 可以公开（进仓库/前端可见） | 必须保密（Secret / 本地 `.dev.vars`） |
|---|---|
| 站点域名、`SITE_URL`、`JWT_ISSUER`、`JWT_AUDIENCE` | `JWT_SIGNING_KEYS`（私钥） |
| `TURNSTILE_SITE_KEY` | `TURNSTILE_SECRET_KEY` |
| D1 / KV 的 ID、R2 桶名 | `RESEND_API_KEY`、S3 Secret Key、GitHub Client Secret |
| `ALLOWED_ORIGINS` 等 | Cloudflare API Token |

> D1/KV/R2 的 ID 本身不是密钥，但仍建议放在 `wrangler.prod.jsonc`（已 gitignore）而不是提交到仓库。

### 默认配置文件

`src/config/defaults.json` 集中了所有默认值（站点名、标语、注册开关、SEO 域名、邮件发件人兜底、APP 更新兜底）。
自部署者想改「初始默认值」直接改这个文件；说明见 [`src/config/README.md`](./src/config/README.md)。

### 管理后台可改的运行时配置（KV）

| KV 键 | 后台位置 | 内容 |
|---|---|---|
| `config:site` | 站点设置 | 站点名/标语/描述/页脚 |
| `config:setup` | 站点设置 | 注册总开关、邮箱是否必填、图片存储（r2/s3） |
| `config:mail` | 服务配置 → 邮件 | Resend 账号池（多账号轮询） |
| `config:s3` | 服务配置 → S3 | S3 兼容存储凭据 |
| `config:seo` | 服务配置 → SEO | canonical 主域、站长验证码、百度推送 token |
| `config:oauth:github` | 服务配置 → GitHub | GitHub OAuth App 凭据 |
| `config:sso` | SSO 同步 | 允许登录同步的站点白名单 |
| `config:app` | — | Android 客户端版本信息（由发布流程写入） |

---

## 初始化：第一个管理员

### 规则

- **全新部署（用户表为空）后，第一个注册的账号自动获得 `admin` 角色，且邮箱视为已验证。**
- 判定是**单条原子 SQL**（`UPDATE ... WHERE id = ? AND NOT EXISTS (SELECT 1 FROM users WHERE id <> ?)`）：
  - 并发注册时**只有一个人**能成为管理员，不会出现多个初始管理员；
  - 已有任何用户之后，新注册者**永远不会**自动获得管理员（即使管理员账号被删除，也不会把权限白送出去）。

### 之后要加管理员

管理后台 → **管理员** Tab → 输入目标用户 UID 授权（推荐）。
或 CLI：

```bash
npx wrangler d1 execute my-forum-db --remote -c wrangler.prod.jsonc \
  --command "UPDATE users SET role='admin' WHERE username='someone'"
```

### 注册开关（可选）

管理后台 → **站点设置**：

| 项 | 默认 | 说明 |
|---|---|---|
| 开放注册 | 开 | 关闭后注册接口返回 `403 REGISTRATION_CLOSED` |
| 注册需要邮箱 | 开 | 关闭 = **用户名 + 密码直接注册**（不发验证邮件、账号直接激活、登录用用户名） |
| 图片上传到 S3 | 关（用 R2） | 开启前先在「服务配置 → S3」填好凭据并点「测试连通」 |

> 无邮箱模式下，数据库 `email` 列存合成占位地址 `noemail-<id>@users.invalid`
> （保留 `NOT NULL + UNIQUE` 约束，不影响用户名登录）。

---

## 数据库：迁移、备份、恢复、升级

### 迁移

```bash
npm run db:migrate:local    # 本地（wrangler dev 的本地 D1）
npm run db:migrate:remote   # 生产（package.json 里已带 -c wrangler.prod.jsonc）
```

迁移文件在 `migrations/`，序号递增，**已上过生产的迁移不要再改内容**，修正请新增迁移。

### 备份

```bash
# 导出全库为 SQL（含结构与数据）
npx wrangler d1 export my-forum-db --remote -c wrangler.prod.jsonc --output backup-$(date +%F).sql

# 只导出数据
npx wrangler d1 export my-forum-db --remote -c wrangler.prod.jsonc --no-schema --output data-$(date +%F).sql
```

R2 里的图片另存（可用 `rclone` / `aws s3` 指向 R2 端点同步，或在 Cloudflare 控制台导出）。

### 恢复

```bash
# 最稳妥：先建新库再导入，避免覆盖冲突
npx wrangler d1 create my-forum-db-restore
npx wrangler d1 execute my-forum-db-restore --remote -c wrangler.prod.jsonc --file backup-2026-01-01.sql
# 验证无误后把 wrangler.prod.jsonc 里的 database_id 换成新库 ID 并重新部署
```

### 升级到新版本

```bash
git pull                                  # 拉取新代码
npm ci                                    # 依赖可能变化
npm run typecheck && npm test             # 先自测
npx wrangler d1 export <db> --remote -c wrangler.prod.jsonc --output pre-upgrade-$(date +%F).sql   # 备份
npx wrangler d1 migrations apply <db> --remote -c wrangler.prod.jsonc   # 应用新迁移
(cd ../starlr-forum-frontend-x && git pull && npm ci && npm run build)  # 重建前端
npx wrangler deploy -c wrangler.prod.jsonc
```

> 升级前先看提交记录里是否有「需要新 Secret」「需要新迁移」的说明。

---

## 本地开发

```bash
npm ci
cp .dev.vars.example .dev.vars
node scripts/generate-jwt-keys.mjs     # 生成 RS256 密钥写入 .dev.vars（同时关掉 Turnstile）
npm run db:migrate:local               # 建本地表
npm run dev                            # Worker @ http://127.0.0.1:8787
```

前端另开终端（`starlr-forum-frontend-x` 仓库）：

```bash
npm ci && npm run dev                  # Vite @ http://127.0.0.1:5174，/api 代理到 8787
```

- 本地默认**跳过 Turnstile**、邮件写入内存 outbox（不外发）。
- 本地数据库状态持久化在 `.wrangler/`（可用 `--persist-to` 指定目录）。
- 清空本地数据：删掉 `.wrangler/state` 后重新 `npm run db:migrate:local`。

---

## 测试与 CI

```bash
npm run typecheck      # tsc --noEmit
npm test               # vitest + @cloudflare/vitest-pool-workers（真实 workerd + 隔离 D1/KV/R2）
```

- 测试**不依赖任何生产密钥**：`vitest.config.ts` 每次运行临时生成 RS256 密钥，Turnstile 关闭，邮件走内存。
- 当前用例数：**170 个**（23 个测试文件），覆盖注册/登录/JWT/刷新轮换/权限/越权/上传/限流/站点初始化开关等。
- CI：`.github/workflows/ci.yml` 执行 `npm ci → typecheck → test`，**不需要任何 Secret 即可通过**。

---

## 故障排查

| 现象 | 原因与处理 |
|---|---|
| `wrangler deploy` 报 `Couldn't find a D1 DB with the name/id` | `wrangler.prod.jsonc` 里的 `database_id` 与账号里的库不匹配。`npx wrangler d1 list` 核对 |
| 部署成功但域名 522 / 1016 | 自定义域名不在该 Cloudflare 账号下，或 `routes.pattern` 写错（不要带 `https://`） |
| 页面白屏、`/api/config` 404 | assets 目录没构建（`dist/` 不存在）或 `directory` 路径不对；先在前端仓库 `npm run build` |
| 接口 401 / 一登录就掉 | `JWT_ISSUER` 与实际访问域名不一致；或换了 `JWT_SIGNING_KEYS` 后旧 Token 全部失效（正常，重新登录） |
| 浏览器报 CORS 错误 | 分离部署时没配 `ALLOWED_ORIGINS`（精确写前端 origin，含协议，不带尾斜杠） |
| 注册提示「人机校验失败」 | 配了 `TURNSTILE_SITE_KEY` 但没设 `TURNSTILE_SECRET_KEY`，或域名未加入 Turnstile widget 允许域名。本地开发用 `TURNSTILE_DISABLED=true` |
| 收不到验证/重置邮件 | 未配置 Resend：后台「服务配置 → 邮件」填 API Key 与已验签域名的发件人，或设 Secret `RESEND_API_KEY`。未配置时**静默跳过**，可由管理员手动激活用户 |
| 发帖 403 `EMAIL_NOT_VERIFIED` | 账号未验证邮箱。管理员可在「用户」页手动标记已验证，或在站点设置里关闭「注册需要邮箱」 |
| 图片 404 | R2 桶名与 `UPLOADS` 绑定不一致；或用了 S3 模式但 `public_base_url` 未配（此时应走 `/api/files/*` 代理） |
| `migrations apply` 报 `table already exists` | 本地已有旧数据。清 `.wrangler/state` 重来，或对生产改用备份恢复流程 |
| 首个注册账号不是管理员 | 数据库里已有用户。用 CLI 提权，或清空用户表后重新注册 |

---

## 功能状态（哪些要额外配置）

| 功能 | 状态 | 需要什么 |
|---|---|---|
| 论坛核心（板块/帖子/回复/楼中楼/点赞/收藏/搜索/通知/举报/管理后台） | ✅ 开箱可用 | 无 |
| 邮箱验证 + 忘记密码邮件 | ✅ 代码完整 | Resend（Secret 或后台配置）；未配置时静默跳过 |
| Turnstile 人机验证 | ✅ 代码完整 | Turnstile widget（站点密钥 + 服务端密钥） |
| GitHub OAuth 登录 | ✅ 代码完整 | 在 GitHub 创建 OAuth App，后台填 client id/secret |
| S3 兼容存储（头像/背景/文章/评论图片） | ✅ 代码完整 | S3 凭据 + 站点设置里把存储切到 s3 |
| 第三方站点登录状态同步（SSO） | ✅ 代码完整 | 后台「SSO 同步」里加白名单站点 |
| Android 客户端 | ✅ 独立仓库 | 改 `app/build.gradle.kts` 的两个地址后自行构建 |
| OAuth 2.0 / OIDC 身份提供方（`/oauth/*`） | ⚠️ **未实现**（返回 501） | 表结构与发现端点已就绪，属后续规划 |
| 邮件退信 / 送达统计 | ⚠️ 未实现 | 仅基础发送 |
| 中文分词全文检索 | ⚠️ 部分 | FTS5 trigram（≥3 字符），短词回退 LIKE |

---

## 认证与安全设计

### 密钥管理

```bash
# 本地开发（写入 .dev.vars，已 gitignore）
node scripts/generate-jwt-keys.mjs

# 生产（管道写入 Secret，私钥不落盘）
node scripts/generate-jwt-keys.mjs --print | npx wrangler secret put JWT_SIGNING_KEYS -c wrangler.prod.jsonc
```

- 格式：`[{ "kid": "202610-ab12", "jwk": { ...RS256 私钥 JWK... }, "active": true }]`
- **轮换**：生成新密钥 → 数组里加新条目（新 `active:true`，旧条目 `active:false`）→ 更新 Secret。
  旧公钥保留在 JWKS 中，旧 Token 仍可验证，等旧 Token 全部过期后再删旧条目。
- `/.well-known/jwks.json` 公开验证公钥（仅 `n/e/kty/alg/kid/use`，绝不含私钥）。

### Token 模型

- Access Token：JWT / RS256，默认 30 分钟，Header 带 `kid`；服务端逐项校验 签名 → iss → aud → exp → iat → typ → 用户状态 → 权限
- Refresh Token：32 字节高熵随机，数据库只存 SHA-256 哈希，30 天；**轮换 + Replay 检测**（已轮换的 Token 再次出现 → 撤销整条链）
- 登出 / 登出全部设备 / 封禁 / 改密 → 立即失效对应 Token

### 安全措施

| 威胁 | 防护 |
|---|---|
| XSS | Markdown 不引入 `rehype-raw`；`rehype-sanitize` 白名单；链接仅 `http/https/mailto`；SEO 渲染页统一 HTML 转义 |
| SQL 注入 | 全部参数化查询（prepared statements），LIKE 通配符转义 |
| CSRF | API 全部 `Authorization: Bearer`，不用 Cookie |
| JWT 攻击 | 固定 RS256（拒绝 `none`/算法混淆）、校验 kid/iss/aud/exp/iat/typ、私钥只存 Secret |
| 暴力破解 | KV 限流（登录 10 次/10 分钟、注册 5 次/小时），按 IP+UA 指纹 |
| 用户枚举 | 登录/注册统一错误文案，失败也执行哈希校验均衡时序 |
| IDOR/越权 | 写操作校验资源归属；RBAC（user < moderator < admin）；封禁状态每请求实时校验 |
| 恶意上传 | ≤5MB、MIME 白名单、**魔数字节校验**（拒绝伪装的脚本/HTML/可执行文件） |
| 刷浏览量 | KV 按「访客×帖子」去重（1 小时窗口） |
| Bot | Cloudflare Turnstile（服务端 siteverify） |

密码：PBKDF2-HMAC-SHA256（WebCrypto 原生，`PASSWORD_ITERATIONS` 可调），格式 `pbkdf2$sha256$<iter>$<salt>$<hash>`。

### 密钥泄漏自查

```bash
# 检查仓库历史是否出现私钥 / 常见密钥格式
git log --all -p | grep -nE "BEGIN .*PRIVATE KEY|re_[A-Za-z0-9]{20,}|X-Auth-Key" | head
```

本项目历史已自查无真实密钥入库；`.gitignore` 覆盖 `.dev.vars` / `.env*` / `*.pem` / `*.key` / 生成的 `wrangler.prod.jsonc`。
**如果你误提交了密钥**：立刻在 Cloudflare 轮换（重新 `secret put`、换 Resend Key、换 Turnstile 密钥），再清理 git 历史。

---

## 目录结构

```
starlr-forum-backend/
├── src/
│   ├── index.ts          # Hono 装配：CORS、安全头、路由挂载、SPA/404 兜底
│   ├── index-f.ts        # 纯前端 Worker 入口（分离部署时的静态站，零数据绑定）
│   ├── types.ts          # 绑定与环境变量类型
│   ├── config/           # defaults.json（全部默认值）+ 说明
│   ├── routes/           # REST API（auth/posts/replies/users/upload/admin/oauth/seo/...）
│   ├── middleware/       # 认证与权限
│   └── lib/              # JWT/密码/限流/Turnstile/邮件/审计/通知/SEO/站点配置
├── migrations/           # D1 迁移（序号递增）
├── test/                 # vitest + workers pool
├── scripts/
│   ├── setup.mjs              # 一键创建资源 + 生成 wrangler.prod.jsonc
│   └── generate-jwt-keys.mjs  # RS256 密钥生成/轮换
├── .dev.vars.example          # 本地开发环境变量模板
├── wrangler.example.jsonc     # 单 Worker 同域部署模板
├── wrangler.api.example.jsonc # 纯 API（分离部署）模板
└── wrangler.jsonc             # 本地 dev 配置（作者开发用，自部署可忽略）
```

> `wrangler.x.jsonc` / `wrangler.backend.jsonc` / `wrangler.frontend.jsonc` 是**作者自己**的多域名生产配置，
> 保留仅供参照；自部署请用 `npm run setup` 生成的 `wrangler.prod.jsonc` / `wrangler.api.jsonc`。

---

## 许可

本项目基于 [GPL-3.0-or-later](./LICENSE) 开源。

- 可自由使用、学习、修改、分发；
- 二次开发作品必须同样以 GPL-3.0 开源并保留原始版权声明；
- 按「现状」提供，不附带任何担保；
- 版权所有 © 2026 wwwaaa123122。

第三方依赖均为 MIT / Apache-2.0 / ISC 等宽松许可（Hono、Zod、TypeScript、Vitest、Wrangler），与 GPL-3.0 兼容；
仓库内不含第三方版权素材（图标为项目自绘，字体走系统字体栈）。
