/**
 * /api/admin/* — 管理后台（RBAC: user < moderator < admin）
 * 所有管理动作写入 audit_logs。
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types';
import { errors, ok } from '../lib/http';
import { parseJson, parseQuery, paginationSchema, paginationMeta } from '../lib/validate';
import { requireRole } from '../middleware/auth';
import { moderationScope, inScope, assertCategoryScope, moderatorLabel } from '../lib/moderation';
import { newId, nowIso } from '../lib/ids';
import { writeAuditLog } from '../lib/audit';
import { createNotification } from '../lib/notify';
import { sendEmail } from '../lib/mail';
import { CATEGORY_CACHE_KEY } from './categories';
import { RATE_LIMITS, consumeRateLimit } from '../lib/rate-limit';

const app = new Hono<AppEnv>();

app.use('*', requireRole('moderator', 'admin'));

const requireAdmin = requireRole('admin');

// ---------------------------------------------------------------
// 管理员配置（按 UID 授权，支持多管理员：admin / moderator）
// ---------------------------------------------------------------
const staffSchema = z.object({
  uid: z.number().int().positive().max(999_999_999),
  role: z.enum(['admin', 'moderator']).default('admin'),
});

/** 手动激活用户邮箱（管理员兜底：邮件未送达时使用） */
app.post('/users/:id/verify', requireAdmin, async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id');
  const res = await c.env.DB.prepare(`UPDATE users SET email_verified = 1, updated_at = ? WHERE id = ?`)
    .bind(nowIso(), id)
    .run();
  if ((res.meta?.changes ?? 0) === 0) throw errors.notFound('用户不存在');
  await writeAuditLog(c, { action: 'admin.user.verify', actorId: admin.id, targetType: 'user', targetId: id });
  return ok(c, { success: true });
});

/** 当前管理员/版主列表（ownerEmail = UID 1 的邮箱，管理告警收件人） */
app.get('/admins', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, uid, username_raw AS username, email, nickname, role, created_at AS createdAt, last_login_at AS lastLoginAt
     FROM users WHERE role IN ('admin', 'moderator') AND status = 'active'
     ORDER BY (role = 'admin') DESC, uid ASC`,
  ).all();
  const owner = await c.env.DB.prepare(`SELECT email FROM users WHERE uid = 1 AND status = 'active' LIMIT 1`)
    .first<{ email: string }>();
  return ok(c, { admins: results ?? [], ownerEmail: owner?.email ?? null });
});

/** 指定 UID 授予管理员/版主权限 */
app.post('/admins', requireAdmin, async (c) => {
  const actor = c.get('user')!;
  const body = await parseJson(c, staffSchema);

  const target = await c.env.DB.prepare(`SELECT id, uid, username_raw, email, nickname, role, status FROM users WHERE uid = ?`)
    .bind(body.uid)
    .first<{ id: string; uid: number; username_raw: string; email: string; nickname: string; role: string; status: string }>();
  if (!target) throw errors.notFound(`UID ${body.uid} 对应的用户不存在`, 'UID_NOT_FOUND');
  if (target.status !== 'active') throw errors.badRequest('该账号已被封禁，无法授予管理权限');
  if (target.role === body.role) return ok(c, { success: true, unchanged: true, user: { uid: target.uid, role: target.role } });

  await c.env.DB.prepare(`UPDATE users SET role = ?, updated_at = ? WHERE id = ?`).bind(body.role, nowIso(), target.id).run();

  await createNotification(c.env, {
    userId: target.id,
    actorId: actor.id,
    type: 'moderation',
    content: `你已被授予${body.role === 'admin' ? '管理员' : '版主'}权限`,
  });
  await writeAuditLog(c, {
    action: 'admin.staff.grant',
    actorId: actor.id,
    targetType: 'user',
    targetId: target.id,
    detail: `UID ${target.uid} → ${body.role}`,
  });
  await sendEmail(
    c.env,
    target.email,
    `你已被授予${body.role === 'admin' ? '管理员' : '版主'}权限`,
    `<p>你好，<strong>${target.nickname}</strong>：</p>
     <p>你的账号（UID ${target.uid}，@${target.username_raw}）已被授予<strong>${body.role === 'admin' ? '管理员' : '版主'}</strong>权限。</p>
     <p><a href="${c.env.SITE_URL}/admin">前往管理后台 →</a></p>`,
  ).catch(() => undefined);

  return ok(c, { success: true, user: { uid: target.uid, username: target.username_raw, role: body.role } });
});

/** 撤销 UID 的管理权限（降为普通用户） */
app.delete('/admins/:uid', requireAdmin, async (c) => {
  const actor = c.get('user')!;
  const uid = Number.parseInt(c.req.param('uid'), 10);
  if (!Number.isInteger(uid) || uid <= 0) throw errors.badRequest('UID 不合法');

  const target = await c.env.DB.prepare(`SELECT id, uid, username_raw, email, nickname, role FROM users WHERE uid = ?`)
    .bind(uid)
    .first<{ id: string; uid: number; username_raw: string; email: string; nickname: string; role: string }>();
  if (!target) throw errors.notFound(`UID ${uid} 对应的用户不存在`, 'UID_NOT_FOUND');
  if (target.role === 'user') return ok(c, { success: true, unchanged: true });
  if (target.id === actor.id) throw errors.badRequest('不能撤销自己的管理权限');

  // 至少保留一位管理员
  if (target.role === 'admin') {
    const adminCount = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active'`,
    ).first<{ n: number }>();
    if ((adminCount?.n ?? 0) <= 1) throw errors.badRequest('必须至少保留一位管理员');
  }

  await c.env.DB.prepare(`UPDATE users SET role = 'user', updated_at = ? WHERE id = ?`).bind(nowIso(), target.id).run();
  await writeAuditLog(c, {
    action: 'admin.staff.revoke',
    actorId: actor.id,
    targetType: 'user',
    targetId: target.id,
    detail: `UID ${target.uid} 撤销 ${target.role}`,
  });
  return ok(c, { success: true, user: { uid: target.uid, role: 'user' } });
});

