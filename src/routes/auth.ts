/**
 * 认证 API：注册 / 登录 / 刷新 / 登出 / 当前用户
 * 所有写操作均经过：限流 → Turnstile（如启用）→ 参数校验 → 业务 → 审计日志
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv, AuthUser } from '../types';
import { parseJson } from '../lib/validate';
import { errors, ok } from '../lib/http';
import { hashPassword, isStrongEnough, verifyPassword } from '../lib/password';
import { newId, nowIso, sha256Hex } from '../lib/ids';
import { issueTokens, revokeTokenChain, rotateRefreshToken, revokeAllUserTokens } from '../lib/tokens';
import { RATE_LIMITS, clientFingerprint, consumeRateLimit } from '../lib/rate-limit';
import { verifyTurnstile } from '../lib/turnstile';
import { requireAuth } from '../middleware/auth';
import { writeAuditLog } from '../lib/audit';

const app = new Hono<AppEnv>();

const usernameSchema = z
  .string()
  .trim()
  .min(3, '用户名至少 3 个字符')
  .max(24, '用户名最多 24 个字符')
  .regex(/^[\p{L}\p{N}_-]+$/u, '用户名只能包含中文、字母、数字、下划线和短横线');

const passwordSchema = z.string().min(8, '密码至少 8 位').max(128, '密码最多 128 位');
const emailSchema = z.string().trim().toLowerCase().email('邮箱格式不正确').max(254);

const registerSchema = z.object({
  username: usernameSchema,
  email: emailSchema,
  password: passwordSchema,
  nickname: z.string().trim().min(1).max(24).optional(),
  turnstileToken: z.string().optional(),
});

const loginSchema = z.object({
  identifier: z.string().trim().min(1, '请输入用户名或邮箱').max(254),
  password: z.string().min(1, '请输入密码').max(128),
  turnstileToken: z.string().optional(),
});

const refreshSchema = z.object({ refreshToken: z.string().min(10).max(512) });
const logoutSchema = z.object({ refreshToken: z.string().min(10).max(512).optional(), allDevices: z.boolean().optional() });

function deviceInfoFrom(c: { req: { header: (n: string) => string | undefined } }): string {
  const ua = c.req.header('user-agent') ?? '';
  return ua.slice(0, 200);
}

function publicUser(user: Record<string, unknown>) {
  return {
    id: user.id,
    username: user.username_raw ?? user.username,
    nickname: user.nickname,
    avatarUrl: user.avatar_url ?? null,
    bio: user.bio ?? '',
    role: user.role,
    postCount: user.post_count ?? 0,
    replyCount: user.reply_count ?? 0,
    createdAt: user.created_at,
  };
}

/** 防用户名枚举：注册冲突使用统一提示 */
const CONFLICT_MESSAGE = '用户名或邮箱已被使用';

app.post('/register', async (c) => {
  const fingerprint = await clientFingerprint(c);
  const rl = await consumeRateLimit(c.env, RATE_LIMITS.register, fingerprint);
  if (!rl.ok) throw errors.tooMany('注册过于频繁，请稍后再试');

  const body = await parseJson(c, registerSchema);

  const strength = isStrongEnough(body.password);
  if (!strength.ok) throw errors.badRequest(strength.reason ?? '密码强度不足', 'WEAK_PASSWORD');

  const turnstile = await verifyTurnstile(c.env, body.turnstileToken, c.req.header('cf-connecting-ip'));
  if (!turnstile.success) {
    throw errors.badRequest('人机校验失败，请刷新页面重试', 'TURNSTILE_FAILED');
  }

  const usernameLower = body.username.toLowerCase();
  const email = body.email.toLowerCase();

  const existing = await c.env.DB.prepare(
    `SELECT id, username, email FROM users WHERE username = ? OR email = ? LIMIT 1`,
  )
    .bind(usernameLower, email)
    .first<{ id: string; username: string; email: string }>();
  if (existing) throw errors.conflict(CONFLICT_MESSAGE, 'USER_EXISTS');

  const iterations = Number.parseInt(c.env.PASSWORD_ITERATIONS ?? '100000', 10) || 100000;
  const passwordHash = await hashPassword(body.password, iterations);
  const userId = newId(16);
  const nickname = body.nickname?.trim() || body.username;

  try {
    await c.env.DB.prepare(
      `INSERT INTO users (id, username, username_raw, email, password_hash, nickname, role, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'user', 'active', ?, ?)`,
    )
      .bind(userId, usernameLower, body.username, email, passwordHash, nickname, nowIso(), nowIso())
      .run();
  } catch {
    // 并发注册触发唯一约束
    throw errors.conflict(CONFLICT_MESSAGE, 'USER_EXISTS');
  }

  const tokens = await issueTokens(c.env, { id: userId, role: 'user' }, deviceInfoFrom(c));
  await writeAuditLog(c, { action: 'user.register', targetType: 'user', targetId: userId, actorId: userId });

  return ok(
    c,
    {
      user: publicUser({
        id: userId,
        username: usernameLower,
        username_raw: body.username,
        nickname,
        role: 'user',
        post_count: 0,
        reply_count: 0,
        created_at: nowIso(),
      }),
      ...tokens,
      tokenType: 'Bearer',
    },
    { status: 201 },
  );
});

