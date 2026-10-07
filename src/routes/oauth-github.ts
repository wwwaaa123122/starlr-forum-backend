/**
 * /oauth/github/* — GitHub OAuth 登录（消费端）
 *
 * 设计要点：
 *  - 凭据存 KV：`config:oauth:github` = { client_id, client_secret, callback_origin? }
 *    （不入 wrangler vars/secret，改配置无需重新部署；callback_origin 固定指向
 *      承载 GitHub OAuth App 回调的 Worker，默认 https://i.182030.xyz）
 *  - 单一 GitHub OAuth App 同时服务两个前端：
 *      1) 前端按钮 → {API_BASE}/oauth/github/start?redirect=<前端 origin>
 *      2) GitHub 回调 → callback_origin（i.182030.xyz）/oauth/github/callback
 *         建/联用户后生成一次性 code 存共享 KV（TTL 600s）
 *      3) 302 回 前端 /oauth/github/done?code=...，前端用 code 调
 *         POST /api/auth/oauth/exchange（本文件，挂载在 /api/auth/oauth）
 *         —— 由**发起请求的 Worker 自己签发** JWT（x 站拿 x 的 key，f 站拿 i 的 key），
 *         各前端 token 与其 API 域名严格匹配
 *  - 账号关联优先级：github_id 精确匹配 → 已验证邮箱匹配（自动绑定）→ 新建用户
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppEnv } from '../types';
import { errors, ok } from '../lib/http';
import { issueTokens } from '../lib/tokens';
import { newId, randomToken, nowIso } from '../lib/ids';
import { sessionInfoFrom } from '../lib/session-info';
import { clientFingerprint, consumeRateLimit, RATE_LIMITS } from '../lib/rate-limit';
import { writeAuditLog } from '../lib/audit';
import { hashPassword } from '../lib/password';

/** 登录会话信息：UA + Cloudflare IP 库（与 auth.ts 同款） */
function deviceInfoFrom(c: Context<AppEnv>): string {
  return sessionInfoFrom(c);
}

const CONFIG_KEY = 'config:oauth:github';
const STATE_TTL = 600;
const CODE_TTL = 600;

/** 前端 origin 白名单（state 回跳校验） */
const REDIRECT_ALLOWLIST = new Set([
  'https://x.182030.xyz',
  'https://forum.182030.xyz',
  'https://f.182030.xyz',
  // 本地开发
  'http://localhost:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
]);

interface GithubConfig {
  client_id: string;
  client_secret: string;
  callback_origin?: string;
}

interface GithubUser {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string;
  email: string | null;
}

const app = new Hono<AppEnv>();

