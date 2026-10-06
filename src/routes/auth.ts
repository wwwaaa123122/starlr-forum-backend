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
import { sessionInfoFrom } from '../lib/session-info';
import { requireAuth } from '../middleware/auth';
import { writeAuditLog } from '../lib/audit';
import { sendVerificationEmail, createEmailVerificationToken, consumeEmailVerificationToken, consumePasswordResetToken, createPasswordResetToken, sendEmail } from '../lib/mail';

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

/** 登录/刷新时的会话信息：UA + Cloudflare IP 库（IP/国家/城市/ASN/边缘节点） */
function deviceInfoFrom(c: Parameters<typeof sessionInfoFrom>[0]): string {
  return sessionInfoFrom(c);
}

function publicUser(user: Record<string, unknown>) {
  return {
    id: user.id,
    uid: user.uid ?? null,
    username: user.username_raw ?? user.username,
    nickname: user.nickname,
    avatarUrl: user.avatar_url ?? null,
    bio: user.bio ?? '',
    role: user.role,
    postCount: user.post_count ?? 0,
    replyCount: user.reply_count ?? 0,
    createdAt: user.created_at,
    emailVerified: (user.email_verified ?? 1) === 1,
    /** 账号状态：banned（封禁）> unverified（未验证邮箱）> active（正常） */
    accountStatus:
      user.status === 'banned' ? 'banned' : (user.email_verified ?? 1) === 1 ? 'active' : 'unverified',
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

  // UID：从 1 开始自增（counters 表原子分配）
  let uid: number | null = null;
  const uidRow = await c.env.DB.prepare(`UPDATE counters SET value = value + 1 WHERE name = 'user_uid' RETURNING value`)
    .first<{ value: number }>();
  if (uidRow?.value) {
    uid = uidRow.value;
  } else {
    const maxRow = await c.env.DB.prepare(`SELECT COALESCE(MAX(uid), 0) + 1 AS next FROM users`).first<{ next: number }>();
    uid = maxRow?.next ?? 1;
    await c.env.DB.prepare(`INSERT INTO counters (name, value) VALUES ('user_uid', ?) ON CONFLICT(name) DO UPDATE SET value = ?`)
      .bind(uid, uid)
      .run();
  }

  try {
    await c.env.DB.prepare(
      `INSERT INTO users (id, uid, username, username_raw, email, password_hash, nickname, role, status, email_verified, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'user', 'active', 0, ?, ?)`,
    )
      .bind(userId, uid, usernameLower, body.username, email, passwordHash, nickname, nowIso(), nowIso())
      .run();
  } catch {
    // 并发注册触发唯一约束
    throw errors.conflict(CONFLICT_MESSAGE, 'USER_EXISTS');
  }

  // 激活邮件（失败不影响注册；用户可在设置页重新发送）
  const verifyToken = await createEmailVerificationToken(c.env, userId);
  await sendVerificationEmail(c.env, email, nickname, verifyToken);

  const tokens = await issueTokens(c.env, { id: userId, role: 'user' }, deviceInfoFrom(c));
  await writeAuditLog(c, { action: 'user.register', targetType: 'user', targetId: userId, actorId: userId });

  return ok(
    c,
    {
      user: publicUser({
        id: userId,
        uid,
        username: usernameLower,
        username_raw: body.username,
        nickname,
        role: 'user',
        post_count: 0,
        reply_count: 0,
        created_at: nowIso(),
        email_verified: 0,
        status: 'active',
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

const forgotSchema = z.object({ email: emailSchema });
const resetSchema = z.object({
  token: z.string().min(20).max(200),
  password: passwordSchema,
});

/** 忘记密码：发送重置邮件；始终返回成功以防邮箱枚举 */
/** 激活账号：一次性令牌 */
app.post('/verify-email', async (c) => {
  const rl = await consumeRateLimit(c.env, { bucket: 'verify-email', limit: 10, window: 3600 }, await clientFingerprint(c));
  if (!rl.ok) throw errors.tooMany('操作过于频繁，请稍后再试');
  const { token } = await parseJson(c, z.object({ token: z.string().trim().min(10).max(200) }));
  const userId = await consumeEmailVerificationToken(c.env, token);
  if (!userId) throw errors.badRequest('链接无效或已过期，请登录后重新获取验证邮件', 'INVALID_TOKEN');
  await c.env.DB.prepare(`UPDATE users SET email_verified = 1, updated_at = ? WHERE id = ?`)
    .bind(nowIso(), userId)
    .run();
  await writeAuditLog(c, { action: 'user.email_verified', targetType: 'user', targetId: userId, actorId: userId });
  return ok(c, { verified: true });
});

/** 重新发送验证邮件（需登录） */
app.post('/resend-verification', requireAuth, async (c) => {
  const user = c.get('user')!;
  // 双重限流：① 真正的 60 秒冷却（TTL 键，从本次发送时刻起算）
  //           ② 每小时 3 次总量上限（固定窗口计数）
  const nowSec = Math.floor(Date.now() / 1000);
  const cooldownKey = `rv-cd:${user.id}`;
  const lastSentAt = await c.env.CACHE.get(cooldownKey);
  if (lastSentAt) {
    const elapsed = nowSec - (Number.parseInt(lastSentAt, 10) || nowSec);
    throw errors.tooMany(`发送过于频繁，请 ${Math.max(1, 60 - elapsed)} 秒后再试`);
  }
  const rl = await consumeRateLimit(c.env, RATE_LIMITS.resendVerify, user.id);
  if (!rl.ok) {
    throw errors.tooMany(`发送次数已达上限（每小时 3 封），请 ${rl.resetSeconds} 秒后再试`);
  }
  const row = await c.env.DB.prepare(`SELECT email, nickname, email_verified FROM users WHERE id = ?`)
    .bind(user.id)
    .first<{ email: string; nickname: string; email_verified: number }>();
  if (!row) throw errors.notFound();
  if (row.email_verified === 1) return ok(c, { sent: false, alreadyVerified: true });
  const token = await createEmailVerificationToken(c.env, user.id);
  await sendVerificationEmail(c.env, row.email, row.nickname, token);
  await c.env.CACHE.put(cooldownKey, String(nowSec), { expirationTtl: 60 });
  await writeAuditLog(c, { action: 'user.resend_verification', targetType: 'user', targetId: user.id, actorId: user.id });
  return ok(c, { sent: true, remaining: rl.remaining, cooldown: 60 });
});

app.post('/forgot-password', async (c) => {
  const fingerprint = await clientFingerprint(c);
  const rl = await consumeRateLimit(c.env, { bucket: 'forgot', limit: 5, window: 3600 }, fingerprint);
  if (!rl.ok) return ok(c, { success: true }); // 限流时也返回统一响应

  const body = await parseJson(c, forgotSchema);
  const user = await c.env.DB.prepare(`SELECT id, email, nickname, status FROM users WHERE email = ? LIMIT 1`)
    .bind(body.email.toLowerCase())
    .first<{ id: string; email: string; nickname: string; status: string }>();

  if (user && user.status === 'active') {
    const token = await createPasswordResetToken(c.env, user.id);
    const resetUrl = `${c.env.SITE_URL}/reset-password?token=${token}`;
    await sendEmail(
      c.env,
      user.email,
      '重置你的密码',
      `<p>你好，<strong>${escapeHtml(user.nickname)}</strong>：</p>
       <p>我们收到了重置你账号密码的请求。点击下面的链接设置新密码（30 分钟内有效）：</p>
       <p><a href="${resetUrl}">${resetUrl}</a></p>
       <p>如果这不是你的操作，请忽略此邮件，你的密码不会改变。</p>`,
    );
    await writeAuditLog(c, { action: 'user.forgot_password', targetType: 'user', targetId: user.id, actorId: user.id });
  }
  return ok(c, { success: true });
});

/** 重置密码：消费一次性令牌，更新密码并撤销全部登录状态 */
app.post('/reset-password', async (c) => {
  const fingerprint = await clientFingerprint(c);
  const rl = await consumeRateLimit(c.env, { bucket: 'resetpw', limit: 10, window: 3600 }, fingerprint);
  if (!rl.ok) throw errors.tooMany('操作过于频繁，请稍后再试');

  const body = await parseJson(c, resetSchema);
  const strength = isStrongEnough(body.password);
  if (!strength.ok) throw errors.badRequest(strength.reason ?? '密码强度不足', 'WEAK_PASSWORD');

  const userId = await consumePasswordResetToken(c.env, body.token);
  if (!userId) throw errors.badRequest('重置链接无效或已过期，请重新申请', 'RESET_TOKEN_INVALID');

  const user = await c.env.DB.prepare(`SELECT id, role, status FROM users WHERE id = ?`)
    .bind(userId)
    .first<{ id: string; role: AuthUser['role']; status: string }>();
  if (!user || user.status !== 'active') throw errors.badRequest('重置链接无效或已过期，请重新申请', 'RESET_TOKEN_INVALID');

  const iterations = Number.parseInt(c.env.PASSWORD_ITERATIONS ?? '100000', 10) || 100000;
  const passwordHash = await hashPassword(body.password, iterations);
  await c.env.DB.prepare(`UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?`)
    .bind(passwordHash, nowIso(), userId)
    .run();
  await revokeAllUserTokens(c.env, userId, 'password_reset');
  await writeAuditLog(c, { action: 'user.reset_password', targetType: 'user', targetId: userId, actorId: userId });
  return ok(c, { success: true });
});

export default app;

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
