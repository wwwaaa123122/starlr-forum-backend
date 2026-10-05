/** /api/notifications — 站内通知：列表 / 未读数 / 标记已读 / 全部已读 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types';
import { errors, ok } from '../lib/http';
import { parseQuery, parseJson, paginationSchema, paginationMeta } from '../lib/validate';
import { requireAuth } from '../middleware/auth';
import { RATE_LIMITS, consumeRateLimit } from '../lib/rate-limit';

const app = new Hono<AppEnv>();

app.use('*', requireAuth);

app.get('/', async (c) => {
  const user = c.get('user')!;
  const rl = await consumeRateLimit(c.env, RATE_LIMITS.notification, user.id);
  if (!rl.ok) throw errors.tooMany();
  const { page, pageSize, unreadOnly } = parseQuery(
    c,
    z.object({ ...paginationSchema.shape, unreadOnly: z.enum(['0', '1']).optional() }),
  );
  const offset = (page - 1) * pageSize;

  const conditions = ['n.user_id = ?'];
  if (unreadOnly === '1') conditions.push('n.is_read = 0');
  const baseFrom = `FROM notifications n
     LEFT JOIN users actor ON actor.id = n.actor_id
     LEFT JOIN posts p ON p.id = n.post_id`;

  const countRow = await c.env.DB.prepare(`SELECT COUNT(*) AS total ${baseFrom} WHERE ${conditions.join(' AND ')}`)
    .bind(user.id)
    .first<{ total: number }>();
  const { results } = await c.env.DB.prepare(
    `SELECT n.id, n.type, n.post_id AS postId, n.reply_id AS replyId, n.content, n.is_read AS isRead,
            n.created_at AS createdAt,
            actor.username_raw AS actorName, actor.avatar_url AS actorAvatar,
            p.title AS postTitle
     ${baseFrom} WHERE ${conditions.join(' AND ')}
     ORDER BY n.created_at DESC LIMIT ? OFFSET ?`,
  )
    .bind(user.id, pageSize, offset)
    .all();

  const unreadRow = await c.env.DB.prepare(
    `SELECT COUNT(*) AS unread FROM notifications WHERE user_id = ? AND is_read = 0`,
  )
    .bind(user.id)
    .first<{ unread: number }>();

  return ok(c, {
    notifications: results ?? [],
    unread: unreadRow?.unread ?? 0,
    pagination: paginationMeta(page, pageSize, countRow?.total ?? 0),
  });
});

app.get('/unread-count', async (c) => {
  const user = c.get('user')!;
  const row = await c.env.DB.prepare(
    `SELECT COUNT(*) AS unread FROM notifications WHERE user_id = ? AND is_read = 0`,
  )
    .bind(user.id)
    .first<{ unread: number }>();
  return ok(c, { unread: row?.unread ?? 0 });
});

const readSchema = z.object({ ids: z.array(z.string().max(32)).max(100).optional() });

app.post('/read', async (c) => {
  const user = c.get('user')!;
  const body = await parseJson(c, readSchema);
  if (body.ids && body.ids.length > 0) {
    const placeholders = body.ids.map(() => '?').join(',');
    await c.env.DB.prepare(`UPDATE notifications SET is_read = 1 WHERE user_id = ? AND id IN (${placeholders})`)
      .bind(user.id, ...body.ids)
      .run();
  } else {
    await c.env.DB.prepare(`UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0`)
      .bind(user.id)
      .run();
  }
  return ok(c, { success: true });
});

app.post('/read-all', async (c) => {
  const user = c.get('user')!;
  await c.env.DB.prepare(`UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0`)
    .bind(user.id)
    .run();
  return ok(c, { success: true });
});

export default app;