// ---------------------------------------------------------------
// 概览
// ---------------------------------------------------------------
app.get('/stats', async (c) => {
  const counts = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM users WHERE status = 'active'`),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM posts WHERE is_deleted = 0`),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM replies WHERE is_deleted = 0`),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM reports WHERE status = 'pending'`),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM users WHERE status = 'banned'`),
    c.env.DB.prepare(`SELECT COALESCE(SUM(view_count), 0) AS n FROM posts WHERE is_deleted = 0`),
  ]);
  const [users, posts, replies, pendingReports, banned, views] = counts.map(
    (r) => (r.results?.[0] as { n?: number } | undefined)?.n ?? 0,
  );

  // 浏览量排行（被删帖除外）
  const top = await c.env.DB.prepare(
    `SELECT p.id, p.title, p.view_count AS viewCount, p.reply_count AS replyCount,
            p.like_count AS likeCount, p.created_at AS createdAt, u.username_raw AS authorName
     FROM posts p JOIN users u ON u.id = p.author_id
     WHERE p.is_deleted = 0
     ORDER BY p.view_count DESC, p.created_at DESC
     LIMIT 10`,
  ).all();

  return ok(c, {
    users,
    posts,
    replies,
    pendingReports,
    bannedUsers: banned,
    totalViews: views,
    avgViews: posts > 0 ? Math.round(views / posts) : 0,
    topPosts: top.results ?? [],
  });
});

// ---------------------------------------------------------------
// 用户管理
// ---------------------------------------------------------------
app.get('/users', requireAdmin, async (c) => {
  const { page, pageSize, query } = parseQuery(
    c,
    z.object({
      ...paginationSchema.shape,
      query: z.string().max(64).optional(),
    }),
  );
  const offset = (page - 1) * pageSize;
  const where: string[] = [];
  const params: unknown[] = [];
  if (query) {
    const uidMatch = /^\d{1,9}$/.test(query.trim()) ? Number.parseInt(query.trim(), 10) : -1;
    where.push(
      '(username LIKE ? ESCAPE \'\\\' OR nickname LIKE ? ESCAPE \'\\\' OR email LIKE ? ESCAPE \'\\\' OR uid = ?)',
    );
    const like = `%${query.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    params.push(like, like, like, uidMatch);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const countRow = await c.env.DB.prepare(`SELECT COUNT(*) AS total FROM users ${whereSql}`)
    .bind(...params)
    .first<{ total: number }>();
  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.uid, u.username_raw AS username, u.email, u.nickname, u.role, u.status,
            u.email_verified AS emailVerified, u.post_count AS postCount, u.reply_count AS replyCount,
            u.created_at AS createdAt, u.last_login_at AS lastLoginAt,
            (SELECT b.expires_at FROM bans b
              WHERE b.user_id = u.id AND b.type = 'mute' AND b.lifted_at IS NULL
                AND (b.expires_at IS NULL OR b.expires_at > datetime('now','utc'))
              ORDER BY (b.expires_at IS NULL) DESC, b.created_at DESC, b.rowid DESC LIMIT 1) AS mutedUntil,
            (SELECT b.expires_at IS NULL FROM bans b
              WHERE b.user_id = u.id AND b.type = 'mute' AND b.lifted_at IS NULL
                AND (b.expires_at IS NULL OR b.expires_at > datetime('now','utc'))
              ORDER BY (b.expires_at IS NULL) DESC, b.created_at DESC, b.rowid DESC LIMIT 1) AS mutedPermanent
     FROM users u ${whereSql} ORDER BY u.uid ASC LIMIT ? OFFSET ?`,
  )
    .bind(...params, pageSize, offset)
    .all();
  return ok(c, { users: results ?? [], pagination: paginationMeta(page, pageSize, countRow?.total ?? 0) });
});

const banSchema = z.object({
  reason: z.string().trim().min(1, '必须填写原因').max(500),
  days: z.number().int().min(1).max(3650).nullable().optional(),
});

app.post('/users/:id/ban', requireAdmin, async (c) => {
  const admin = c.get('user')!;
  const userId = c.req.param('id');
  const body = await parseJson(c, banSchema);
  if (userId === admin.id) throw errors.badRequest('不能封禁自己');

  const target = await c.env.DB.prepare(`SELECT id, role, status FROM users WHERE id = ?`)
    .bind(userId)
    .first<{ id: string; role: string; status: string }>();
  if (!target) throw errors.notFound('用户不存在');
  if (target.role === 'admin') throw errors.forbidden('不能封禁管理员');

  const expiresAt = body.days ? new Date(Date.now() + body.days * 86400_000).toISOString().slice(0, 19).replace('T', ' ') : null;
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE users SET status = 'banned', updated_at = ? WHERE id = ?`).bind(nowIso(), userId),
    c.env.DB.prepare(
      `INSERT INTO bans (id, user_id, type, reason, expires_at, created_by, created_at)
       VALUES (?, ?, 'ban', ?, ?, ?, ?)`,
    ).bind(newId(16), userId, body.reason, expiresAt, admin.id, nowIso()),
  ]);

  // 封禁即时生效：撤销其全部 Refresh Token
  await c.env.DB.prepare(
    `UPDATE refresh_tokens SET revoked_at = ?, revoked_reason = 'user_banned' WHERE user_id = ? AND revoked_at IS NULL`,
  )
    .bind(nowIso(), userId)
    .run();
  await createNotification(c.env, { userId, type: 'moderation', content: `您的账号已被封禁：${body.reason}` });
  await writeAuditLog(c, { action: 'admin.user.ban', actorId: admin.id, targetType: 'user', targetId: userId, detail: `${body.reason} ${expiresAt ?? 'permanent'}` });
  return ok(c, { success: true });
});

