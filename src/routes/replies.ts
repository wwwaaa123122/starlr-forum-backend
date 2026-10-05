/** /api/replies/:id — 单条回复的编辑、删除、点赞 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types';
import { errors, ok } from '../lib/http';
import { parseJson } from '../lib/validate';
import { requireAuth } from '../middleware/auth';
import { newId, nowIso } from '../lib/ids';
import { bumpPostCounter, bumpUserCounter } from '../lib/queries';
import { createNotification } from '../lib/notify';
import { RATE_LIMITS, consumeRateLimit } from '../lib/rate-limit';

const app = new Hono<AppEnv>();

const updateReplySchema = z.object({
  content: z.string().trim().min(1, '回复内容不能为空').max(20_000),
});

app.patch('/:id', requireAuth, async (c) => {
  const id = c.req.param('id');
  const user = c.get('user')!;
  const body = await parseJson(c, updateReplySchema);

  const reply = await c.env.DB.prepare(`SELECT id, author_id, is_deleted FROM replies WHERE id = ?`)
    .bind(id)
    .first<{ id: string; author_id: string; is_deleted: number }>();
  if (!reply || reply.is_deleted) throw errors.notFound('回复不存在');
  if (reply.author_id !== user.id && user.role !== 'admin' && user.role !== 'moderator') {
    throw errors.forbidden('只能编辑自己的回复');
  }

  await c.env.DB.prepare(`UPDATE replies SET content = ?, updated_at = ? WHERE id = ?`)
    .bind(body.content, nowIso(), id)
    .run();
  return ok(c, { success: true });
});

app.delete('/:id', requireAuth, async (c) => {
  const id = c.req.param('id');
  const user = c.get('user')!;
  const reply = await c.env.DB.prepare(`SELECT id, author_id, post_id, is_deleted FROM replies WHERE id = ?`)
    .bind(id)
    .first<{ id: string; author_id: string; post_id: string; is_deleted: number }>();
  if (!reply) throw errors.notFound('回复不存在');

  const canModerate = user.role === 'admin' || user.role === 'moderator';
  if (reply.author_id !== user.id && !canModerate) throw errors.forbidden('只能删除自己的回复');
  if (reply.is_deleted) throw errors.badRequest('回复已处于删除状态');

  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE replies SET is_deleted = 1, deleted_at = ?, deleted_by = ? WHERE id = ?`).bind(
      nowIso(),
      user.id,
      id,
    ),
    c.env.DB.prepare(`UPDATE posts SET reply_count = MAX(0, reply_count - 1) WHERE id = ?`).bind(reply.post_id),
    c.env.DB.prepare(`UPDATE users SET reply_count = MAX(0, reply_count - 1) WHERE id = ?`).bind(reply.author_id),
  ]);
  return ok(c, { success: true });
});

app.post('/:id/like', requireAuth, async (c) => {
  const id = c.req.param('id');
  const user = c.get('user')!;
  const rl = await consumeRateLimit(c.env, RATE_LIMITS.like, user.id);
  if (!rl.ok) throw errors.tooMany('操作过于频繁');

  const reply = await c.env.DB.prepare(`SELECT id, author_id, post_id, is_deleted FROM replies WHERE id = ?`)
    .bind(id)
    .first<{ id: string; author_id: string; post_id: string; is_deleted: number }>();
  if (!reply || reply.is_deleted) throw errors.notFound('回复不存在');

  const res = await c.env.DB.prepare(
    `INSERT OR IGNORE INTO likes (id, user_id, target_type, target_id) VALUES (?, ?, 'reply', ?)`,
  )
    .bind(newId(16), user.id, id)
    .run();

  if ((res.meta?.changes ?? 0) > 0) {
    await c.env.DB.prepare(`UPDATE replies SET like_count = like_count + 1 WHERE id = ?`).bind(id).run();
    await bumpPostCounter(c.env, reply.post_id, 'like_count', 1);
    await createNotification(c.env, {
      userId: reply.author_id,
      actorId: user.id,
      type: 'like_reply',
      postId: reply.post_id,
      replyId: id,
      content: '有人赞了你的回复',
    });
  }
  return ok(c, { liked: true });
});

app.delete('/:id/like', requireAuth, async (c) => {
  const id = c.req.param('id');
  const user = c.get('user')!;
  const reply = await c.env.DB.prepare(`SELECT id, post_id FROM replies WHERE id = ?`)
    .bind(id)
    .first<{ id: string; post_id: string }>();
  if (!reply) throw errors.notFound('回复不存在');

  const res = await c.env.DB.prepare(
    `DELETE FROM likes WHERE user_id = ? AND target_type = 'reply' AND target_id = ?`,
  )
    .bind(user.id, id)
    .run();
  if ((res.meta?.changes ?? 0) > 0) {
    await c.env.DB.prepare(`UPDATE replies SET like_count = MAX(0, like_count - 1) WHERE id = ?`).bind(id).run();
    await bumpPostCounter(c.env, reply.post_id, 'like_count', -1);
  }
  return ok(c, { liked: false });
});

export default app;
