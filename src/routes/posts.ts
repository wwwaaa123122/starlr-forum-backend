/**
 * /api/posts — 帖子核心 API
 * 列表（分类/标签/排序/分页）、创建、详情、编辑、删除、点赞、收藏、浏览量、回复
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types';
import { errors, ok } from '../lib/http';
import { moderationScope, inScope, assertCategoryScope } from '../lib/moderation';
import { parseJson, parseQuery, paginationSchema, paginationMeta } from '../lib/validate';
import { RATE_LIMITS, clientFingerprint, consumeRateLimit } from '../lib/rate-limit';
import { assertNotMuted, requireAuth, optionalAuth, requireVerified } from '../middleware/auth';
import { newId, nowIso } from '../lib/ids';
import { bumpPostCounter, bumpUserCounter, ensureTags, tagsForPosts } from '../lib/queries';
import { createNotification, notifyMentions } from '../lib/notify';
import { sha256Hex } from '../lib/ids';

const app = new Hono<AppEnv>();

// ---------------------------------------------------------------
// 数据校验
// ---------------------------------------------------------------
const createPostSchema = z.object({
  title: z.string().trim().min(2, '标题至少 2 个字符').max(120, '标题最多 120 个字符'),
  content: z.string().trim().min(1, '正文不能为空').max(50_000, '正文过长（上限 5 万字符）'),
  categoryId: z.string().min(1).max(32),
  tags: z.array(z.string().trim().min(1).max(24)).max(5, '最多 5 个标签').optional().default([]),
});
const updatePostSchema = z.object({
  title: z.string().trim().min(2).max(120).optional(),
  content: z.string().trim().min(1).max(50_000).optional(),
  categoryId: z.string().min(1).max(32).optional(),
  tags: z.array(z.string().trim().min(1).max(24)).max(5).optional(),
});
const createReplySchema = z.object({
  content: z.string().trim().min(1, '回复内容不能为空').max(20_000, '回复过长（上限 2 万字符）'),
  parentReplyId: z.string().max(32).nullable().optional(),
});

const listQuerySchema = z.object({
  category: z.string().max(64).optional(),
  tag: z.string().max(64).optional(),
  sort: z.enum(['latest', 'new', 'hot']).default('latest'),
  author: z.string().max(32).optional(),
  ...paginationSchema.shape,
});

// ---------------------------------------------------------------
// 列表
// ---------------------------------------------------------------

// 热门标签（发布器推荐用，公开）
app.get('/tags', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT t.name, COUNT(pt.post_id) AS count
     FROM tags t JOIN post_tags pt ON pt.tag_id = t.id
     JOIN posts p ON p.id = pt.post_id AND p.is_deleted = 0
     GROUP BY t.id ORDER BY count DESC, t.name ASC LIMIT 12`,
  ).all();
  return ok(c, { tags: results ?? [] });
});

app.get('/', async (c) => {
  const q = parseQuery(c, listQuerySchema);
  const offset = (q.page - 1) * q.pageSize;

  const where: string[] = ['p.is_deleted = 0'];
  const joins: string[] = [];
  const params: unknown[] = [];

  if (q.category) {
    where.push('c.slug = ?');
    params.push(q.category);
  }
  if (q.tag) {
    joins.push('JOIN post_tags ptf ON ptf.post_id = p.id JOIN tags tf ON tf.id = ptf.tag_id');
    where.push('tf.name = ?');
    params.push(q.tag);
  }
  if (q.author) {
    where.push('u.username = ?');
    params.push(q.author.toLowerCase());
  }

  const orderBy =
    q.sort === 'new'
      ? 'p.is_pinned DESC, p.created_at DESC'
      : q.sort === 'hot'
        ? `p.is_pinned DESC, ((p.like_count * 3 + p.reply_count * 2 + p.favorite_count * 2 + p.view_count / 10.0 + 1) / pow(MAX((julianday('now') - julianday(p.created_at)) * 24.0, 0.5), 1.2)) DESC, p.last_reply_at DESC`
        : 'p.is_pinned DESC, COALESCE(p.last_reply_at, p.created_at) DESC';

  const baseFrom = `FROM posts p JOIN users u ON u.id = p.author_id JOIN categories c ON c.id = p.category_id ${joins.join(' ')}`;

  const countRow = await c.env.DB.prepare(`SELECT COUNT(*) AS total ${baseFrom} WHERE ${where.join(' AND ')}`)
    .bind(...params)
    .first<{ total: number }>();

  const { results } = await c.env.DB.prepare(
    `SELECT p.id, p.title, p.is_pinned AS isPinned, p.is_featured AS isFeatured, p.edited_at AS editedAt,
            p.view_count AS viewCount, p.reply_count AS replyCount, p.like_count AS likeCount,
            p.favorite_count AS favoriteCount, p.created_at AS createdAt, p.updated_at AS updatedAt,
            p.last_reply_at AS lastReplyAt,
            substr(p.content, 1, 200) AS excerpt,
            u.id AS authorId, u.uid AS authorUid, u.username_raw AS authorName, u.nickname AS authorNickname, u.avatar_url AS authorAvatar, u.role AS authorRole,
            c.id AS categoryId, c.name AS categoryName, c.slug AS categorySlug
     ${baseFrom}
     WHERE ${where.join(' AND ')}
     ORDER BY ${orderBy}
     LIMIT ? OFFSET ?`,
  )
    .bind(...params, q.pageSize, offset)
    .all();

  const rows = results ?? [];
  const tagMap = await tagsForPosts(c.env, rows.map((r) => r.id as string));
  const posts = rows.map((r) => ({ ...r, tags: tagMap.get(r.id as string) ?? [] }));

  return ok(c, { posts, pagination: paginationMeta(q.page, q.pageSize, countRow?.total ?? 0) });
});

// ---------------------------------------------------------------
// 发帖
// ---------------------------------------------------------------
app.post('/', requireAuth, requireVerified, async (c) => {
  await assertNotMuted(c);
  const user = c.get('user')!;

  const fingerprint = await clientFingerprint(c);
  const rl = await consumeRateLimit(c.env, RATE_LIMITS.createPost, user.id + ':' + fingerprint.slice(0, 8));
  if (!rl.ok) throw errors.tooMany('发帖过于频繁，请稍后再试');

  const body = await parseJson(c, createPostSchema);

  const category = await c.env.DB.prepare(`SELECT id, post_policy AS postPolicy FROM categories WHERE id = ? OR slug = ?`)
    .bind(body.categoryId, body.categoryId)
    .first<{ id: string; postPolicy: string }>();
  if (!category) throw errors.badRequest('分类不存在', 'CATEGORY_NOT_FOUND');
  if (category.postPolicy === 'staff' && !['moderator', 'admin'].includes(user.role)) {
    throw errors.forbidden('该版块仅限版主及以上发布');
  }

  // 标签去重与规范化
  const tagNames = [...new Set(body.tags.map((t) => t.trim()).filter(Boolean))].slice(0, 5);
  const postId = newId(16);

  const tagMap = await ensureTags(c.env, tagNames);
  const postTagStmt = c.env.DB.prepare(
    `INSERT OR IGNORE INTO post_tags (post_id, tag_id) VALUES (?, ?)`,
  );
  const tagBatches = tagNames
    .map((name) => tagMap.get(name))
    .filter((id): id is string => Boolean(id))
    .map((tagId) => postTagStmt.bind(postId, tagId));

  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO posts (id, category_id, author_id, title, content, created_at, updated_at, last_reply_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(postId, category.id, user.id, body.title, body.content, nowIso(), nowIso(), nowIso()),
    ...tagBatches,
    c.env.DB.prepare(`UPDATE categories SET post_count = post_count + 1 WHERE id = ?`).bind(category.id),
    c.env.DB.prepare(`UPDATE users SET post_count = post_count + 1 WHERE id = ?`).bind(user.id),
  ]);

  // @ 提及通知（限制单帖最多 5 个）
  await notifyMentions(c.env, body.content, { actorId: user.id, postId });

  // SEO：百度主动推送新帖 URL（未配置 token 时静默跳过，不阻塞发帖）
  // c.executionCtx 仅在真实 Worker fetch 环境存在；app.request()（vitest）没有
  // ExecutionContext 会抛错，这里兜住并跳过推送，保证发帖主流程不受影响。
  try {
    c.executionCtx.waitUntil(
      (async () => {
        const { pushPostUrl } = await import('../lib/seo-push');
        await pushPostUrl(c.env, postId);
      })().catch(() => undefined),
    );
  } catch {
    /* 无 ExecutionContext（测试环境）：跳过推送 */
  }

  return ok(c, { id: postId }, { status: 201 });
});