app.post('/users/:id/unban', requireAdmin, async (c) => {
  const admin = c.get('user')!;
  const userId = c.req.param('id');
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE users SET status = 'active', updated_at = ? WHERE id = ?`).bind(nowIso(), userId),
    c.env.DB.prepare(
      `UPDATE bans SET lifted_at = ?, lifted_by = ? WHERE user_id = ? AND type = 'ban' AND lifted_at IS NULL`,
    ).bind(nowIso(), admin.id, userId),
  ]);
  await writeAuditLog(c, { action: 'admin.user.unban', actorId: admin.id, targetType: 'user', targetId: userId });
  return ok(c, { success: true });
});

app.post('/users/:id/mute', requireAdmin, async (c) => {
  const admin = c.get('user')!;
  const userId = c.req.param('id');
  const body = await parseJson(c, banSchema);
  const target = await c.env.DB.prepare(`SELECT id, role FROM users WHERE id = ?`).bind(userId).first<{ id: string; role: string }>();
  if (!target) throw errors.notFound('用户不存在');
  if (target.role === 'admin') throw errors.forbidden('不能禁言管理员');

  const expiresAt = body.days ? new Date(Date.now() + body.days * 86400_000).toISOString().slice(0, 19).replace('T', ' ') : null;
  await c.env.DB.prepare(
    `INSERT INTO bans (id, user_id, type, reason, expires_at, created_by, created_at)
     VALUES (?, ?, 'mute', ?, ?, ?, ?)`,
  )
    .bind(newId(16), userId, body.reason, expiresAt, admin.id, nowIso())
    .run();
  await createNotification(c.env, { userId, type: 'moderation', content: `您已被禁言：${body.reason}` });
  await writeAuditLog(c, { action: 'admin.user.mute', actorId: admin.id, targetType: 'user', targetId: userId, detail: `${body.reason} ${expiresAt ?? 'permanent'}` });
  return ok(c, { success: true });
});

app.post('/users/:id/unmute', requireAdmin, async (c) => {
  const admin = c.get('user')!;
  const userId = c.req.param('id');
  await c.env.DB.prepare(
    `UPDATE bans SET lifted_at = ?, lifted_by = ? WHERE user_id = ? AND type = 'mute' AND lifted_at IS NULL`,
  )
    .bind(nowIso(), admin.id, userId)
    .run();
  await writeAuditLog(c, { action: 'admin.user.unmute', actorId: admin.id, targetType: 'user', targetId: userId });
  return ok(c, { success: true });
});

const roleSchema = z.object({ role: z.enum(['user', 'moderator', 'admin']) });

app.patch('/users/:id/role', requireAdmin, async (c) => {
  const admin = c.get('user')!;
  const userId = c.req.param('id');
  const body = await parseJson(c, roleSchema);
  if (userId === admin.id) throw errors.badRequest('不能修改自己的角色');
  const target = await c.env.DB.prepare(`SELECT id, role FROM users WHERE id = ?`)
    .bind(userId)
    .first<{ id: string; role: string }>();
  if (!target) throw errors.notFound('用户不存在');

  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE users SET role = ?, updated_at = ? WHERE id = ?`).bind(body.role, nowIso(), userId),
    // 版主降为普通用户时，同步清空其全部版块辖区
    ...(target.role === 'moderator' && body.role === 'user'
      ? [c.env.DB.prepare(`DELETE FROM moderators WHERE user_id = ?`).bind(userId)]
      : []),
  ]);
  await writeAuditLog(c, {
    action: 'admin.user.role',
    actorId: admin.id,
    targetType: 'user',
    targetId: userId,
    detail:
      target.role === 'moderator' && body.role === 'user'
        ? '版主 → 用户（辖区已清空）'
        : `→ ${body.role}`,
  });
  return ok(c, { success: true, scopeCleared: target.role === 'moderator' && body.role === 'user' });
});

// ---------------------------------------------------------------
// 版主任命（按版块授权）
// ---------------------------------------------------------------
const assignModeratorSchema = z.object({
  username: z.string().trim().min(1).max(40),
  categoryId: z.string().trim().min(1),
});

