/**
 * /api/auth/app-login/* — 手机应用登录/注册凭据预交接（preauth）
 *
 * 背景：生产启用 Turnstile，原生应用无法渲染验证组件，此前 App 内输入的账号密码会被
 * 整包丢弃、跳系统浏览器后重填一遍。现在改为两段式（密码只输一遍）：
 *
 *   1) POST /prepare  ← App 调用：校验账号密码，通过后签发一次性 preauth
 *      （高熵随机、仅存哈希、单次使用、TTL 300s）。不产生任何会话。
 *   2) App 携带 preauth 跳系统浏览器打开 /app-auth?preauth=…（frontend-x/public/app-auth.html）
 *   3) POST /confirm  ← 桥接页调用：Turnstile 人机验证通过后消费 preauth
 *      → 登录模式签发一次性 ticket（与 site-login/issue 同构，绑定 origin+challenge）
 *      → 注册模式在此步才真正建号（密码哈希在 prepare 阶段已算好，KV 不存明文）
 *      → 页面经 starlr://auth 深链回跳，App 走既有 site-login/redeem 兑换 JWT
 *
 * 安全要点：
 *  - 会话关卡（Turnstile）保留在浏览器内的 confirm，机器人即使拿对密码也拿不到会话；
 *  - prepare 只校验凭据不发会话，暴力破解防护与 /login 同级（IP 限流 + 单账号限流）；
 *  - preauth / ticket 均仅存哈希、单次使用、短 TTL，URL 中不出现任何长期凭证。
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types';
import { parseJson } from '../lib/validate';
import { errors, ok } from '../lib/http';
import { hashPassword, isStrongEnough, verifyPassword } from '../lib/password';
import { newId, randomToken, sha256Hex, nowIso } from '../lib/ids';
import { RATE_LIMITS, clientFingerprint, consumeRateLimit } from '../lib/rate-limit';
import { verifyTurnstile } from '../lib/turnstile';
import { sessionInfoFrom } from '../lib/session-info';
import { writeAuditLog } from '../lib/audit';
import { createEmailVerificationToken, sendVerificationEmail } from '../lib/mail';
import { getSsoAccessConfig, normalizeOrigin, TICKET_TTL } from './site-login';

const app = new Hono<AppEnv>();

/** preauth 有效期：需覆盖「跳浏览器 + 完成一次人机验证点击」，比 ticket 稍长 */
const PREAUTH_TTL = 300;

const PREAUTH_KV_PREFIX = 'sso:app:preauth:';

/** 与 auth.ts 保持一致的用户名/密码/邮箱规则 */
const usernameSchema = z
  .string()
  .trim()
  .min(3, '用户名至少 3 个字符')
  .max(24, '用户名最多 24 个字符')
  .regex(/^[\p{L}\p{N}_-]+$/u, '用户名只能包含中文、字母、数字、下划线和短横线');
const passwordSchema = z.string().min(8, '密码至少 8 位').max(128, '密码最多 128 位');
const emailSchema = z.string().trim().toLowerCase().email('邮箱格式不正确').max(254);
const CONFLICT_MESSAGE = '用户名或邮箱已被使用';

const prepareSchema = z
  .object({
    mode: z.union([z.literal('login'), z.literal('register')]),
    identifier: z.string().trim().max(254).optional(),
    username: usernameSchema.optional(),
    email: emailSchema.optional(),
    nickname: z.string().trim().min(1).max(24).optional(),
    password: passwordSchema,
  })
  .superRefine((v, ctx) => {
    if (v.mode === 'login' && !v.identifier) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['identifier'], message: '请输入用户名或邮箱' });
    }
    if (v.mode === 'register' && (!v.username || !v.email)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['username'], message: '请填写用户名与邮箱' });
    }
  });

const confirmSchema = z.object({
  preauth: z.string().trim().min(16).max(200),
  challenge: z.string().trim().min(8).max(200),
  origin: z.string().trim().min(1).max(200),
  turnstileToken: z.string().optional(),
});