// ---------------------------------------------------------------
// 帖子详情（挂在 /:id 之前定义的子路径不受影响）
// ---------------------------------------------------------------
app.get('/:id', optionalAuth, async (c) => {
  const id = c.req.param('id');
  const user = c.get('user');

  const post = await c.env.DB.prepare(
    `SELECT p.id, p.title, p.content, p.is_pinned AS isPinned, p.is_featured AS isFeatured,
            p.is_deleted AS isDeleted, p.edited_at AS editedAt,
            p.view_count AS viewCount, p.reply_count AS replyCount,
            p.like_count AS likeCount, p.favorite_count AS favoriteCount,
            p.created_at AS createdAt, p.updated_at AS updatedAt, p.last_reply_at AS lastReplyAt,
            u.id AS authorId, u.uid AS authorUid, u.username_raw AS authorName, u.nickname AS authorNickname, u.username AS authorUsername,
            u.avatar_url AS authorAvatar, u.role AS authorRole,
            c.id AS categoryId, c.name AS categoryName, c.slug AS categorySlug
     FROM posts p JOIN users u ON u.id = p.author_id JOIN categories c ON c.id = p.category_id
     WHERE p.id = ?`,
  )
    .bind(id)
    .first<Record<string, unknown>>();

  if (!post) throw errors.notFound('帖子不存在');
  const isDeleted = Boolean(post.isDeleted);
  const isAuthor = user && user.id === post.authorId;
  // 已删除内容：仅管理员与所辖版块的版主可见（供恢复/复核）；作者与其他人一律 404
  let canModerate = Boolean(user && user.role === 'admin');
  if (!canModerate && user && user.role === 'moderator') {
    const scope = await moderationScope(c.env, user);
    canModerate = inScope(scope, post.categoryId as string);
  }
  if (isDeleted && !canModerate) throw errors.notFound('帖子不存在');

  const { results: tagRows } = await c.env.DB.prepare(
    `SELECT t.name FROM post_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.post_id = ?`,
  )
    .bind(id)
    .all<{ name: string }>();

  let liked = false;
  let favorited = false;
  if (user) {
    const flags = await c.env.DB.batch([
      c.env.DB.prepare(`SELECT 1 AS x FROM likes WHERE user_id = ? AND target_type = 'post' AND target_id = ?`).bind(user.id, id),
      c.env.DB.prepare(`SELECT 1 AS x FROM favorites WHERE user_id = ? AND post_id = ?`).bind(user.id, id),
    ]);
    liked = (flags[0].results?.length ?? 0) > 0;
    favorited = (flags[1].results?.length ?? 0) > 0;
  }

  return ok(c, {
    post: {
      ...post,
      isDeleted: isDeleted,
      tags: tagRows ?? [],
      liked,
      favorited,
      isAuthor: Boolean(isAuthor),
      canModerate: Boolean(canModerate),
    },
  });
});