/** 浏览器可见的极简结果页（回调发生在浏览器，不能返回 JSON） */
function page(c: Context<AppEnv>, title: string, message: string, status = 200) {
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<body style="font-family:system-ui,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;background:#0b0e14;color:#e7e9ee;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0">
<div style="text-align:center;padding:32px">
<div style="font-size:40px;margin-bottom:12px">${status < 400 ? '✅' : '⚠️'}</div>
<h1 style="font-size:20px;margin:0 0 8px">${title}</h1>
<p style="opacity:.72;margin:0;font-size:14px;max-width:420px;line-height:1.6">${message}</p>
</div></body>`;
  return c.body(html, status as ContentfulStatusCode, { 'Content-Type': 'text/html; charset=utf-8' });
}

async function getConfig(env: AppEnv['Bindings']): Promise<GithubConfig | null> {
  const raw = await env.CACHE.get(CONFIG_KEY);
  if (!raw) return null;
  try {
    const cfg = JSON.parse(raw) as GithubConfig;
    if (cfg.client_id && cfg.client_secret) return cfg;
  } catch { /* 配置损坏视同未配置 */ }
  return null;
}

function callbackOrigin(env: AppEnv['Bindings'], cfg: GithubConfig): string {
  return (cfg.callback_origin ?? 'https://i.182030.xyz').replace(/\/+$/, '');
}

function safeRedirect(origin: string | undefined, env: AppEnv['Bindings']): string {
  if (origin && REDIRECT_ALLOWLIST.has(origin.replace(/\/+$/, ''))) return origin.replace(/\/+$/, '');
  return new URL(env.SITE_URL).origin; // 兜底：回站点首页
}

app.get('/github/start', async (c) => {
  const cfg = await getConfig(c.env);
  if (!cfg) return page(c, 'GitHub 登录未配置', '管理员尚未完成 GitHub OAuth 配置（KV: config:oauth:github）。', 503);

  const redirect = safeRedirect(c.req.query('redirect'), c.env);
  const state = randomToken(18);
  await c.env.CACHE.put(`oauth:gh:state:${state}`, JSON.stringify({ redirect }), { expirationTtl: STATE_TTL });

  const authorize = new URL('https://github.com/login/oauth/authorize');
  authorize.searchParams.set('client_id', cfg.client_id);
  authorize.searchParams.set('redirect_uri', `${callbackOrigin(c.env, cfg)}/oauth/github/callback`);
  authorize.searchParams.set('scope', 'read:user user:email');
  authorize.searchParams.set('state', state);
  return c.redirect(authorize.toString(), 302);
});

app.get('/github/callback', async (c) => {
  const cfg = await getConfig(c.env);
  if (!cfg) return page(c, 'GitHub 登录未配置', '管理员尚未完成 GitHub OAuth 配置。', 503);

  const qError = c.req.query('error');
  if (qError) {
    return c.redirect(`${new URL(c.env.SITE_URL).origin}/login?oauth=cancelled`, 302);
  }

  const state = c.req.query('state') ?? '';
  const stateRaw = state ? await c.env.CACHE.get(`oauth:gh:state:${state}`) : null;
  if (stateRaw) await c.env.CACHE.delete(`oauth:gh:state:${state}`);
  if (!stateRaw) return page(c, '登录状态已失效', '授权会话已过期或不存在，请回到登录页重新点击「使用 GitHub 登录」。', 400);
  const { redirect } = JSON.parse(stateRaw) as { redirect: string };

  const ghCode = c.req.query('code') ?? '';
  if (!ghCode) return page(c, '授权失败', 'GitHub 未返回授权码，请重试。', 400);

  // 1) code 换 access token
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: cfg.client_id,
      client_secret: cfg.client_secret,
      code: ghCode,
      redirect_uri: `${callbackOrigin(c.env, cfg)}/oauth/github/callback`,
    }),
  });
  const tokenBody = (await tokenRes.json().catch(() => ({}))) as { access_token?: string; error_description?: string };
  if (!tokenBody.access_token) {
    return page(c, '授权失败', tokenBody.error_description ?? 'GitHub 授权码换取失败，请重试。', 400);
  }
  const ghHeaders = {
    Authorization: `Bearer ${tokenBody.access_token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'starlr-forum',
  };

  // 2) 拉取 GitHub 用户与主邮箱
  const ghUser = (await (await fetch('https://api.github.com/user', { headers: ghHeaders })).json()) as GithubUser;
  if (!ghUser?.id) return page(c, '授权失败', '无法读取 GitHub 账号信息，请重试。', 400);
  const emailsRes = await fetch('https://api.github.com/user/emails', { headers: ghHeaders });
  let verifiedEmail: string | null = null;
  if (emailsRes.ok) {
    const emails = (await emailsRes.json().catch(() => [])) as { email: string; primary: boolean; verified: boolean }[];
    verifiedEmail = emails.find((e) => e.primary && e.verified)?.email ?? emails.find((e) => e.verified)?.email ?? null;
  }

  // 3) 找到 / 建立论坛账号
  const db = c.env.DB;
  let row = await db
    .prepare(`SELECT id, uid, username_raw, nickname, role, status, email, email_verified FROM users WHERE github_id = ? LIMIT 1`)
    .bind(String(ghUser.id))
    .first<{ id: string; uid: number; username_raw: string; nickname: string; role: string; status: string; email: string; email_verified: number }>();

  if (!row && verifiedEmail) {
    row = await db
      .prepare(`SELECT id, uid, username_raw, nickname, role, status, email, email_verified FROM users WHERE email = ? LIMIT 1`)
      .bind(verifiedEmail.toLowerCase())
      .first();
    if (row) {
      await db.prepare(`UPDATE users SET github_id = ?, email_verified = MAX(email_verified, 1), updated_at = ? WHERE id = ?`)
        .bind(String(ghUser.id), nowIso(), row.id).run();
      await writeAuditLog(c, { action: 'user.oauth_link', actorId: row.id, targetType: 'user', targetId: row.id, detail: 'github' });
    }
  }

  if (row && row.status !== 'active') {
    return page(c, '账号不可用', '该账号已被封禁，无法登录。如有疑问请联系管理员。', 403);
  }

  if (!row) {
    // ---- 新建用户 ----
    const base = (ghUser.login || `gh${ghUser.id}`).toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 20) || `gh${ghUser.id}`;
    let username = base;
    for (let i = 2; i <= 50; i++) {
      const hit = await db.prepare(`SELECT 1 FROM users WHERE username = ? LIMIT 1`).bind(username).first();
      if (!hit) break;
      username = `${base}-${i}`;
    }
    const nicknameBase = (ghUser.name || ghUser.login || username).trim().slice(0, 24) || username;
    let nickname = nicknameBase;
    for (let i = 2; i <= 50; i++) {
      const hit = await db.prepare(`SELECT 1 FROM users WHERE nickname = ? LIMIT 1`).bind(nickname).first();
      if (!hit) break;
      nickname = `${nicknameBase}-${i}`;
    }
    let email = verifiedEmail ?? `${ghUser.login}@users.noreply.github.com`.toLowerCase();
    const emailTaken = await db.prepare(`SELECT 1 FROM users WHERE email = ? LIMIT 1`).bind(email).first();
    if (emailTaken) email = `${ghUser.id}@users.noreply.github.com`;

    const userId = newId(16);
    // UID：与注册一致，counters 原子自增
    const uidRow = await db.prepare(`UPDATE counters SET value = value + 1 WHERE name = 'user_uid' RETURNING value`)
      .first<{ value: number }>();
    let uid: number;
    if (uidRow?.value) {
      uid = uidRow.value;
    } else {
      const maxRow = await db.prepare(`SELECT COALESCE(MAX(uid), 0) + 1 AS next FROM users`).first<{ next: number }>();
      uid = maxRow?.next ?? 1;
      await db.prepare(`INSERT INTO counters (name, value) VALUES ('user_uid', ?) ON CONFLICT(name) DO UPDATE SET value = ?`)
        .bind(uid, uid).run();
    }

    // 不可用的随机密码（OAuth 用户无法密码登录；邮箱真实时可走找回流程）
    const passwordHash = await hashPassword(randomToken(24), Number.parseInt(c.env.PASSWORD_ITERATIONS ?? '100000', 10) || 100000);

    await db.prepare(
      `INSERT INTO users (id, uid, username, username_raw, email, password_hash, nickname, role, status, email_verified, github_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'user', 'active', ?, ?, ?, ?)`,
    )
      .bind(userId, uid, username, ghUser.login || username, email, passwordHash, nickname, verifiedEmail ? 1 : 0, String(ghUser.id), nowIso(), nowIso())
      .run();

    // 头像：抓取 GitHub 头像入 KV，走 /api/avatars/:uid 通道
    try {
      const avatarRes = await fetch(`${ghUser.avatar_url}${ghUser.avatar_url.includes('?') ? '&' : '?'}size=256`, {
        headers: { 'User-Agent': 'starlr-forum' },
      });
      if (avatarRes.ok) {
        const bytes = new Uint8Array(await avatarRes.arrayBuffer());
        if (bytes.byteLength > 0 && bytes.byteLength <= 2 * 1024 * 1024) {
          await c.env.CACHE.put(`avatar:${uid}`, bytes);
          await db.prepare(`UPDATE users SET avatar_url = ? WHERE id = ?`).bind(`/api/avatars/${uid}?v=${Date.now()}`, userId).run();
        }
      }
    } catch { /* 头像失败不影响登录 */ }

    await writeAuditLog(c, { action: 'user.oauth_register', actorId: userId, targetType: 'user', targetId: userId, detail: 'github' });
    row = { id: userId, uid, username_raw: ghUser.login || username, nickname, role: 'user', status: 'active', email, email_verified: verifiedEmail ? 1 : 0 };
  } else {
    await db.prepare(`UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?`).bind(nowIso(), nowIso(), row.id).run();
    await writeAuditLog(c, { action: 'user.oauth_login', actorId: row.id, targetType: 'user', targetId: row.id, detail: 'github' });
  }

  // 4) 一次性 code 入共享 KV（任意前端 Worker 可兑换）
  const code = randomToken(24);
  await c.env.CACHE.put(`oauth:gh:code:${code}`, JSON.stringify({ userId: row.id }), { expirationTtl: CODE_TTL });
  return c.redirect(`${redirect}/oauth/github/done?code=${encodeURIComponent(code)}`, 302);
});