async function putPreauth(
  env: AppEnv['Bindings'],
  payload: Record<string, unknown>,
): Promise<string> {
  const preauth = randomToken(24);
  await env.CACHE.put(`${PREAUTH_KV_PREFIX}${await sha256Hex(preauth)}`, JSON.stringify(payload), {
    expirationTtl: PREAUTH_TTL,
  });
  return preauth;
}

/**
 * POST /prepare — App 校验凭据并换取一次性预授权（无会话、无 Turnstile）
 * 暴力破解防护与 /login 同级：IP 限流（login 桶）+ 单账号限流。
 */
app.post('/prepare', async (c) => {
  const fingerprint = await clientFingerprint(c);
  const rl = await consumeRateLimit(c.env, RATE_LIMITS.login, fingerprint);
  if (!rl.ok) throw errors.tooMany('登录尝试过于频繁，请稍后再试');

  const body = await parseJson(c, prepareSchema);

  if (body.mode === 'login') {
    const identifier = body.identifier!.toLowerCase();
    const accountRl = await consumeRateLimit(c.env, { bucket: `login:${identifier}`, limit: 10, window: 600 }, fingerprint);
    if (!accountRl.ok) throw errors.tooMany('该账号尝试次数过多，请稍后再试');

    const user = await c.env.DB.prepare(
      `SELECT id, username, username_raw, nickname, password_hash, status FROM users WHERE username = ? OR email = ? LIMIT 1`,
    )
      .bind(identifier, identifier)
      .first<{ id: string; username: string; username_raw: string; nickname: string | null; password_hash: string; status: string }>();

    // 统一错误信息避免用户名枚举；无用户时仍执行一次哈希校验以均衡时序（与 /login 一致）
    if (!user) {
      await verifyPassword(body.password, 'pbkdf2$sha256$100000$AAAA$AAAA');
      throw errors.unauthorized('用户名（邮箱）或密码错误', 'INVALID_CREDENTIALS');
    }
    if (!(await verifyPassword(body.password, user.password_hash))) {
      throw errors.unauthorized('用户名（邮箱）或密码错误', 'INVALID_CREDENTIALS');
    }
    if (user.status === 'banned') throw errors.forbidden('账号已被封禁', 'ACCOUNT_BANNED');

    const preauth = await putPreauth(c.env, {
      mode: 'login',
      userId: user.id,
      displayName: user.nickname || user.username_raw || user.username,
    });
    return ok(c, { preauth, expiresIn: PREAUTH_TTL, mode: 'login', name: user.nickname || user.username_raw || user.username });
  }

  // ---- 注册：只做校验与密码哈希，真正建号延迟到 confirm（Turnstile 通过后） ----
  const strength = isStrongEnough(body.password);
  if (!strength.ok) throw errors.badRequest(strength.reason ?? '密码强度不足', 'WEAK_PASSWORD');

  const usernameLower = body.username!.toLowerCase();
  const email = body.email!;
  const existing = await c.env.DB.prepare(`SELECT id FROM users WHERE username = ? OR email = ? LIMIT 1`)
    .bind(usernameLower, email)
    .first<{ id: string }>();
  if (existing) throw errors.conflict(CONFLICT_MESSAGE, 'USER_EXISTS');

  const iterations = Number.parseInt(c.env.PASSWORD_ITERATIONS ?? '100000', 10) || 100000;
  const passwordHash = await hashPassword(body.password, iterations);

  const preauth = await putPreauth(c.env, {
    mode: 'register',
    username: usernameLower,
    usernameRaw: body.username,
    email,
    nickname: body.nickname?.trim() || body.username,
    passwordHash,
  });
  return ok(c, { preauth, expiresIn: PREAUTH_TTL, mode: 'register', name: usernameLower });
});

/**
 * POST /confirm — 桥接页在浏览器内完成 Turnstile 后消费 preauth：
 * 登录 → 签发一次性 ticket；注册 → 建号后签发 ticket。
 * ticket 与 site-login/issue 同构（绑定 origin+challenge+会话快照），App 用既有 redeem 兑换。
 */
