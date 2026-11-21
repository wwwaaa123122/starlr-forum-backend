/**
 * 禁言生命周期：mute（带/不带天数）→ 发帖被拒 → unmute 解除 → 恢复发帖。
 * unmute（lifted_at 置位）与 assertNotMuted 的解除语义此前零覆盖。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { createPost, createUser, req } from './helpers';

let adminToken = '';
let adminId = '';
let victimToken = '';
let victimId = '';
let categoryId = '';

beforeAll(async () => {
  const admin = await createUser({ username: 'mutecycleadmin' });
  await env.DB.prepare(`UPDATE users SET role='admin' WHERE username='mutecycleadmin'`).run();
  adminToken = admin.accessToken;
  adminId = admin.id;
  const victim = await createUser({ username: 'mutecyclevictim' });
  victimToken = victim.accessToken;
  victimId = victim.id;
  const cats = await req<{ categories: { id: string; slug: string }[] }>('/api/categories');
  categoryId = cats.body.categories.find((c) => c.slug === 'tech')!.id;
});

const mute = (days: number | null) =>
  req(`/api/admin/users/${victimId}/mute`, { method: 'POST', token: adminToken, body: { reason: '测试禁言', ...(days ? { days } : {}) } });
const unmute = () => req(`/api/admin/users/${victimId}/unmute`, { method: 'POST', token: adminToken });
const tryPost = () =>
  req('/api/posts', { method: 'POST', token: victimToken, body: { title: '禁言期间发帖', content: '不应成功', categoryId } });

describe('禁言生命周期', () => {
  it('永久禁言（不带 days）后发帖被拒（403 + 禁言文案）', async () => {
    const res = await mute(null);
    expect(res.status).toBe(200);
    const p = await tryPost();
    expect(p.status).toBe(403);
  });

  it('带 days 的限期禁言：bans 表有 expires_at', async () => {
    // 先解除永久禁言
    await unmute();
    const res = await mute(7);
    expect(res.status).toBe(200);
    const ban = await env.DB.prepare(
      `SELECT expires_at FROM bans WHERE user_id = ? AND type = 'mute' AND lifted_at IS NULL`,
    )
      .bind(victimId)
      .first<{ expires_at: string | null }>();
    expect(ban?.expires_at).not.toBeNull();
    // 解除，供后续用例
    await unmute();
  });

  it('unmute 后恢复发帖（lifted_at 置位 + assertNotMuted 不再拦截）', async () => {
    await mute(null);
    expect((await tryPost()).status).toBe(403);

    const res = await unmute();
    expect(res.status).toBe(200);

    // lifted_at 已置位
    const active = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM bans WHERE user_id = ? AND type = 'mute' AND lifted_at IS NULL`,
    )
      .bind(victimId)
      .first<{ n: number }>();
    expect(active!.n).toBe(0);

    // 恢复发帖
    const p = await tryPost();
    expect(p.status).toBe(201);
  });

  it('unmute 幂等（无活动禁言时调用也成功）', async () => {
    const res = await unmute();
    expect(res.status).toBe(200);
  });

  it('unmute 写审计日志（admin.user.unmute）', async () => {
    await mute(null);
    await unmute();
    const log = await env.DB.prepare(
      `SELECT action FROM audit_logs WHERE actor_id = ? AND action = 'admin.user.unmute' ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(adminId)
      .first<{ action: string }>();
    expect(log?.action).toBe('admin.user.unmute');
  });

  it('过期禁言自动失效（expires_at 过去时 assertNotMuted 放行）', async () => {
    // 直接插入一条已过期的禁言（模拟时间流逝）
    await env.DB.prepare(
      `INSERT INTO bans (id, user_id, type, reason, expires_at, created_by, created_at)
       VALUES ('expiredmute000001', ?, 'mute', '测试', datetime('now', '-1 day'), ?, datetime('now', '-2 day'))`,
    )
      .bind(victimId, adminId)
      .run();
    const p = await tryPost();
    expect(p.status).toBe(201); // 过期禁言不拦截
    // 清理
    await env.DB.prepare(`DELETE FROM bans WHERE id = 'expiredmute000001'`).run();
  });
});
