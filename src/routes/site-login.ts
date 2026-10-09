/**
 * /api/auth/site-login/* — 第三方站点登录状态同步（一次性 ticket）
 *
 * 背景：论坛登录态存在各站点自己的 localStorage（按源隔离），第三方站点无法直接读取；
 * 而现代浏览器对第三方 iframe 的存储做了分区，iframe 也读不到。因此采用「重定向 + 一次性 ticket」：
 *
 *   1) 第三方站点（如 zako.mom）生成随机 challenge，跳转
 *      {论坛前端}/sso-bridge?redirect=<回跳地址>&challenge=<challenge>
 *   2) 桥接页（论坛源，第一方上下文）读出本域登录态后，调本端点签发 ticket：
 *      POST /api/auth/site-login/issue  {origin, challenge}   ← 需登录（Bearer）
 *   3) 桥接页 302 回  <回跳地址>#sso_ticket=<ticket>&sso_challenge=<challenge>
 *   4) 第三方站点把 ticket 交给自己的后端，后端服务器对服务器调本端点兑换：
 *      POST /api/auth/site-login/redeem {ticket, challenge, origin}
 *      → 由**发起兑换的 Worker 自己签发** JWT（x 站拿 x 的 key，i 站拿 i 的 key）
 *
 * 安全设计：
 *  - ticket 高熵随机、仅存哈希、单次使用（兑换即删）、TTL 120s；
 *  - 绑定 origin（仅白名单站点可被签发）+ challenge（第三方生成并校验）；
 *  - URL 中只出现 ticket（一次性、短命），不出现任何长期凭证；
 *  - 凭证只经服务器间 HTTPS 流转，浏览器里不留 refresh token。
 */
import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { parseJson } from '../lib/validate';
import { errors, ok } from '../lib/http';
import { z } from 'zod';
import { issueTokens } from '../lib/tokens';
import { randomToken, sha256Hex, nowIso } from '../lib/ids';
import { sessionInfoFrom } from '../lib/session-info';
import { requireAuth } from '../middleware/auth';
import { writeAuditLog } from '../lib/audit';
import { publicUser } from './auth';

const TICKET_TTL = 120;

/** 允许发起登录同步的站点（逗号分隔的 var；未配置时的兜底与桥接页白名单一致） */
const DEFAULT_ORIGINS = [
  'https://zako.mom',
  'http://127.0.0.1:8788',
  'http://localhost:8788',
];

function allowedOrigins(env: AppEnv['Bindings']): Set<string> {
  const raw = (env.SSO_ALLOWED_ORIGINS ?? '').trim();
  const list = raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_ORIGINS;
  return new Set(list.map((o) => o.replace(/\/+$/, '')));
}

function normalizeOrigin(value: string | undefined): string {
  return (value ?? '').trim().replace(/\/+$/, '');
}

const issueSchema = z.object({
  origin: z.string().trim().min(1, '缺少来源站点'),
  challenge: z.string().trim().min(8, '缺少 challenge').max(200),
});

const redeemSchema = z.object({
  ticket: z.string().trim().min(16, '缺少 ticket').max(200),
  challenge: z.string().trim().min(8, '缺少 challenge').max(200),
  origin: z.string().trim().min(1, '缺少来源站点').max(200),
});

const app = new Hono<AppEnv>();

/** POST /issue — 桥接页用当前登录态签发一次性 ticket（需登录） */
app.post('/issue', requireAuth, async (c) => {
  const body = await parseJson(c, issueSchema);
  const origin = normalizeOrigin(body.origin);
  if (!allowedOrigins(c.env).has(origin)) {
    throw errors.forbidden('该站点未被允许同步论坛登录状态', 'SSO_ORIGIN_NOT_ALLOWED');
  }

  const userId = c.get('user')!.id;
  const ticket = randomToken(24);
  await c.env.CACHE.put(
    `sso:site:ticket:${await sha256Hex(ticket)}`,
    JSON.stringify({ userId, origin, challenge: body.challenge }),
    { expirationTtl: TICKET_TTL },
  );

  return ok(c, { ticket, expiresIn: TICKET_TTL });
});

/** POST /redeem — 第三方站点后端用 ticket 兑换 token（ticket 即凭证，单次使用） */
app.post('/redeem', async (c) => {
  const body = await parseJson(c, redeemSchema);
  const origin = normalizeOrigin(body.origin);

  const key = `sso:site:ticket:${await sha256Hex(body.ticket)}`;
  const raw = await c.env.CACHE.get(key);
  if (!raw) throw errors.badRequest('登录同步凭证无效或已过期，请重试', 'SSO_TICKET_INVALID');
  await c.env.CACHE.delete(key); // 单次使用：先删再校验，避免重放

  const data = JSON.parse(raw) as { userId: string; origin: string; challenge: string };
  if (data.origin !== origin || data.challenge !== body.challenge) {
    throw errors.badRequest('登录同步凭证校验失败，请重试', 'SSO_TICKET_MISMATCH');
  }

  const row = await c.env.DB.prepare(
    `SELECT id, uid, username, username_raw, nickname, email, role, status, avatar_url, bio, post_count, reply_count,
            created_at, email_verified, likes_public, background_url, github_id
     FROM users WHERE id = ?`,
  )
    .bind(data.userId)
    .first<{
      id: string; uid: number; username: string; username_raw: string; nickname: string; email: string;
      role: string; status: string; avatar_url: string | null; bio: string | null; post_count: number;
      reply_count: number; created_at: string; email_verified: number; likes_public: number;
      background_url: string | null; github_id: string | null;
    }>();
  if (!row) throw errors.badRequest('账号不存在', 'SSO_USER_MISSING');
  if (row.status !== 'active') throw errors.forbidden('该账号已被封禁', 'ACCOUNT_BANNED');

  const tokens = await issueTokens(c.env, { id: row.id, role: row.role as 'user' | 'moderator' | 'admin' }, sessionInfoFrom(c));
  await c.env.DB.prepare(`UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?`).bind(nowIso(), nowIso(), row.id).run();
  await writeAuditLog(c, { action: 'user.site_login', actorId: row.id, targetType: 'user', targetId: row.id, detail: `origin:${origin}` });

  return ok(c, {
    user: { ...publicUser(row), email: row.email },
    ...tokens,
    tokenType: 'Bearer',
  });
});

export default app;