app.post('/confirm', async (c) => {
  const body = await parseJson(c, confirmSchema);

  // 会话关卡：Turnstile 必须在浏览器内通过
  const turnstile = await verifyTurnstile(c.env, body.turnstileToken, c.req.header('cf-connecting-ip'));
  if (!turnstile.success) throw errors.badRequest('人机校验失败，请刷新页面重试', 'TURNSTILE_FAILED');

  const cfg = await getSsoAccessConfig(c.env);
  const origin = normalizeOrigin(body.origin);
  if (!cfg.enabled || !cfg.origins.includes(origin)) {
    throw errors.forbidden('该站点未被允许同步论坛登录状态', 'SSO_ORIGIN_NOT_ALLOWED');
  }

  const key = `${PREAUTH_KV_PREFIX}${await sha256Hex(body.preauth)}`;
  const raw = await c.env.CACHE.get(key);
  if (!raw) throw errors.badRequest('预授权已过期或已使用，请回到应用中重新操作', 'APP_PREAUTH_INVALID');
  await c.env.CACHE.delete(key); // 单次使用

  const data = JSON.parse(raw) as {
    mode: 'login' | 'register';
    userId?: string;
    displayName?: string;
    username?: string;
    usernameRaw?: string;
    email?: string;
    nickname?: string;
    passwordHash?: string;
  };

  async function issueTicket(userId: string): Promise<string> {
    const ticket = randomToken(24);
    // 会话快照取自 confirm 请求（来自用户浏览器，真实 IP），与 site-login/issue 一致
    const sessionSnapshot = sessionInfoFrom(c);
    await c.env.CACHE.put(
      `sso:site:ticket:${await sha256Hex(ticket)}`,
      JSON.stringify({ userId, origin, challenge: body.challenge, session: sessionSnapshot }),
      { expirationTtl: TICKET_TTL },
    );
    return ticket;
  }

  if (data.mode === 'login' && data.userId) {
    // 状态复核：preauth 有效期内账号可能被封禁
    const row = await c.env.DB.prepare(`SELECT status FROM users WHERE id = ?`).bind(data.userId).first<{ status: string }>();
    if (!row || row.status !== 'active') throw errors.badRequest('账号状态异常，请回到应用中重新登录', 'ACCOUNT_STATE_CHANGED');

    await c.env.DB.prepare(`UPDATE users SET last_login_at = ? WHERE id = ?`).bind(nowIso(), data.userId).run();
    const ticket = await issueTicket(data.userId);
    await writeAuditLog(c, { action: 'user.app_login', targetType: 'user', targetId: data.userId, actorId: data.userId, detail: 'app-login bridge' });
    return ok(c, { ticket, expiresIn: TICKET_TTL, mode: 'login' });
  }

  if (data.mode === 'register' && data.username && data.email && data.passwordHash) {
    // 并发注册触发唯一约束 → 统一提示
    const userId = newId(16);
    let uid: number;
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
        .bind(userId, uid, data.username, data.usernameRaw, data.email, data.passwordHash, data.nickname, nowIso(), nowIso())
        .run();
    } catch {
      throw errors.conflict(CONFLICT_MESSAGE, 'USER_EXISTS');
    }

    // 激活邮件（失败不影响注册；用户可在设置页重新发送）
    const verifyToken = await createEmailVerificationToken(c.env, userId);
    await sendVerificationEmail(c.env, data.email, data.nickname || data.usernameRaw || data.username, verifyToken);

    const ticket = await issueTicket(userId);
    await writeAuditLog(c, { action: 'user.register', targetType: 'user', targetId: userId, actorId: userId, detail: 'app-login bridge' });
    return ok(c, { ticket, expiresIn: TICKET_TTL, mode: 'register' });
  }

  throw errors.badRequest('预授权内容无效，请回到应用中重新操作', 'APP_PREAUTH_INVALID');
});

export default app;
