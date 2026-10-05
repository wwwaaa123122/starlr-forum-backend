/**
 * /api/search — 全站搜索（帖子/用户）
 * - 帖子：FTS5 trigram（≥3 字符，支持中文子串）优先，异常自动回退 LIKE
 * - 用户：用户名/昵称 LIKE
 * - 全部参数化查询 + LIKE 转义 + 限流 + 限制结果数量 + 分页
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types';
import { errors, ok } from '../lib/http';
import { parseQuery, paginationSchema, paginationMeta } from '../lib/validate';
import { RATE_LIMITS, clientFingerprint, consumeRateLimit } from '../lib/rate-limit';
import { tagsForPosts } from '../lib/queries';

const app = new Hono<AppEnv>();

const searchSchema = z.object({
  q: z.string().trim().min(1, '请输入搜索关键词').max(60, '关键词过长'),
  type: z.enum(['post', 'user']).default('post'),
  category: z.string().max(64).optional(),
  tag: z.string().max(64).optional(),
  sort: z.enum(['relevant', 'new']).default('relevant'),
  ...paginationSchema.shape,
});

/** LIKE 转义，防止通配符注入 */
function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** FTS5 短语包裹 */
function ftsPhrase(input: string): string {
  return `"${input.replace(/"/g, '""')}"`;
}

interface PostSearchRow {
  id: string;
  title: string;
  excerpt: string;
  replyCount: number;
  likeCount: number;
  createdAt: string;
  authorId: string;
  authorName: string;
  authorAvatar: string | null;
  categoryName: string;
  categorySlug: string;
}

