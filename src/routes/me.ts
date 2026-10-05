/** /api/me — 当前用户资料与个人数据 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types';
import { requireAuth } from '../middleware/auth';
import { errors, ok } from '../lib/http';
import { parseJson, paginationSchema, paginationMeta } from '../lib/validate';
import { nowIso } from '../lib/ids';

const app = new Hono<AppEnv>();

app.use('*', requireAuth);

app.get('/', async (c) => {
  const user = c.get('user')!;
  const profile = await c.env.DB.prepare(
    `SELECT id, username_raw AS username, nickname, email, avatar_url, bio, role, status,
            post_count, reply_count, last_login_at, created_at
     FROM users WHERE id = ?`,
  )
    .bind(user.id)
    .first<Record<string, unknown>>();
  if (!profile) throw errors.notFound();
  return ok(c, {
    user: {
      id: profile.id,
      username: profile.username,
      nickname: profile.nickname,
      email: profile.email,
      avatarUrl: profile.avatar_url,
      bio: profile.bio,
      role: profile.role,
      status: profile.status,
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
    `SELECT p.id, p.title, p.reply_count AS replyCount, p.like_count AS likeCount,
            p.created_at AS createdAt, f.created_at AS favoritedAt,
            u.username_raw AS authorName, u.id AS authorId, u.avatar_url AS authorAvatar,
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

export const meRoutes = app;
export default app;