app.get('/moderators', requireAdmin, async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT m.user_id AS userId, m.category_id AS categoryId, m.created_at AS createdAt,
            u.username_raw AS username, u.nickname AS nickname,
            c.name AS categoryName, c.slug AS categorySlug
     FROM moderators m
     JOIN users u ON u.id = m.user_id
     JOIN categories c ON c.id = m.category_id
     ORDER BY c.sort_order, u.username_raw`,
  ).all();
  return ok(c, { moderators: results ?? [] });
});

app.post('/moderators', requireAdmin, async (c) => {
  const admin = c.get('user')!;
  const body = await parseJson(c, assignModeratorSchema);

  const user = await c.env.DB.prepare(
    `SELECT id, role, status FROM users WHERE username_raw = ? OR LOWER(username_raw) = LOWER(?) OR uid = ?`,
  )
    .bind(body.username, body.username, body.username)
    .first<{ id: string; role: string; status: string }>();
  if (!user) throw errors.notFound('用户不存在');
  if (user.status === 'banned') throw errors.badRequest('不能任命被封禁的用户为版主');
  if (user.role === 'admin') throw errors.badRequest('该用户已是管理员，无需任命版主');

  const category = await c.env.DB.prepare(`SELECT id, name FROM categories WHERE id = ?`)
    .bind(body.categoryId)
    .first<{ id: string; name: string }>();
  if (!category) throw errors.notFound('版块不存在');

  await c.env.DB.prepare(
    `INSERT INTO moderators (user_id, category_id) VALUES (?, ?) ON CONFLICT (user_id, category_id) DO NOTHING`,
  )
    .bind(user.id, category.id)
    .run();

  // 普通用户首次任命自动升级为 moderator（使其能进入后台）；已是 moderator 保持不变
  if (user.role === 'user') {
    await c.env.DB.prepare(`UPDATE users SET role = 'moderator', updated_at = ? WHERE id = ?`)
      .bind(nowIso(), user.id)
      .run();
  }
  await createNotification(c.env, {
    userId: user.id,
    actorId: admin.id,
    type: 'moderation',
    content: `您已被任命为「${category.name}」版块的版主`,
  });
  await writeAuditLog(c, {
    action: 'admin.moderator.assign',
    actorId: admin.id,
    targetType: 'user',
    targetId: user.id,
    detail: category.name,
  });
  return ok(c, { success: true, upgraded: user.role === 'user' });
});

app.delete('/moderators/:userId/:categoryId', requireAdmin, async (c) => {
  const admin = c.get('user')!;
  const { userId, categoryId } = c.req.param();
  const res = await c.env.DB.prepare(`DELETE FROM moderators WHERE user_id = ? AND category_id = ?`)
    .bind(userId, categoryId)
    .run();
  if (!res.meta.changes) throw errors.notFound('该任命不存在');
  const category = await c.env.DB.prepare(`SELECT name FROM categories WHERE id = ?`)
    .bind(categoryId)
    .first<{ name: string }>();
  await writeAuditLog(c, {
    action: 'admin.moderator.remove',
    actorId: admin.id,
    targetType: 'user',
    targetId: userId,
    detail: category?.name ?? categoryId,
  });
  return ok(c, { success: true });
});

// ---------------------------------------------------------------
// 帖子管理（置顶/加精/删除/恢复）
// ---------------------------------------------------------------
app.get('/posts', requireRole('moderator', 'admin'), async (c) => {
  const { page, pageSize, query, status } = parseQuery(
    c,
    z.object({
      ...paginationSchema.shape,
      query: z.string().max(120).optional(),
      status: z.enum(['all', 'normal', 'deleted']).default('all'),
    }),
  );
  const me = c.get('user')!;
  const scope = await moderationScope(c.env, me);
  if (scope !== '*' && scope.length === 0) {
    return ok(c, { posts: [], pagination: paginationMeta(page, pageSize, 0), moderatorScope: [] });
  }
  const offset = (page - 1) * pageSize;
  const where: string[] = [];
  const params: unknown[] = [];
  if (status === 'normal') where.push('p.is_deleted = 0');
  if (status === 'deleted') where.push('p.is_deleted = 1');
  if (query) {
    where.push('p.title LIKE ? ESCAPE \'\'');
    params.push(`%${query.replace(/[%_\\]/g, '')}%`);
  }
  if (scope !== '*') {
    where.push(`p.category_id IN (${scope.map(() => '?').join(',')})`);
    params.push(...scope);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const countRow = await c.env.DB.prepare(`SELECT COUNT(*) AS total FROM posts p ${whereSql}`)
    .bind(...params)
    .first<{ total: number }>();
  const { results } = await c.env.DB.prepare(
    `SELECT p.id, p.title, p.is_deleted AS isDeleted, p.is_pinned AS isPinned, p.is_featured AS isFeatured,
            p.view_count AS viewCount, p.reply_count AS replyCount, p.created_at AS createdAt,
            u.username_raw AS authorName, c.name AS categoryName
     FROM posts p JOIN users u ON u.id = p.author_id JOIN categories c ON c.id = p.category_id
     ${whereSql} ORDER BY p.created_at DESC LIMIT ? OFFSET ?`,
  )
    .bind(...params, pageSize, offset)
    .all();
  return ok(c, { posts: results ?? [], pagination: paginationMeta(page, pageSize, countRow?.total ?? 0), moderatorScope: scope === '*' ? null : scope });
});

const moderationAction = (action: 'pin' | 'unpin' | 'feature' | 'unfeature') =>
  async (c: Context<AppEnv>) => {
    const admin = c.get('user')!;
    const postId = c.req.param('id');
    const post = await c.env.DB.prepare(`SELECT id, is_deleted, category_id FROM posts WHERE id = ?`)
      .bind(postId)
      .first<{ id: string; is_deleted: number; category_id: string }>();
    if (!post) throw errors.notFound('帖子不存在');
    if (post.is_deleted) throw errors.badRequest('帖子已删除，请先恢复');
    await assertCategoryScope(c.env, admin, post.category_id);

    const sets: Record<string, string> = {
      pin: 'is_pinned = 1',
      unpin: 'is_pinned = 0',
      feature: 'is_featured = 1',
      unfeature: 'is_featured = 0',
    };
    await c.env.DB.prepare(`UPDATE posts SET ${sets[action]}, updated_at = ? WHERE id = ?`)
      .bind(nowIso(), postId)
      .run();
    await writeAuditLog(c, { action: `admin.post.${action}`, actorId: admin.id, targetType: 'post', targetId: postId });
    return ok(c, { success: true });
  };

app.post('/posts/:id/pin', requireRole('moderator', 'admin'), moderationAction('pin'));
app.post('/posts/:id/unpin', requireRole('moderator', 'admin'), moderationAction('unpin'));
app.post('/posts/:id/feature', requireRole('moderator', 'admin'), moderationAction('feature'));
app.post('/posts/:id/unfeature', requireRole('moderator', 'admin'), moderationAction('unfeature'));

app.post('/posts/:id/restore', requireRole('moderator', 'admin'), async (c) => {
  const admin = c.get('user')!;
  const postId = c.req.param('id');
  const post = await c.env.DB.prepare(`SELECT id, is_deleted, deleted_by, category_id FROM posts WHERE id = ?`)
    .bind(postId)
    .first<{ id: string; is_deleted: number; deleted_by: string | null; category_id: string }>();
  if (!post) throw errors.notFound('帖子不存在');
  if (!post.is_deleted) throw errors.badRequest('帖子未处于删除状态');
  await assertCategoryScope(c.env, admin, post.category_id);

  await c.env.DB.prepare(
    `UPDATE posts SET is_deleted = 0, deleted_at = NULL, deleted_by = NULL, updated_at = ? WHERE id = ?`,
  )
    .bind(nowIso(), postId)
    .run();
  await writeAuditLog(c, { action: 'admin.post.restore', actorId: admin.id, targetType: 'post', targetId: postId });
  return ok(c, { success: true });
});

app.delete('/posts/:id', requireRole('moderator', 'admin'), async (c) => {
  const admin = c.get('user')!;
  const postId = c.req.param('id');
  const post = await c.env.DB.prepare(`SELECT id, author_id, is_deleted, category_id FROM posts WHERE id = ?`)
    .bind(postId)
    .first<{ id: string; author_id: string; is_deleted: number; category_id: string }>();
  if (!post) throw errors.notFound('帖子不存在');
  if (post.is_deleted) throw errors.badRequest('帖子已处于删除状态');
  await assertCategoryScope(c.env, admin, post.category_id);

  await c.env.DB.prepare(`UPDATE posts SET is_deleted = 1, deleted_at = ?, deleted_by = ? WHERE id = ?`)
    .bind(nowIso(), admin.id, postId)
    .run();
  await createNotification(c.env, {
    userId: post.author_id,
    actorId: admin.id,
    type: 'moderation',
    content: `您的帖子已被${moderatorLabel(admin.role)}删除`,
  });
  await writeAuditLog(c, { action: 'admin.post.delete', actorId: admin.id, targetType: 'post', targetId: postId });
  return ok(c, { success: true });
});

// ---------------------------------------------------------------
// 回复管理
// ---------------------------------------------------------------
app.get('/replies', requireRole('moderator', 'admin'), async (c) => {
  const { page, pageSize } = parseQuery(c, paginationSchema);
  const me = c.get('user')!;
  const scope = await moderationScope(c.env, me);
  const offset = (page - 1) * pageSize;
  const scopeSql = scope === '*' ? '' : `WHERE p.category_id IN (${(scope as string[]).map(() => '?').join(',')})`;
  const scopeParams = scope === '*' ? [] : (scope as string[]);
  if (scope !== '*' && (scope as string[]).length === 0) {
    return ok(c, { replies: [], pagination: paginationMeta(page, pageSize, 0) });
  }
  const countRow = await c.env.DB.prepare(
    `SELECT COUNT(*) AS total FROM replies r JOIN posts p ON p.id = r.post_id ${scopeSql}`,
  )
    .bind(...scopeParams)
    .first<{ total: number }>();
  const { results } = await c.env.DB.prepare(
    `SELECT r.id, r.content, r.is_deleted AS isDeleted, r.created_at AS createdAt,
            u.username_raw AS authorName, p.id AS postId, p.title AS postTitle
     FROM replies r JOIN users u ON u.id = r.author_id JOIN posts p ON p.id = r.post_id
     ${scopeSql} ORDER BY r.created_at DESC LIMIT ? OFFSET ?`,
  )
    .bind(...scopeParams, pageSize, offset)
    .all();
  return ok(c, { replies: results ?? [], pagination: paginationMeta(page, pageSize, countRow?.total ?? 0) });
});

app.delete('/replies/:id', requireRole('moderator', 'admin'), async (c) => {
  const admin = c.get('user')!;
  const replyId = c.req.param('id');
  const reply = await c.env.DB.prepare(
    `SELECT r.id, r.author_id, r.post_id, r.is_deleted, p.category_id AS category_id
     FROM replies r JOIN posts p ON p.id = r.post_id WHERE r.id = ?`,
  )
    .bind(replyId)
    .first<{ id: string; author_id: string; post_id: string; is_deleted: number; category_id: string }>();
  if (!reply) throw errors.notFound('回复不存在');
  if (reply.is_deleted) throw errors.badRequest('回复已处于删除状态');
  await assertCategoryScope(c.env, admin, reply.category_id);

  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE replies SET is_deleted = 1, deleted_at = ?, deleted_by = ? WHERE id = ?`).bind(
      nowIso(),
      admin.id,
      replyId,
    ),
    c.env.DB.prepare(`UPDATE posts SET reply_count = MAX(0, reply_count - 1) WHERE id = ?`).bind(reply.post_id),
    c.env.DB.prepare(`UPDATE users SET reply_count = MAX(0, reply_count - 1) WHERE id = ?`).bind(reply.author_id),
  ]);
  await createNotification(c.env, {
    userId: reply.author_id,
    actorId: admin.id,
    type: 'moderation',
    content: `您的回复已被${moderatorLabel(admin.role)}删除`,
  });
  await writeAuditLog(c, { action: 'admin.reply.delete', actorId: admin.id, targetType: 'reply', targetId: replyId });
  return ok(c, { success: true });
});