/** POST /api/auth/oauth/exchange — 前端用一次性 code 换本 Worker 签发的 token */
app.post('/exchange', async (c) => {
  const fingerprint = await clientFingerprint(c);
  const rl = await consumeRateLimit(c.env, RATE_LIMITS.login, fingerprint);
  if (!rl.ok) throw errors.tooMany('操作过于频繁，请稍后再试');

  const body = (await c.req.json().catch(() => ({}))) as { code?: string };
  const code = (body.code ?? '').trim();
  if (!code) throw errors.badRequest('缺少授权码', 'OAUTH_CODE_MISSING');

  const key = `oauth:gh:code:${code}`;
  const raw = await c.env.CACHE.get(key);
  if (!raw) throw errors.badRequest('授权码无效或已过期，请重新登录', 'OAUTH_CODE_INVALID');
  await c.env.CACHE.delete(key);
  const { userId } = JSON.parse(raw) as { userId: string };

  const row = await c.env.DB.prepare(
    `SELECT id, uid, username, username_raw, nickname, email, role, status, avatar_url, bio, post_count, reply_count, created_at, email_verified, likes_public, background_url, github_id
     FROM users WHERE id = ?`,
  )
    .bind(userId)
    .first<{
      id: string; uid: number; username: string; username_raw: string; nickname: string; email: string;
      role: string; status: string; avatar_url: string | null; bio: string | null; post_count: number;
      reply_count: number; created_at: string; email_verified: number; likes_public: number; background_url: string | null; github_id: string | null;
    }>();
  if (!row) throw errors.badRequest('账号不存在', 'OAUTH_USER_MISSING');
  if (row.status !== 'active') throw errors.forbidden('该账号已被封禁', 'ACCOUNT_BANNED');

  const tokens = await issueTokens(c.env, { id: row.id, role: row.role as 'user' | 'moderator' | 'admin' }, deviceInfoFrom(c));
  await writeAuditLog(c, { action: 'user.oauth_exchange', actorId: row.id, targetType: 'user', targetId: row.id, detail: 'github' });

  return ok(c, {
    user: {
      id: row.id,
      uid: row.uid,
      username: row.username,
      username_raw: row.username_raw,
      nickname: row.nickname,
      avatarUrl: row.avatar_url,
      bio: row.bio ?? '',
      role: row.role,
      postCount: row.post_count,
      replyCount: row.reply_count,
      createdAt: row.created_at,
      email: row.email,
      emailVerified: row.email_verified === 1,
      likesPublic: (row.likes_public ?? 0) === 1,
      backgroundUrl: row.background_url ?? null,
      hasGithub: Boolean(row.github_id),
    },
    ...tokens,
    tokenType: 'Bearer',
  });
});

export default app;
