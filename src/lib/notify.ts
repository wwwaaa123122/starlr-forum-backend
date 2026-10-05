/** 通知创建与 @ 提及解析入库 */
import type { Env } from '../types';
import { extractMentions } from './mentions';
import { newId, nowIso } from './ids';

export type NotificationType =
  | 'reply'
  | 'reply_reply'
  | 'mention'
  | 'like'
  | 'like_reply'
  | 'favorite'
  | 'system'
  | 'moderation';

export interface CreateNotificationInput {
  userId: string;
  actorId?: string | null;
  type: NotificationType;
  postId?: string | null;
  replyId?: string | null;
  content?: string | null;
}

/** 创建单条通知（不发给自己） */
export async function createNotification(env: Env, input: CreateNotificationInput): Promise<void> {
  if (input.actorId && input.actorId === input.userId) return;
  await env.DB.prepare(
    `INSERT INTO notifications (id, user_id, actor_id, type, post_id, reply_id, content, is_read, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
  )
    .bind(
      newId(16),
      input.userId,
      input.actorId ?? null,
      input.type,
      input.postId ?? null,
      input.replyId ?? null,
      (input.content ?? '').slice(0, 200),
      nowIso(),
    )
    .run();
}

/**
 * 解析内容中的 @用户名 并批量创建通知。
 * 参数化查询，单条内容最多 MAX_MENTIONS 个；批量 INSERT 避免 N+1。
 */
export async function notifyMentions(
  env: Env,
  content: string,
  opts: { actorId: string; postId: string; replyId?: string | null },
): Promise<void> {
  const names = extractMentions(content);
  if (names.length === 0) return;

  const placeholders = names.map(() => '?').join(',');
  const { results } = await env.DB.prepare(
    `SELECT id, username FROM users WHERE username IN (${placeholders}) AND status = 'active'`,
  )
    .bind(...names)
    .all<{ id: string; username: string }>();
  if (!results || results.length === 0) return;

  const stmt = env.DB.prepare(
    `INSERT INTO notifications (id, user_id, actor_id, type, post_id, reply_id, content, is_read, created_at)
     VALUES (?, ?, ?, 'mention', ?, ?, ?, 0, ?)`,
  );
  const batch = results
    .filter((u) => u.id !== opts.actorId)
    .map((u) =>
      stmt.bind(newId(16), u.id, opts.actorId, opts.postId, opts.replyId ?? null, content.slice(0, 200), nowIso()),
    );
  if (batch.length > 0) await env.DB.batch(batch);
}
