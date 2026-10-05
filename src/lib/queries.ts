/** 共享查询助手：避免列表页 N+1（两次查询取回整页标签） */
import type { Env } from '../types';

export interface PostRow {
  id: string;
  title: string;
  content?: string;
  isPinned: number;
  isFeatured: number;
  viewCount: number;
  replyCount: number;
  likeCount: number;
  favoriteCount: number;
  createdAt: string;
  updatedAt: string;
  lastReplyAt: string | null;
  authorId: string;
  authorName: string;
  authorAvatar: string | null;
  categoryId: string;
  categoryName: string;
  categorySlug: string;
}

/** 为一批帖子批量取标签，返回 postId → tags[] 映射 */
export async function tagsForPosts(
  env: Env,
  postIds: string[],
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (postIds.length === 0) return map;
  const placeholders = postIds.map(() => '?').join(',');
  const { results } = await env.DB.prepare(
    `SELECT pt.post_id, t.name FROM post_tags pt JOIN tags t ON t.id = pt.tag_id
     WHERE pt.post_id IN (${placeholders})`,
  )
    .bind(...postIds)
    .all<{ post_id: string; name: string }>();
  for (const row of results ?? []) {
    const list = map.get(row.post_id) ?? [];
    list.push(row.name);
    map.set(row.post_id, list);
  }
  return map;
}

/** 标签名 → tag id（不存在则创建；批量） */
export async function ensureTags(env: Env, names: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (names.length === 0) return map;
  for (const name of names) {
    await env.DB.prepare(
      `INSERT INTO tags (id, name) VALUES (?, ?) ON CONFLICT(name) DO NOTHING`,
    )
      .bind(newIdInternal(), name)
      .run();
  }
  const placeholders = names.map(() => '?').join(',');
  const { results } = await env.DB.prepare(`SELECT id, name FROM tags WHERE name IN (${placeholders})`)
    .bind(...names)
    .all<{ id: string; name: string }>();
  for (const row of results ?? []) map.set(row.name, row.id);
  return map;
}

function newIdInternal(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
  let out = '';
  for (let i = 0; i < 16; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

/** 调整帖子计数字段（点赞/收藏/回复数），保证不小于 0 */
export async function bumpPostCounter(
  env: Env,
  postId: string,
  field: 'like_count' | 'favorite_count' | 'reply_count' | 'view_count',
  delta: number,
): Promise<void> {
  if (field === 'view_count') {
    await env.DB.prepare(`UPDATE posts SET view_count = view_count + ? WHERE id = ?`).bind(delta, postId).run();
    return;
  }
  await env.DB.prepare(
    `UPDATE posts SET ${field} = MAX(0, ${field} + ?) WHERE id = ?`,
  )
    .bind(delta, postId)
    .run();
}

/** 调整用户发帖/回复计数 */
export async function bumpUserCounter(
  env: Env,
  userId: string,
  field: 'post_count' | 'reply_count',
  delta: number,
): Promise<void> {
  await env.DB.prepare(`UPDATE users SET ${field} = MAX(0, ${field} + ?) WHERE id = ?`)
    .bind(delta, userId)
    .run();
}