// ---------------------------------------------------------------
// 编辑
// ---------------------------------------------------------------
app.patch('/:id', requireAuth, async (c) => {
  const id = c.req.param('id');
  const user = c.get('user')!;
  // 与创建帖子一致：禁言用户不得编辑内容（含编辑自己的帖子）
  await assertNotMuted(c);
  const body = await parseJson(c, updatePostSchema);

  const post = await c.env.DB.prepare(`SELECT id, author_id, category_id, is_deleted FROM posts WHERE id = ?`)
    .bind(id)
    .first<{ id: string; author_id: string; category_id: string; is_deleted: number }>();
  if (!post || post.is_deleted) throw errors.notFound('帖子不存在');

  const canModerate = user.role === 'admin' || user.role === 'moderator';
  if (post.author_id !== user.id && !canModerate) throw errors.forbidden('只能编辑自己的帖子');
  // 版主代编辑需辖区校验：admin 全站放行，moderator 仅限所辖版块（作者本人编辑自己帖子不受此限）
  if (post.author_id !== user.id) await assertCategoryScope(c.env, user, post.category_id);

  const sets: string[] = [];
  const values: unknown[] = [];
  if (body.title !== undefined) {
    sets.push('title = ?');
    values.push(body.title);
  }
  if (body.content !== undefined) {
    sets.push('content = ?');
    values.push(body.content);
  }
  if (body.categoryId !== undefined) {
    const targetPolicy = await c.env.DB.prepare(`SELECT post_policy AS postPolicy FROM categories WHERE id = ? OR slug = ?`)
      .bind(body.categoryId, body.categoryId)
      .first<{ postPolicy: string }>();
    if (targetPolicy?.postPolicy === 'staff' && !['moderator', 'admin'].includes(user.role)) {
      throw errors.forbidden('该版块仅限版主及以上发布');
    }
    const category = await c.env.DB.prepare(`SELECT id FROM categories WHERE id = ? OR slug = ?`)
      .bind(body.categoryId, body.categoryId)
      .first<{ id: string }>();
    if (!category) throw errors.badRequest('分类不存在', 'CATEGORY_NOT_FOUND');
    sets.push('category_id = ?');
    values.push(category.id);
  }
  if (sets.length === 0) throw errors.badRequest('没有需要更新的字段');
  sets.push('updated_at = ?');
  sets.push('edited_at = ?');
  values.push(nowIso(), nowIso(), id);
  await c.env.DB.prepare(`UPDATE posts SET ${sets.join(', ')} WHERE id = ?`).bind(...values).run();

  if (body.tags !== undefined) {
    const tagNames = [...new Set(body.tags.map((t) => t.trim()).filter(Boolean))].slice(0, 5);
    await c.env.DB.prepare(`DELETE FROM post_tags WHERE post_id = ?`).bind(id).run();
    const tagMap = await ensureTags(c.env, tagNames);
    const stmt = c.env.DB.prepare(`INSERT OR IGNORE INTO post_tags (post_id, tag_id) VALUES (?, ?)`);
    const batches = tagNames
      .map((n) => tagMap.get(n))
      .filter((v): v is string => Boolean(v))
      .map((tagId) => stmt.bind(id, tagId));
    if (batches.length > 0) await c.env.DB.batch(batches);
  }

  return ok(c, { success: true });
});