app.post('/replies/:id/restore', requireRole('moderator', 'admin'), async (c) => {
  const admin = c.get('user')!;
  const replyId = c.req.param('id');
  const reply = await c.env.DB.prepare(
    `SELECT r.id, r.author_id, r.post_id, r.is_deleted, p.category_id AS category_id
     FROM replies r JOIN posts p ON p.id = r.post_id WHERE r.id = ?`,
  )
    .bind(replyId)
    .first<{ id: string; author_id: string; post_id: string; is_deleted: number; category_id: string }>();
  if (!reply) throw errors.notFound('回复不存在');
  if (!reply.is_deleted) throw errors.badRequest('回复未处于删除状态');
  await assertCategoryScope(c.env, admin, reply.category_id);

  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE replies SET is_deleted = 0, deleted_at = NULL, deleted_by = NULL, updated_at = ? WHERE id = ?`,
    ).bind(nowIso(), replyId),
    c.env.DB.prepare(`UPDATE posts SET reply_count = reply_count + 1 WHERE id = ?`).bind(reply.post_id),
    c.env.DB.prepare(`UPDATE users SET reply_count = reply_count + 1 WHERE id = ?`).bind(reply.author_id),
  ]);
  await writeAuditLog(c, { action: 'admin.reply.restore', actorId: admin.id, targetType: 'reply', targetId: replyId });
  return ok(c, { success: true });
});

// ---------------------------------------------------------------
// 分类管理
// ---------------------------------------------------------------
const categorySchema = z.object({
  name: z.string().trim().min(1, '名称不能为空').max(24),
  slug: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .regex(/^[a-z0-9-]+$/, 'slug 只能包含小写字母、数字和短横线'),
  description: z.string().trim().max(200).default(''),
  icon: z
    .string()
    .trim()
    .max(500)
    .default('')
    .refine(
      (v) =>
        v === '' ||
        // emoji / 任意短字符（≤8），或图片 URL（http/https 或站内 /api/files/、/api/avatars/）
        v.length <= 8 ||
        /^(https?:\/\/|\/api\/(files|avatars)\/)/.test(v),
      { message: '图标只能是 emoji 或图片地址' },
    ),
  sortOrder: z.number().int().min(0).max(9999).default(0),
});

async function invalidateCategoryCache(c: { env: AppEnv['Bindings'] }) {
  await c.env.CACHE.delete(CATEGORY_CACHE_KEY);
}

/** 系统通知：全部用户或指定 UID（content 存 JSON，前端解析渲染） */
const notifySchema = z.object({
  title: z.string().trim().min(1).max(100),
  body: z.string().trim().max(500).default(''),
  link: z
    .string()
    .trim()
    .max(300)
    .default('')
    .refine((v) => v === '' || v.startsWith('/') || /^https?:\/\//.test(v), { message: '链接必须是站内路径或 http(s) 地址' }),
  target: z.union([z.literal('all'), z.coerce.number().int().positive()]).default('all'),
});

app.post('/notifications', requireAdmin, async (c) => {
  const admin = c.get('user')!;
  const rl = await consumeRateLimit(c.env, RATE_LIMITS.notify, admin.id);
  if (!rl.ok) throw errors.tooMany('发送过于频繁，请稍后再试');
  const body = await parseJson(c, notifySchema);

  let recipients: Array<{ id: string }>;
  if (body.target === 'all') {
    const { results } = await c.env.DB.prepare(`SELECT id FROM users WHERE status = 'active'`).all<{ id: string }>();
    recipients = results ?? [];
  } else {
    const user = await c.env.DB.prepare(`SELECT id FROM users WHERE uid = ? AND status = 'active'`)
      .bind(body.target)
      .first<{ id: string }>();
    if (!user) throw errors.notFound('目标用户不存在（UID 无效或已封禁）', 'UID_NOT_FOUND');
    recipients = [user];
  }
  if (recipients.length === 0) return ok(c, { created: 0 });

  const content = JSON.stringify({ title: body.title, body: body.body, link: body.link || undefined });
  const now = nowIso();
  const stmts = recipients.map((r) =>
    c.env.DB.prepare(
      `INSERT INTO notifications (id, user_id, actor_id, type, content, is_read, created_at)
       VALUES (?, ?, ?, 'system', ?, 0, ?)`,
    ).bind(newId(16), r.id, admin.id, content, now),
  );
  await c.env.DB.batch(stmts);
  await writeAuditLog(c, {
    action: 'admin.notification.send',
    actorId: admin.id,
    targetType: 'notification',
    targetId: body.target === 'all' ? 'all' : String(body.target),
    detail: body.title,
  });
  return ok(c, { created: recipients.length }, { status: 201 });
});

app.post('/categories', requireAdmin, async (c) => {
  const admin = c.get('user')!;
  const body = await parseJson(c, categorySchema);
  const exists = await c.env.DB.prepare(`SELECT 1 FROM categories WHERE slug = ?`).bind(body.slug).first();
  if (exists) throw errors.conflict('分类 slug 已存在');

  const id = newId(16);
  await c.env.DB.prepare(
    `INSERT INTO categories (id, name, slug, description, icon, sort_order, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, body.name, body.slug, body.description, body.icon, body.sortOrder, nowIso())
    .run();
  await invalidateCategoryCache(c);
  await writeAuditLog(c, { action: 'admin.category.create', actorId: admin.id, targetType: 'category', targetId: id, detail: body.name });
  return ok(c, { id }, { status: 201 });
});

