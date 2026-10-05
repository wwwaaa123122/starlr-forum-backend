/** /api/me — 当前用户资料与个人数据 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types';
import { requireAuth } from '../middleware/auth';
import { errors, ok } from '../lib/http';
import { parseJson, paginationSchema, paginationMeta } from '../lib/validate';
import { nowIso } from '../lib/ids';
import { hashPassword, isStrongEnough, verifyPassword } from '../lib/password';
import { revokeAllUserTokens } from '../lib/tokens';
import { writeAuditLog } from '../lib/audit';

const app = new Hono<AppEnv>();

app.use('*', requireAuth);

app.get('/', async (c) => {
  const user = c.get('user')!;
  const profile = await c.env.DB.prepare(
    `SELECT id, uid, username_raw AS username, nickname, email, avatar_url, bio, role, status, email_verified,
            post_count, reply_count, last_login_at, created_at
     FROM users WHERE id = ?`,
  )
    .bind(user.id)
    .first<Record<string, unknown>>();
  if (!profile) throw errors.notFound();
  return ok(c, {
    user: {
      id: profile.id,
      uid: profile.uid ?? null,
      username: profile.username,
      nickname: profile.nickname,
      email: profile.email,
      avatarUrl: profile.avatar_url,
      bio: profile.bio,
      role: profile.role,
      status: profile.status,
      emailVerified: (profile.email_verified ?? 1) === 1,
      accountStatus: profile.status === 'banned' ? 'banned' : (profile.email_verified ?? 1) === 1 ? 'active' : 'unverified',
      postCount: profile.post_count,
      replyCount: profile.reply_count,
      lastLoginAt: profile.last_login_at,
      createdAt: profile.created_at,
    },
  });
});

const updateSchema = z.object({
  nickname: z.string().trim().min(1, '昵称不能为空').max(24, '昵称最多 24 个字符').optional(),
  bio: z.string().trim().max(200, '个性签名最多 200 字').optional(),
  avatarUrl: z.string().trim().url('头像地址格式不正确').max(500).nullable().optional(),
});

app.patch('/', async (c) => {
  const user = c.get('user')!;
  const body = await parseJson(c, updateSchema);
  const sets: string[] = [];
  const values: unknown[] = [];
  if (body.nickname !== undefined) {
    sets.push('nickname = ?');
    values.push(body.nickname);
  }
  if (body.bio !== undefined) {
    sets.push('bio = ?');
    values.push(body.bio);
  }
  if (body.avatarUrl !== undefined) {
    sets.push('avatar_url = ?');
    values.push(body.avatarUrl);
  }
  if (sets.length === 0) throw errors.badRequest('没有需要更新的字段');
  sets.push('updated_at = ?');
  values.push(nowIso(), user.id);

  await c.env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run();
  return ok(c, { success: true });
});

/** 我收藏的帖子 */
app.get('/favorites', async (c) => {
  const user = c.get('user')!;
  const { page, pageSize } = paginationSchema.parse(Object.fromEntries(new URL(c.req.url).searchParams));
  const offset = (page - 1) * pageSize;

  const countRow = await c.env.DB.prepare(`SELECT COUNT(*) AS total FROM favorites WHERE user_id = ?`)
    .bind(user.id)
    .first<{ total: number }>();

  const { results } = await c.env.DB.prepare(
    `SELECT p.id, p.title, substr(p.content, 1, 200) AS excerpt, p.view_count AS viewCount,
            p.reply_count AS replyCount, p.like_count AS likeCount, p.is_pinned AS isPinned, p.is_featured AS isFeatured,
            p.created_at AS createdAt, p.last_reply_at AS lastReplyAt, f.created_at AS favoritedAt,
            u.username_raw AS authorName, u.id AS authorId, u.uid AS authorUid, u.avatar_url AS authorAvatar,
            c.name AS categoryName, c.slug AS categorySlug
     FROM favorites f
     JOIN posts p ON p.id = f.post_id AND p.is_deleted = 0
     JOIN users u ON u.id = p.author_id
     JOIN categories c ON c.id = p.category_id
     WHERE f.user_id = ?
     ORDER BY f.created_at DESC LIMIT ? OFFSET ?`,
  )
    .bind(user.id, pageSize, offset)
    .all();

  return ok(c, { posts: results ?? [], pagination: paginationMeta(page, pageSize, countRow?.total ?? 0) });
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(8, '密码至少 8 位').max(128),
});

/** 修改密码：验证当前密码 → 更新 → 撤销所有 Refresh Token（强制全部设备重新登录） */
app.patch('/password', async (c) => {
  const user = c.get('user')!;
  const body = await parseJson(c, changePasswordSchema);

  const strength = isStrongEnough(body.newPassword);
  if (!strength.ok) throw errors.badRequest(strength.reason ?? '密码强度不足', 'WEAK_PASSWORD');
  if (body.currentPassword === body.newPassword) throw errors.badRequest('新密码不能与当前密码相同');

  const row = await c.env.DB.prepare(`SELECT password_hash FROM users WHERE id = ?`)
    .bind(user.id)
    .first<{ password_hash: string }>();
  if (!row) throw errors.notFound();

  const okCurrent = await verifyPassword(body.currentPassword, row.password_hash);
  if (!okCurrent) throw errors.badRequest('当前密码不正确', 'WRONG_PASSWORD');

  const iterations = Number.parseInt(c.env.PASSWORD_ITERATIONS ?? '100000', 10) || 100000;
  const passwordHash = await hashPassword(body.newPassword, iterations);
  await c.env.DB.prepare(`UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?`)
    .bind(passwordHash, nowIso(), user.id)
    .run();
  await revokeAllUserTokens(c.env, user.id, 'password_change');
  await writeAuditLog(c, { action: 'user.change_password', targetType: 'user', targetId: user.id, actorId: user.id });
  return ok(c, { success: true });
});

export const meRoutes = app;
export default app;

/** 我点赞过的帖子（按点赞时间倒序） */
app.get('/likes', async (c) => {
  const user = c.get('user')!;
  const { page, pageSize } = paginationSchema.parse(Object.fromEntries(new URL(c.req.url).searchParams));
  const offset = (page - 1) * pageSize;

  const countRow = await c.env.DB.prepare(
    `SELECT COUNT(*) AS total FROM likes l JOIN posts p ON p.id = l.target_id AND p.is_deleted = 0
     WHERE l.user_id = ? AND l.target_type = 'post'`,
  )
    .bind(user.id)
    .first<{ total: number }>();

  const { results } = await c.env.DB.prepare(
    `SELECT p.id, p.title, substr(p.content, 1, 200) AS excerpt, p.view_count AS viewCount,
            p.reply_count AS replyCount, p.like_count AS likeCount, p.is_pinned AS isPinned, p.is_featured AS isFeatured,
            p.created_at AS createdAt, p.last_reply_at AS lastReplyAt, l.created_at AS likedAt,
            u.username_raw AS authorName, u.id AS authorId, u.uid AS authorUid, u.avatar_url AS authorAvatar,
            c.name AS categoryName, c.slug AS categorySlug
     FROM likes l
     JOIN posts p ON p.id = l.target_id AND p.is_deleted = 0
     JOIN users u ON u.id = p.author_id
     JOIN categories c ON c.id = p.category_id
     WHERE l.user_id = ? AND l.target_type = 'post'
     ORDER BY l.created_at DESC LIMIT ? OFFSET ?`,
  )
    .bind(user.id, pageSize, offset)
    .all();

  return ok(c, { posts: results ?? [], pagination: paginationMeta(page, pageSize, countRow?.total ?? 0) });
});