// ---------------------------------------------------------------
// 删除（作者 / 管理员；软删除，管理员可恢复）
// ---------------------------------------------------------------
app.delete('/:id', requireAuth, async (c) => {
  const id = c.req.param('id');
  const user = c.get('user')!;
  const post = await c.env.DB.prepare(`SELECT id, author_id, category_id, is_deleted FROM posts WHERE id = ?`)
    .bind(id)
    .first<{ id: string; author_id: string; category_id: string; is_deleted: number }>();
  if (!post) throw errors.notFound('帖子不存在');

  const canModerate = user.role === 'admin' || user.role === 'moderator';
  if (post.author_id !== user.id && !canModerate) throw errors.forbidden('只能删除自己的帖子');
  // 版主代删需辖区校验：admin 全站放行，moderator 仅限所辖版块（作者本人删帖不受此限）
  if (post.author_id !== user.id) await assertCategoryScope(c.env, user, post.category_id);
  if (post.is_deleted) throw errors.badRequest('帖子已处于删除状态');

  await c.env.DB.prepare(
    `UPDATE posts SET is_deleted = 1, deleted_at = ?, deleted_by = ? WHERE id = ?`,
  )
    .bind(nowIso(), user.id, id)
    .run();
  return ok(c, { success: true });
});

// ---------------------------------------------------------------
// 浏览量（KV 去重：同一访客 1 小时内只计 1 次，防刷）
// ---------------------------------------------------------------
app.post('/:id/view', async (c) => {
  const id = c.req.param('id');
  const fingerprint = await clientFingerprint(c);
  // 匿名端点且每次可能产生 1 次 KV 写 + 1 次 D1 插入：按 IP 限流（与其他端点一致返回 429）
  const rl = await consumeRateLimit(c.env, RATE_LIMITS.view, fingerprint);
  if (!rl.ok) throw errors.tooMany('浏览请求过于频繁，请稍后再试');

  const dedupeKey = `view:${id}:${fingerprint}`;
  const seen = await c.env.CACHE.get(dedupeKey);
  if (seen) return ok(c, { counted: false });

  const post = await c.env.DB.prepare(`SELECT id FROM posts WHERE id = ? AND is_deleted = 0`)
    .bind(id)
    .first<{ id: string }>();
  if (!post) throw errors.notFound('帖子不存在');

  await c.env.CACHE.put(dedupeKey, '1', { expirationTtl: 3600 });
  await bumpPostCounter(c.env, id, 'view_count', 1);

  // 浏览事件（供管理后台「浏览统计」）：Cloudflare IP 库地理 + 粗粒度设备类型
  const cf = (c.req.raw as unknown as { cf?: IncomingRequestCfProperties }).cf;
  const ua = c.req.header('user-agent') ?? '';
  const device = /iPad|Tablet/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))
    ? 'tablet'
    : /Mobi/i.test(ua)
      ? 'mobile'
      : 'desktop';
  const viewer = c.get('user');
  const cleanup = Math.random() < 0.01
    ? [c.env.DB.prepare(`DELETE FROM view_events WHERE created_at < datetime('now','-30 days')`)]
    : [];
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO view_events (id, post_id, user_id, country, city, colo, device) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(newId(20), id, viewer?.id ?? null, (cf?.country as string) ?? '', (cf?.city as string) ?? '', (cf?.colo as string) ?? '', device),
    ...cleanup,
  ]);
  return ok(c, { counted: true });
});