app.patch('/categories/:id', requireAdmin, async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id');
  const body = await parseJson(c, categorySchema.partial());
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const key of ['name', 'slug', 'description', 'icon'] as const) {
    if (body[key] !== undefined) {
      sets.push(`${key} = ?`);
      values.push(body[key]);
    }
  }
  if (body.sortOrder !== undefined) {
    sets.push('sort_order = ?');
    values.push(body.sortOrder);
  }
  if (sets.length === 0) throw errors.badRequest('没有需要更新的字段');
  values.push(id);
  await c.env.DB.prepare(`UPDATE categories SET ${sets.join(', ')} WHERE id = ?`).bind(...values).run();
  await invalidateCategoryCache(c);
  await writeAuditLog(c, { action: 'admin.category.update', actorId: admin.id, targetType: 'category', targetId: id });
  return ok(c, { success: true });
});

app.delete('/categories/:id', requireAdmin, async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id');
  const postCount = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM posts WHERE category_id = ?`)
    .bind(id)
    .first<{ n: number }>();
  if ((postCount?.n ?? 0) > 0) throw errors.conflict('分类下仍有帖子，无法删除');

  await c.env.DB.prepare(`DELETE FROM categories WHERE id = ?`).bind(id).run();
  await invalidateCategoryCache(c);
  await writeAuditLog(c, { action: 'admin.category.delete', actorId: admin.id, targetType: 'category', targetId: id });
  return ok(c, { success: true });
});

const sortSchema = z.object({ ids: z.array(z.string().max(32)).min(1).max(100) });

/** 恢复默认分类（幂等：仅补齐缺失的种子分类，不动已有分类的数据） */
app.post('/categories/restore-defaults', requireAdmin, async (c) => {
  const admin = c.get('user')!;
  const defaults = [
    { id: 'cat0welcome0000001', name: '站务公告', slug: 'announcements', description: '论坛公告与站务讨论', icon: '📢', sortOrder: 0, postPolicy: 'staff' },
    { id: 'cat0tech000000001', name: '技术分享', slug: 'tech', description: '编程、架构、云计算与开发经验', icon: '💻', sortOrder: 1, postPolicy: 'everyone' },
    { id: 'cat0idle000000001', name: '闲聊灌水', slug: 'idle', description: '轻松话题，随意畅聊', icon: '💬', sortOrder: 3, postPolicy: 'everyone' },
    { id: 'cat0qa0000000001', name: '问答求助', slug: 'qa', description: '提问与互助解答', icon: '❓', sortOrder: 4, postPolicy: 'everyone' },
  ];
  const restored: string[] = [];
  for (const d of defaults) {
    const res = await c.env.DB.prepare(
      `INSERT INTO categories (id, name, slug, description, icon, sort_order, post_policy)
       SELECT ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM categories WHERE slug = ?)`,
    )
      .bind(d.id, d.name, d.slug, d.description, d.icon, d.sortOrder, d.postPolicy, d.slug)
      .run();
    if (res.meta.changes) restored.push(d.name);
  }
  if (restored.length) {
    await writeAuditLog(c, {
      action: 'admin.category.restore_defaults',
      actorId: admin.id,
      targetType: 'category',
      detail: restored.join('、'),
    });
  }
  return ok(c, { restored });
});

app.patch('/categories-sort', requireAdmin, async (c) => {
  const admin = c.get('user')!;
  const body = await parseJson(c, sortSchema);
  const stmt = c.env.DB.prepare(`UPDATE categories SET sort_order = ? WHERE id = ?`);
  await c.env.DB.batch(body.ids.map((id, i) => stmt.bind(i, id)));
  await invalidateCategoryCache(c);
  await writeAuditLog(c, { action: 'admin.category.sort', actorId: admin.id, detail: body.ids.join(',') });
  return ok(c, { success: true });
});

// ---------------------------------------------------------------
// 举报管理
// ---------------------------------------------------------------
app.get('/reports', requireRole('moderator', 'admin'), async (c) => {
  const { page, pageSize, status } = parseQuery(
    c,
    z.object({ ...paginationSchema.shape, status: z.enum(['pending', 'resolved', 'dismissed', 'all']).default('pending') }),
  );
  const me = c.get('user')!;
  const scope = await moderationScope(c.env, me);
  if (scope !== '*' && (scope as string[]).length === 0) {
    return ok(c, { reports: [], pagination: paginationMeta(page, pageSize, 0) });
  }
  const offset = (page - 1) * pageSize;
  const where: string[] = [];
  const params: unknown[] = [];
  if (status !== 'all') {
    where.push('r.status = ?');
    params.push(status);
  }
  if (scope !== '*') {
    // 帖子举报 → 帖子所属版；回复举报 → 该回复所在帖子的版；用户举报无版块归属（仅管理员可见）
    where.push(
      `CASE r.target_type WHEN 'post' THEN p.category_id WHEN 'reply' THEN pp.category_id ELSE NULL END IN (${(scope as string[]).map(() => '?').join(',')})`,
    );
    params.push(...(scope as string[]));
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const countRow = await c.env.DB.prepare(
    `SELECT COUNT(*) AS total FROM reports r
     LEFT JOIN posts p ON r.target_type = 'post' AND p.id = r.target_id
     LEFT JOIN replies rp ON r.target_type = 'reply' AND rp.id = r.target_id
     LEFT JOIN posts pp ON r.target_type = 'reply' AND pp.id = rp.post_id
     ${whereSql}`,
  )
    .bind(...params)
    .first<{ total: number }>();
  const { results } = await c.env.DB.prepare(
    `SELECT r.id, r.target_type AS targetType, r.target_id AS targetId, r.reason, r.detail,
            r.status, r.resolution_note AS resolutionNote, r.created_at AS createdAt, r.handled_at AS handledAt,
            ru.username_raw AS reporterName,
            CASE r.target_type WHEN 'post' THEN p.title WHEN 'reply' THEN substr(rp.content, 1, 200) ELSE u2.username_raw END AS targetTitle,
            CASE r.target_type WHEN 'post' THEN substr(p.content, 1, 200) WHEN 'reply' THEN substr(rp.content, 1, 200) ELSE '' END AS targetContent,
            CASE r.target_type WHEN 'post' THEN pu.username_raw WHEN 'reply' THEN ru2.username_raw ELSE u2.username_raw END AS targetAuthorName,
            CASE r.target_type WHEN 'post' THEN p.author_id WHEN 'reply' THEN rp.author_id ELSE r.target_id END AS targetUserId,
            CASE r.target_type WHEN 'post' THEN p.is_deleted WHEN 'reply' THEN rp.is_deleted ELSE 0 END AS targetDeleted
     FROM reports r
     JOIN users ru ON ru.id = r.reporter_id
     LEFT JOIN posts p ON r.target_type = 'post' AND p.id = r.target_id
     LEFT JOIN replies rp ON r.target_type = 'reply' AND rp.id = r.target_id
     LEFT JOIN users pu ON pu.id = p.author_id
     LEFT JOIN users ru2 ON ru2.id = rp.author_id
     LEFT JOIN users u2 ON r.target_type = 'user' AND u2.id = r.target_id
     LEFT JOIN posts pp ON r.target_type = 'reply' AND pp.id = rp.post_id
     ${whereSql} ORDER BY r.created_at DESC LIMIT ? OFFSET ?`,
  )
    .bind(...params, pageSize, offset)
    .all();
  return ok(c, { reports: results ?? [], pagination: paginationMeta(page, pageSize, countRow?.total ?? 0) });
});

const handleReportSchema = z.object({
  /** 处理动作：无违规 / 禁言 / 封禁 / 删除内容 */
  action: z.enum(['dismiss', 'mute', 'ban', 'delete_content']).default('dismiss'),
  note: z.string().trim().max(500).default(''),
  days: z.number().int().min(1).max(3650).nullable().optional(),
});

app.post('/reports/:id/resolve', requireRole('moderator', 'admin'), async (c) => {
  const admin = c.get('user')!;
  const reportId = c.req.param('id');
  const body = await parseJson(c, handleReportSchema);
  const report = await c.env.DB.prepare(`SELECT id, status, reporter_id FROM reports WHERE id = ?`)
    .bind(reportId)
    .first<{ id: string; status: string; reporter_id: string }>();
  if (!report) throw errors.notFound('举报不存在');
  if (report.status !== 'pending') throw errors.badRequest('举报已被处理');

  // 定位被举报内容与其作者（举报用户时 target 即用户）
  const target = await c.env.DB.prepare(
    `SELECT r.target_type AS targetType, r.target_id AS targetId,
            p.author_id AS postAuthor, rp.author_id AS replyAuthor,
            p.category_id AS postCategory, pp.category_id AS replyCategory
     FROM reports r
     LEFT JOIN posts p ON r.target_type = 'post' AND p.id = r.target_id
     LEFT JOIN replies rp ON r.target_type = 'reply' AND rp.id = r.target_id
     LEFT JOIN posts pp ON r.target_type = 'reply' AND pp.id = rp.post_id
     WHERE r.id = ?`,
  )
    .bind(reportId)
    .first<{
      targetType: string;
      targetId: string;
      postAuthor: string | null;
      replyAuthor: string | null;
      postCategory: string | null;
      replyCategory: string | null;
    }>();
  const targetUserId = target?.targetType === 'user' ? target.targetId : (target?.postAuthor ?? target?.replyAuthor);
  // 辖区校验：帖子/回复举报必须落在版主所辖版块；用户举报仅管理员可处理
  const targetCategoryId =
    target?.targetType === 'post' ? target.postCategory : target?.targetType === 'reply' ? target.replyCategory : null;
  await assertCategoryScope(c.env, admin, targetCategoryId);

  let finalNote = body.note;

  if (body.action === 'mute' || body.action === 'ban') {
    if (!targetUserId) throw errors.badRequest('找不到被举报内容的作者', 'TARGET_MISSING');
    if (targetUserId === admin.id) throw errors.badRequest('不能对自己执行该操作');
    const t = await c.env.DB.prepare(`SELECT id, role FROM users WHERE id = ?`).bind(targetUserId).first<{ id: string; role: string }>();
    if (!t) throw errors.notFound('用户不存在');
    if (t.role === 'admin') throw errors.forbidden('不能对该用户执行该操作');

    const expiresAt = body.action === 'ban' && body.days
      ? new Date(Date.now() + body.days * 86400_000).toISOString().slice(0, 19).replace('T', ' ')
      : body.action === 'mute'
        ? body.days
          ? new Date(Date.now() + body.days * 86400_000).toISOString().slice(0, 19).replace('T', ' ')
          : null
        : null;

    if (body.action === 'mute') {
      await c.env.DB.prepare(
        `INSERT INTO bans (id, user_id, type, reason, expires_at, created_by, created_at) VALUES (?, ?, 'mute', ?, ?, ?, ?)`,
      )
        .bind(newId(16), targetUserId, body.note || '被举报处理', expiresAt, admin.id, nowIso())
        .run();
      await createNotification(c.env, { userId: targetUserId, type: 'moderation', content: `您已被禁言：${body.note || '被举报处理'}` });
      await writeAuditLog(c, { action: 'admin.user.mute', actorId: admin.id, targetType: 'user', targetId: targetUserId, detail: `${body.note} ${expiresAt ?? 'permanent'}` });
      finalNote = `[禁言${body.days ? ` ${body.days} 天` : ' 永久'}] ${body.note}`;
    } else {
      const expiresAtBan = body.days ? new Date(Date.now() + body.days * 86400_000).toISOString().slice(0, 19).replace('T', ' ') : null;
      await c.env.DB.batch([
        c.env.DB.prepare(`UPDATE users SET status = 'banned', updated_at = ? WHERE id = ?`).bind(nowIso(), targetUserId),
        c.env.DB.prepare(
          `INSERT INTO bans (id, user_id, type, reason, expires_at, created_by, created_at) VALUES (?, ?, 'ban', ?, ?, ?, ?)`,
        ).bind(newId(16), targetUserId, body.note || '被举报处理', expiresAtBan, admin.id, nowIso()),
      ]);
      await c.env.DB.prepare(
        `UPDATE refresh_tokens SET revoked_at = ?, revoked_reason = 'user_banned' WHERE user_id = ? AND revoked_at IS NULL`,
      )
        .bind(nowIso(), targetUserId)
        .run();
      await createNotification(c.env, { userId: targetUserId, type: 'moderation', content: `您的账号已被封禁：${body.note || '被举报处理'}` });
      await writeAuditLog(c, { action: 'admin.user.ban', actorId: admin.id, targetType: 'user', targetId: targetUserId, detail: `${body.note} ${expiresAtBan ?? 'permanent'}` });
      finalNote = `[封禁${body.days ? ` ${body.days} 天` : ' 永久'}] ${body.note}`;
    }
  } else if (body.action === 'delete_content') {
    if (target?.targetType === 'post') {
      await c.env.DB.prepare(`UPDATE posts SET is_deleted = 1, deleted_at = ?, deleted_by = ? WHERE id = ?`)
        .bind(nowIso(), admin.id, target.targetId)
        .run();
    } else if (target?.targetType === 'reply') {
      await c.env.DB.prepare(`UPDATE replies SET is_deleted = 1, deleted_at = ?, deleted_by = ? WHERE id = ?`)
        .bind(nowIso(), admin.id, target.targetId)
        .run();
    } else if (target?.targetType === 'user') {
      throw errors.badRequest('用户类型举报请使用禁言或封禁');
    }
    await writeAuditLog(c, { action: 'admin.report.delete_content', actorId: admin.id, targetType: target?.targetType ?? 'post', targetId: target?.targetId ?? '', detail: body.note });
    finalNote = `[删除内容] ${body.note}`;
  }

  const status = body.action === 'dismiss' ? 'dismissed' : 'resolved';
  await c.env.DB.prepare(
    `UPDATE reports SET status = ?, handled_by = ?, handled_at = ?, resolution_note = ? WHERE id = ?`,
  )
    .bind(status, admin.id, nowIso(), finalNote, reportId)
    .run();
  await writeAuditLog(c, { action: 'admin.report.resolve', actorId: admin.id, targetType: 'report', targetId: reportId, detail: finalNote });
  return ok(c, { success: true, action: body.action });
});

app.post('/reports/:id/dismiss', requireRole('moderator', 'admin'), async (c) => {
  const admin = c.get('user')!;
  const reportId = c.req.param('id');
  const body = await parseJson(c, handleReportSchema);
  const report = await c.env.DB.prepare(`SELECT id, status FROM reports WHERE id = ?`)
    .bind(reportId)
    .first<{ id: string; status: string }>();
  if (!report) throw errors.notFound('举报不存在');
  if (report.status !== 'pending') throw errors.badRequest('举报已被处理');

  const target = await c.env.DB.prepare(
    `SELECT r.target_type AS targetType, p.category_id AS postCategory, pp.category_id AS replyCategory
     FROM reports r
     LEFT JOIN posts p ON r.target_type = 'post' AND p.id = r.target_id
     LEFT JOIN replies rp ON r.target_type = 'reply' AND rp.id = r.target_id
     LEFT JOIN posts pp ON r.target_type = 'reply' AND pp.id = rp.post_id
     WHERE r.id = ?`,
  )
    .bind(reportId)
    .first<{ targetType: string; postCategory: string | null; replyCategory: string | null }>();
  const targetCategoryId =
    target?.targetType === 'post' ? target.postCategory : target?.targetType === 'reply' ? target.replyCategory : null;
  await assertCategoryScope(c.env, admin, targetCategoryId);

  await c.env.DB.prepare(
    `UPDATE reports SET status = 'dismissed', handled_by = ?, handled_at = ?, resolution_note = ? WHERE id = ?`,
  )
    .bind(admin.id, nowIso(), body.note, reportId)
    .run();
  await writeAuditLog(c, { action: 'admin.report.dismiss', actorId: admin.id, targetType: 'report', targetId: reportId, detail: body.note });
  return ok(c, { success: true });
});

// ---------------------------------------------------------------
// ---------------- 浏览统计 ----------------
app.get('/views', requireRole('moderator', 'admin'), async (c) => {
  const db = c.env.DB;

  const [totalsRow, postTotalRow, dailyRows, topRows, recentRows] = await Promise.all([
    db
      .prepare(
        `SELECT
           COUNT(*) FILTER (WHERE created_at >= datetime('now', 'start of day')) AS today,
           COUNT(*) FILTER (WHERE created_at >= datetime('now', 'start of day', '-1 day') AND created_at < datetime('now', 'start of day')) AS yesterday,
           COUNT(*) FILTER (WHERE created_at >= datetime('now', '-7 days')) AS week,
           COUNT(*) FILTER (WHERE created_at >= datetime('now', '-30 days')) AS month
         FROM view_events`,
      )
      .first<{ today: number; yesterday: number; week: number; month: number }>(),
    db.prepare(`SELECT COALESCE(SUM(view_count), 0) AS total FROM posts WHERE is_deleted = 0`).first<{ total: number }>(),
    db
      .prepare(
        `SELECT substr(created_at, 1, 10) AS date, COUNT(*) AS views
         FROM view_events WHERE created_at >= datetime('now', '-13 days')
         GROUP BY date ORDER BY date`,
      )
      .all<{ date: string; views: number }>(),
    db
      .prepare(
        `SELECT v.post_id AS postId, p.title, COUNT(*) AS views
         FROM view_events v JOIN posts p ON p.id = v.post_id
         WHERE v.created_at >= datetime('now', '-7 days')
         GROUP BY v.post_id ORDER BY views DESC LIMIT 10`,
      )
      .all<{ postId: string; title: string; views: number }>(),
    db
      .prepare(
        `SELECT v.id, v.post_id AS postId, p.title, v.country, v.city, v.colo, v.device,
                v.user_id AS userId, u.username_raw AS userName, v.created_at AS createdAt
         FROM view_events v
         JOIN posts p ON p.id = v.post_id
         LEFT JOIN users u ON u.id = v.user_id
         ORDER BY v.created_at DESC LIMIT 50`,
      )
      .all(),
  ]);

  // 补齐 14 天空缺日期
  const byDate = new Map((dailyRows.results ?? []).map((r) => [r.date, r.views]));
  const daily: { date: string; views: number }[] = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    daily.push({ date: d, views: byDate.get(d) ?? 0 });
  }

  return ok(c, {
    totals: {
      today: totalsRow?.today ?? 0,
      yesterday: totalsRow?.yesterday ?? 0,
      week: totalsRow?.week ?? 0,
      month: totalsRow?.month ?? 0,
      allTime: postTotalRow?.total ?? 0,
    },
    daily,
    top: topRows.results ?? [],
    recent: recentRows.results ?? [],
  });
});

// 审计日志
// ---------------------------------------------------------------
app.get('/audit-logs', requireAdmin, async (c) => {
  const { page, pageSize, action } = parseQuery(
    c,
    z.object({ ...paginationSchema.shape, action: z.string().max(64).optional() }),
  );
  const offset = (page - 1) * pageSize;
  const whereSql = action ? 'WHERE a.action = ?' : '';
  const params: unknown[] = action ? [action] : [];
  const countRow = await c.env.DB.prepare(`SELECT COUNT(*) AS total FROM audit_logs a ${whereSql}`)
    .bind(...params)
    .first<{ total: number }>();
  const { results } = await c.env.DB.prepare(
    `SELECT a.id, a.action, a.target_type AS targetType, a.target_id AS targetId, a.detail, a.ip,
            a.created_at AS createdAt, u.username_raw AS actorName
     FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
     ${whereSql} ORDER BY a.created_at DESC LIMIT ? OFFSET ?`,
  )
    .bind(...params, pageSize, offset)
    .all();
  return ok(c, { logs: results ?? [], pagination: paginationMeta(page, pageSize, countRow?.total ?? 0) });
});

export default app;