async function searchPostsByLike(
  env: AppEnv['Bindings'],
  likeTerm: string,
  category: string | undefined,
  tag: string | undefined,
  page: number,
  pageSize: number,
) {
  const conditions = [`p.is_deleted = 0`, `(p.title LIKE ? ESCAPE '\\' OR p.content LIKE ? ESCAPE '\\')`];
  const params: unknown[] = [likeTerm, likeTerm];
  if (category) {
    conditions.push('c.slug = ?');
    params.push(category);
  }
  if (tag) {
    conditions.push(
      `EXISTS (SELECT 1 FROM post_tags ptt JOIN tags tt ON tt.id = ptt.tag_id WHERE ptt.post_id = p.id AND tt.name = ?)`,
    );
    params.push(tag);
  }
  const baseFrom = `FROM posts p JOIN users u ON u.id = p.author_id JOIN categories c ON c.id = p.category_id`;
  const countRow = await env.DB.prepare(
    `SELECT COUNT(*) AS total ${baseFrom} WHERE ${conditions.join(' AND ')}`,
  )
    .bind(...params)
    .first<{ total: number }>();
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.title, substr(p.content, 1, 200) AS excerpt,
            p.reply_count AS replyCount, p.like_count AS likeCount, p.created_at AS createdAt,
            u.id AS authorId, u.username_raw AS authorName, u.avatar_url AS authorAvatar,
            c.name AS categoryName, c.slug AS categorySlug
     ${baseFrom} WHERE ${conditions.join(' AND ')}
     ORDER BY p.last_reply_at DESC LIMIT ? OFFSET ?`,
  )
    .bind(...params, pageSize, page - 1 >= 0 ? (page - 1) * pageSize : 0)
    .all<PostSearchRow>();
  return { posts: results ?? [], total: countRow?.total ?? 0 };
}

app.get('/', async (c) => {
  const fingerprint = await clientFingerprint(c);
  const rl = await consumeRateLimit(c.env, RATE_LIMITS.search, fingerprint);
  if (!rl.ok) throw errors.tooMany('搜索过于频繁，请稍后再试');

  const { q, type, category, tag, sort, page, pageSize } = parseQuery(c, searchSchema);
  const offset = (page - 1) * pageSize;

  // ---------- 用户搜索 ----------
  if (type === 'user') {
    const like = `%${escapeLike(q)}%`;
    const countRow = await c.env.DB.prepare(
      `SELECT COUNT(*) AS total FROM users
       WHERE status = 'active' AND (username LIKE ? ESCAPE '\\' OR nickname LIKE ? ESCAPE '\\')`,
    )
      .bind(like, like)
      .first<{ total: number }>();
    const { results } = await c.env.DB.prepare(
      `SELECT id, username_raw AS username, nickname, avatar_url AS avatarUrl, bio, role,
              post_count AS postCount, reply_count AS replyCount, created_at AS createdAt
       FROM users
       WHERE status = 'active' AND (username LIKE ? ESCAPE '\\' OR nickname LIKE ? ESCAPE '\\')
       ORDER BY post_count DESC LIMIT ? OFFSET ?`,
    )
      .bind(like, like, pageSize, offset)
      .all();
    return ok(c, { users: results ?? [], pagination: paginationMeta(page, pageSize, countRow?.total ?? 0) });
  }

  // ---------- 帖子搜索 ----------
  // FTS5 trigram 仅对 ≥3 字符关键词有效；先探测可用性
  let useFts = false;
  if (q.length >= 3) {
    try {
      await c.env.DB.prepare(`SELECT rowid FROM posts_fts WHERE posts_fts MATCH ? LIMIT 1`)
        .bind(ftsPhrase(q))
        .all();
      useFts = true;
    } catch {
      useFts = false;
    }
  }

  if (useFts) {
    try {
      const conditions = [`p.is_deleted = 0`, `p.rowid IN (SELECT rowid FROM posts_fts WHERE posts_fts MATCH ?)`];
      const params: unknown[] = [ftsPhrase(q)];
      if (category) {
        conditions.push('c.slug = ?');
        params.push(category);
      }
      if (tag) {
        conditions.push(
          `EXISTS (SELECT 1 FROM post_tags ptt JOIN tags tt ON tt.id = ptt.tag_id WHERE ptt.post_id = p.id AND tt.name = ?)`,
        );
        params.push(tag);
      }
      const baseFrom = `FROM posts p JOIN users u ON u.id = p.author_id JOIN categories c ON c.id = p.category_id JOIN posts_fts fts ON fts.rowid = p.rowid`;
      const countRow = await c.env.DB.prepare(
        `SELECT COUNT(*) AS total FROM posts p JOIN categories c ON c.id = p.category_id WHERE ${conditions.join(' AND ')}`,
      )
        .bind(...params)
        .first<{ total: number }>();
      const orderBy = sort === 'new' ? 'p.created_at DESC' : 'rank';
      const { results } = await c.env.DB.prepare(
        `SELECT p.id, p.title, substr(p.content, 1, 200) AS excerpt,
                p.reply_count AS replyCount, p.like_count AS likeCount, p.created_at AS createdAt,
                u.id AS authorId, u.username_raw AS authorName, u.avatar_url AS authorAvatar,
                c.name AS categoryName, c.slug AS categorySlug
         ${baseFrom} WHERE ${conditions.join(' AND ')}
         ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      )
        .bind(...params, pageSize, offset)
        .all<PostSearchRow>();
      const rows = results ?? [];
      const tagMap = await tagsForPosts(c.env, rows.map((r) => r.id));
      return ok(c, {
        posts: rows.map((r) => ({ ...r, tags: tagMap.get(r.id) ?? [] })),
        pagination: paginationMeta(page, pageSize, countRow?.total ?? 0),
        mode: 'fts',
      });
    } catch {
      // fall through to LIKE
    }
  }

  const like = `%${escapeLike(q)}%`;
  const fallback = await searchPostsByLike(c.env, like, category, tag, page, pageSize);
  const tagMap = await tagsForPosts(c.env, fallback.posts.map((r) => r.id));
  return ok(c, {
    posts: fallback.posts.map((r) => ({ ...r, tags: tagMap.get(r.id) ?? [] })),
    pagination: paginationMeta(page, pageSize, fallback.total),
    mode: 'like',
  });
});

export default app;
