/** /api/users/:username — 公开用户主页 */
import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { errors, ok } from '../lib/http';
import { paginationSchema, paginationMeta } from '../lib/validate';

const app = new Hono<AppEnv>();

async function findUser(c: { env: AppEnv['Bindings'] }, username: string) {
  return c.env.DB.prepare(
    `SELECT id, uid, username, username_raw, nickname, avatar_url, bio, role, status,
            post_count, reply_count, created_at
     FROM users WHERE username = ? OR username_raw = ? LIMIT 1`,
  )
    .bind(username.toLowerCase(), username)
    .first<Record<string, unknown>>();
}

app.get('/:username', async (c) => {
  const username = c.req.param('username');
  const user = await findUser(c, username);
  if (!user) throw errors.notFound('用户不存在');
  if (user.status === 'banned' && c.get('user')?.role !== 'admin') {
    return ok(c, { user: { username: user.username_raw, nickname: '该用户已被封禁', banned: true } });
  }
  return ok(c, {
    user: {
      id: user.id,
      uid: user.uid ?? null,
      username: user.username_raw,
      nickname: user.nickname,
      avatarUrl: user.avatar_url,
      bio: user.bio,
      role: user.role,
      postCount: user.post_count,
      replyCount: user.reply_count,
      createdAt: user.created_at,
      banned: user.status === 'banned',
    },
  });
});

app.get('/:username/posts', async (c) => {
  const username = c.req.param('username');
  const user = await findUser(c, username);
  if (!user) throw errors.notFound('用户不存在');
  const { page, pageSize } = paginationSchema.parse(Object.fromEntries(new URL(c.req.url).searchParams));
  const offset = (page - 1) * pageSize;

  const countRow = await c.env.DB.prepare(
    `SELECT COUNT(*) AS total FROM posts WHERE author_id = ? AND is_deleted = 0`,
  )
    .bind(user.id as string)
    .first<{ total: number }>();
  const { results } = await c.env.DB.prepare(
    `SELECT p.id, p.title, substr(p.content, 1, 160) AS excerpt,
            p.reply_count AS replyCount, p.like_count AS likeCount, p.view_count AS viewCount,
            p.created_at AS createdAt, p.is_pinned AS isPinned, p.is_featured AS isFeatured,
            c.name AS categoryName, c.slug AS categorySlug,
            u.username_raw AS authorName, u.nickname AS authorNickname,
            u.avatar_url AS authorAvatar, u.uid AS authorUid, u.role AS authorRole
     FROM posts p
     JOIN categories c ON c.id = p.category_id
     JOIN users u ON u.id = p.author_id
     WHERE p.author_id = ? AND p.is_deleted = 0
     ORDER BY p.created_at DESC LIMIT ? OFFSET ?`,
  )
    .bind(user.id as string, pageSize, offset)
    .all();
  return ok(c, { posts: results ?? [], pagination: paginationMeta(page, pageSize, countRow?.total ?? 0) });
});

app.get('/:username/replies', async (c) => {
  const username = c.req.param('username');
  const user = await findUser(c, username);
  if (!user) throw errors.notFound('用户不存在');
  const { page, pageSize } = paginationSchema.parse(Object.fromEntries(new URL(c.req.url).searchParams));
  const offset = (page - 1) * pageSize;

  const countRow = await c.env.DB.prepare(
    `SELECT COUNT(*) AS total FROM replies WHERE author_id = ? AND is_deleted = 0`,
  )
    .bind(user.id as string)
    .first<{ total: number }>();
  const { results } = await c.env.DB.prepare(
    `SELECT r.id, r.content, r.created_at AS createdAt, r.post_id AS postId,
            p.title AS postTitle, p.is_deleted AS postDeleted
     FROM replies r JOIN posts p ON p.id = r.post_id
     WHERE r.author_id = ? AND r.is_deleted = 0 AND p.is_deleted = 0
     ORDER BY r.created_at DESC LIMIT ? OFFSET ?`,
  )
    .bind(user.id as string, pageSize, offset)
    .all();
  return ok(c, { replies: results ?? [], pagination: paginationMeta(page, pageSize, countRow?.total ?? 0) });
});

export default app;