// ---------------------------------------------------------------
// 点赞（唯一约束 + 计数联动 + 通知，服务端验证）
// ---------------------------------------------------------------
const likeTargetSchema = z.object({ action: z.enum(['like', 'unlike']).default('like') });

app.post('/:id/like', requireAuth, async (c) => {
  const id = c.req.param('id');
  const user = c.get('user')!;
  const rl = await consumeRateLimit(c.env, RATE_LIMITS.like, user.id);
  if (!rl.ok) throw errors.tooMany('操作过于频繁');

  const post = await c.env.DB.prepare(`SELECT id, author_id, is_deleted FROM posts WHERE id = ?`)
    .bind(id)
    .first<{ id: string; author_id: string; is_deleted: number }>();
  if (!post || post.is_deleted) throw errors.notFound('帖子不存在');

  const res = await c.env.DB.prepare(
    `INSERT OR IGNORE INTO likes (id, user_id, target_type, target_id) VALUES (?, ?, 'post', ?)`,
  )
    .bind(newId(16), user.id, id)
    .run();

  if ((res.meta?.changes ?? 0) > 0) {
    await bumpPostCounter(c.env, id, 'like_count', 1);
    await createNotification(c.env, {
      userId: post.author_id,
      actorId: user.id,
      type: 'like',
      postId: id,
      content: '有人赞了你的帖子',
    });
    return ok(c, { liked: true, likeCount: await currentLikeCount(c.env, id) });
  }
  return ok(c, { liked: true, already: true, likeCount: await currentLikeCount(c.env, id) });
});

