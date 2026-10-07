# AGENTS.md — backend（共享后端源码）

Hono + Cloudflare Workers + TypeScript 后端。**一套源码，四个部署目标**——先看部署矩阵再动 `wrangler*.jsonc`。

## 部署矩阵

| 配置文件 | Worker | 用途 | 部署命令 |
|---|---|---|---|
| `wrangler.jsonc` | （无 name routes） | **仅 `wrangler dev` 本地开发**，assets 指 `../frontend/dist` | `npx wrangler dev` |
| `wrangler.x.jsonc` | `xingchen-forum-x` | x.182030.xyz + forum.182030.xyz：frontend-x 静态资源 + 同源 API | `npx wrangler deploy -c wrangler.x.jsonc` |
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