app.post('/login', async (c) => {
  const fingerprint = await clientFingerprint(c);
  const rl = await consumeRateLimit(c.env, RATE_LIMITS.login, fingerprint);
  if (!rl.ok) throw errors.tooMany('登录尝试过于频繁，请稍后再试');

  const body = await parseJson(c, loginSchema);
  const identifier = body.identifier.toLowerCase();

  // 针对单账号的分布式暴力破解防护
  const accountRl = await consumeRateLimit(c.env, { bucket: `login:${identifier}`, limit: 10, window: 600 }, fingerprint);
  if (!accountRl.ok) throw errors.tooMany('该账号尝试次数过多，请稍后再试');

  const turnstile = await verifyTurnstile(c.env, body.turnstileToken, c.req.header('cf-connecting-ip'));
  if (!turnstile.success) {
    throw errors.badRequest('人机校验失败，请刷新页面重试', 'TURNSTILE_FAILED');
  }

  const user = await c.env.DB.prepare(
    `SELECT id, username, username_raw, email, password_hash, nickname, avatar_url, bio, role, status,
            post_count, reply_count, created_at
     FROM users WHERE username = ? OR email = ? LIMIT 1`,
  )
    .bind(identifier, identifier)
    .first<Record<string, unknown> & { password_hash: string; status: string }>();

  // 统一错误信息，避免用户名枚举；无用户时仍执行一次哈希校验以均衡时序
  if (!user) {
    await verifyPassword(body.password, 'pbkdf2$sha256$100000$AAAA$AAAA');
    throw errors.unauthorized('用户名或密码错误', 'INVALID_CREDENTIALS');
  }
  const passwordOk = await verifyPassword(body.password, user.password_hash);
  if (!passwordOk) throw errors.unauthorized('用户名或密码错误', 'INVALID_CREDENTIALS');

  if (user.status === 'banned') {
    const ban = await c.env.DB.prepare(
      `SELECT reason, expires_at FROM bans WHERE user_id = ? AND type = 'ban' AND lifted_at IS NULL
       AND (expires_at IS NULL OR expires_at > datetime('now')) ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(user.id as string)
      .first<{ reason: string; expires_at: string | null }>();
    throw errors.forbidden(
      ban
        ? `账号已被封禁${ban.expires_at ? `至 ${ban.expires_at}` : ''}（原因：${ban.reason}）`
        : '账号已被封禁',
      'ACCOUNT_BANNED',
    );
  }

  await c.env.DB.prepare(`UPDATE users SET last_login_at = ? WHERE id = ?`).bind(nowIso(), user.id as string).run();

  const tokens = await issueTokens(
    c.env,
    { id: user.id as string, role: user.role as AuthUser['role'] },
    deviceInfoFrom(c),
  );
  await writeAuditLog(c, { action: 'user.login', targetType: 'user', targetId: user.id as string, actorId: user.id as string });

  return ok(c, { user: publicUser(user), ...tokens, tokenType: 'Bearer' });
});

app.post('/refresh', async (c) => {
  const fingerprint = await clientFingerprint(c);
  const rl = await consumeRateLimit(c.env, RATE_LIMITS.refresh, fingerprint);
  if (!rl.ok) throw errors.tooMany();

  const body = await parseJson(c, refreshSchema);
  const outcome = await rotateRefreshToken(c.env, body.refreshToken, deviceInfoFrom(c));

  if (!outcome.ok) {
    switch (outcome.reason) {
      case 'replay':
        // 检测到 Refresh Token 重放：整条链已撤销
        return c.json(
          { error: { code: 'TOKEN_REPLAY', message: '检测到令牌重放，已撤销该设备全部登录状态，请重新登录' } },
          401,
        );
      case 'expired':
        throw errors.tokenExpired();
      case 'revoked':
        throw errors.invalidToken('登录状态已失效，请重新登录');
      default:
        throw errors.invalidToken('Refresh Token 无效');
    }
  }

  return ok(c, { ...outcome.newTokens, tokenType: 'Bearer' });
});

app.post('/logout', async (c) => {
  const body = await parseJson(c, logoutSchema);
  if (body.refreshToken) {
    // 通过 Refresh Token 定位整条设备链并撤销（无需 Access Token 也允许登出）
    const tokenHash = await sha256Hex(body.refreshToken);
    const row = await c.env.DB.prepare(
      `SELECT id, user_id, root_id, revoked_at FROM refresh_tokens WHERE token_hash = ?`,
    )
      .bind(tokenHash)
      .first<{ id: string; user_id: string; root_id: string | null; revoked_at: string | null }>();
    if (row) {
      const rootId = row.root_id ?? row.id;
      await revokeTokenChain(c.env, rootId, 'logout');
      await writeAuditLog(c, { action: 'user.logout', targetType: 'user', targetId: row.user_id, actorId: row.user_id });
    }
  }
  return ok(c, { success: true });
});

app.post('/logout-all', requireAuth, async (c) => {
  const user = c.get('user')!;
  await revokeAllUserTokens(c.env, user.id, 'logout_all');
  await writeAuditLog(c, { action: 'user.logout_all', targetType: 'user', targetId: user.id, actorId: user.id });
  return ok(c, { success: true });
});

app.get('/me', requireAuth, async (c) => {
  const user = c.get('user')!;
  const profile = await c.env.DB.prepare(
    `SELECT id, username_raw AS username, nickname, email, avatar_url, bio, role, post_count, reply_count, created_at
     FROM users WHERE id = ?`,
  )
    .bind(user.id)
    .first<Record<string, unknown>>();
  if (!profile) throw errors.notFound('用户不存在');
  return ok(c, { user: { ...publicUser(profile), email: profile.email } });
});

export default app;
