/**
 * 版主权限：按版块（category）授权。
 * - admin：全站管辖
 * - moderator：仅 moderators 表中分配的版块；一个版块都没有 = 后台看不到任何内容
 * - 用户处置（禁言/封禁）只能经由所辖版块的举报发起，独立入口仅管理员可用
 */
import type { Env } from '../types';
import { errors } from './http';

export type ModerationScope = string[] | '*';

export async function moderationScope(env: Env, user: { id: string; role: string }): Promise<ModerationScope> {
  if (user.role === 'admin') return '*';
  const { results } = await env.DB.prepare(`SELECT category_id AS cid FROM moderators WHERE user_id = ?`)
    .bind(user.id)
    .all<{ cid: string }>();
  return (results ?? []).map((r) => r.cid);
}

export function inScope(scope: ModerationScope, categoryId: string | null | undefined): boolean {
  if (scope === '*') return true;
  return Boolean(categoryId) && scope.includes(categoryId as string);
}

export async function assertCategoryScope(
  env: Env,
  user: { id: string; role: string },
  categoryId: string | null | undefined,
): Promise<void> {
  const scope = await moderationScope(env, user);
  if (!inScope(scope, categoryId)) throw errors.forbidden('该内容不在你负责的版块内');
}

/** 版主删除内容时的通知措辞 */
export function moderatorLabel(role: string): string {
  return role === 'admin' ? '管理员' : '版主';
}