app.delete('/:id/like', requireAuth, async (c) => {
  const id = c.req.param('id');
  const user = c.get('user')!;
  const res = await c.env.DB.prepare(
    `DELETE FROM likes WHERE user_id = ? AND target_type = 'post' AND target_id = ?`,
  )
    .bind(user.id, id)
    .run();
  if ((res.meta?.changes ?? 0) > 0) {
    await bumpPostCounter(c.env, id, 'like_count', -1);
  }
  return ok(c, { liked: false, likeCount: await currentLikeCount(c.env, id) });
});

/** 读取帖子当前点赞数（响应返回权威值，前端据此更新缓存） */
async function currentLikeCount(env: AppEnv['Bindings'], postId: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT like_count FROM posts WHERE id = ?`).bind(postId).first<{ like_count: number }>();
  return row?.like_count ?? 0;
}

// ---------------------------------------------------------------
// 收藏
// ---------------------------------------------------------------
app.post('/:id/favorite', requireAuth, async (c) => {
  const id = c.req.param('id');
  const user = c.get('user')!;
  const post = await c.env.DB.prepare(`SELECT id, author_id, is_deleted FROM posts WHERE id = ?`)
    .bind(id)
    .first<{ id: string; author_id: string; is_deleted: number }>();
  if (!post || post.is_deleted) throw errors.notFound('帖子不存在');

  const res = await c.env.DB.prepare(`INSERT OR IGNORE INTO favorites (id, user_id, post_id) VALUES (?, ?, ?)`)
    .bind(newId(16), user.id, id)
    .run();

  if ((res.meta?.changes ?? 0) > 0) {
    await bumpPostCounter(c.env, id, 'favorite_count', 1);
    await createNotification(c.env, {
      userId: post.author_id,
      actorId: user.id,
      type: 'favorite',
      postId: id,
      content: '有人收藏了你的帖子',
    });
    return ok(c, { favorited: true });
  }
  return ok(c, { favorited: true, already: true });
});

app.delete('/:id/favorite', requireAuth, async (c) => {
  const id = c.req.param('id');
  const user = c.get('user')!;
  const res = await c.env.DB.prepare(`DELETE FROM favorites WHERE user_id = ? AND post_id = ?`)
    .bind(user.id, id)
    .run();
  if ((res.meta?.changes ?? 0) > 0) {
    await bumpPostCounter(c.env, id, 'favorite_count', -1);
  }
  return ok(c, { favorited: false });
});

// ---------------------------------------------------------------
// 回复（含引用/楼中楼）
// ---------------------------------------------------------------
app.get('/:id/replies', async (c) => {
  const id = c.req.param('id');
  const { page, pageSize } = paginationSchema.parse(Object.fromEntries(new URL(c.req.url).searchParams));
  const offset = (page - 1) * pageSize;

  const post = await c.env.DB.prepare(`SELECT id, is_deleted FROM posts WHERE id = ?`)
    .bind(id)
    .first<{ id: string; is_deleted: number }>();
  if (!post) throw errors.notFound('帖子不存在');

  const countRow = await c.env.DB.prepare(
    `SELECT COUNT(*) AS total FROM replies WHERE post_id = ? AND is_deleted = 0`,
  )
    .bind(id)
    .first<{ total: number }>();

  const currentUserId = c.get('user')?.id ?? '';
  const likedExpr = currentUserId
    ? `EXISTS(SELECT 1 FROM likes l WHERE l.target_type = 'reply' AND l.target_id = r.id AND l.user_id = ?) AS liked`
    : '0 AS liked';
  const likedParam = currentUserId ? [currentUserId] : [];
  const { results } = await c.env.DB.prepare(
    `SELECT r.id, r.content, r.parent_id AS parentReplyId, r.reply_to_user_id AS replyToUserId,
            r.like_count AS likeCount, r.created_at AS createdAt, r.updated_at AS updatedAt,
            r.edited_at AS editedAt,
            u.id AS authorId, u.uid AS authorUid, u.username_raw AS authorName, u.nickname AS authorNickname, u.avatar_url AS authorAvatar, u.role AS authorRole,
            ru.username_raw AS replyToUserName,
            ${likedExpr}
     FROM replies r
     JOIN users u ON u.id = r.author_id
     LEFT JOIN users ru ON ru.id = r.reply_to_user_id
     WHERE r.post_id = ? AND r.is_deleted = 0
     ORDER BY r.created_at ASC LIMIT ? OFFSET ?`,
  )
    .bind(...likedParam, id, pageSize, offset)
    .all();

  return ok(c, { replies: results ?? [], pagination: paginationMeta(page, pageSize, countRow?.total ?? 0) });
});

app.post('/:id/replies', requireAuth, requireVerified, async (c) => {
  await assertNotMuted(c);
  const user = c.get('user')!;
  const id = c.req.param('id');

  const fingerprint = await clientFingerprint(c);
  const rl = await consumeRateLimit(c.env, RATE_LIMITS.createReply, user.id + ':' + fingerprint.slice(0, 8));
  if (!rl.ok) throw errors.tooMany('回复过于频繁，请稍后再试');

  const body = await parseJson(c, createReplySchema);

  const post = await c.env.DB.prepare(
    `SELECT id, author_id, is_deleted FROM posts WHERE id = ?`,
  )
    .bind(id)
    .first<{ id: string; author_id: string; is_deleted: number }>();
  if (!post || post.is_deleted) throw errors.notFound('帖子不存在或已删除');

  let replyToUserId: string | null = null;
  let parentReplyId: string | null = null;
  if (body.parentReplyId) {
    const parent = await c.env.DB.prepare(
      `SELECT id, author_id, post_id, is_deleted FROM replies WHERE id = ?`,
    )
      .bind(body.parentReplyId)
      .first<{ id: string; author_id: string; post_id: string; is_deleted: number }>();
    if (!parent || parent.post_id !== id || parent.is_deleted) {
      throw errors.badRequest('引用的回复不存在', 'REPLY_NOT_FOUND');
    }
    parentReplyId = parent.id;
    replyToUserId = parent.author_id;
  }

  const replyId = newId(16);
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO replies (id, post_id, author_id, parent_id, reply_to_user_id, content, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(replyId, id, user.id, parentReplyId, replyToUserId, body.content, nowIso(), nowIso()),
    c.env.DB.prepare(
      `UPDATE posts SET reply_count = reply_count + 1, last_reply_at = ? WHERE id = ?`,
    ).bind(nowIso(), id),
    c.env.DB.prepare(`UPDATE users SET reply_count = reply_count + 1 WHERE id = ?`).bind(user.id),
  ]);

  // 通知：帖子作者（有人回复）+ 引用对象作者（有人回复了你）+ @ 提及
  await createNotification(c.env, {
    userId: post.author_id,
    actorId: user.id,
    type: 'reply',
    postId: id,
    replyId,
    content: body.content.slice(0, 100),
  });
  if (replyToUserId && replyToUserId !== post.author_id) {
    await createNotification(c.env, {
      userId: replyToUserId,
      actorId: user.id,
      type: 'reply_reply',
      postId: id,
      replyId,
      content: body.content.slice(0, 100),
    });
  }
  await notifyMentions(c.env, body.content, { actorId: user.id, postId: id, replyId });

  return ok(c, { id: replyId }, { status: 201 });
});

export default app;
