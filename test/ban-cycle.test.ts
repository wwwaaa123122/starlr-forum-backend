/**
 * 封禁生命周期补全：unban 恢复、不能封禁管理员、封禁通知。
 * ban 即时撤销 token / 不能封自己已由 permissions.test.ts 覆盖。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { createUser, req } from './helpers';

let adminToken = '';
let adminId = '';

beforeAll(async () => {
  const admin = await createUser({ username: 'bancycleadmin' });
  await env.DB.prepare(`UPDATE users SET role='admin' WHERE username='bancycleadmin'`).run();
  adminToken = admin.accessToken;
  adminId = admin.id;
});

describe('封禁生命周期', () => {
  it('不能封禁其他管理员（403）；封禁自己 400（自查在先）', async () => {
    const other = await createUser({ username: 'secondadmin' });
    await env.DB.prepare(`UPDATE users SET role='admin' WHERE username='secondadmin'`).run();
    expect((await req(`/api/admin/users/${other.id}/ban`, { method: 'POST', token: adminToken, body: { reason: '尝试封禁管理员' } })).status).toBe(403);
    expect((await req(`/api/admin/users/${adminId}/ban`, { method: 'POST', token: adminToken, body: { reason: '封禁自己' } })).status).toBe(400);
  });

  it('封禁写通知（moderation 类型）', async () => {
    const victim = await createUser({ username: 'bannotifvictim' });
    await req(`/api/admin/users/${victim.id}/ban`, { method: 'POST', token: adminToken, body: { reason: '违规行为' } });
    const notif = await env.DB.prepare(
      `SELECT type, content FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(victim.id)
      .first<{ type: string; content: string }>();
    expect(notif?.type).toBe('moderation');
    expect(notif?.content).toContain('违规行为');
    await req(`/api/admin/users/${victim.id}/unban`, { method: 'POST', token: adminToken });
  });

  it('unban：status 恢复 active、ban 记录 lifted_at 置位、可重新登录', async () => {
    const victim = await createUser({ username: 'bancyclevictim' });
    const banRes = await req(`/api/admin/users/${victim.id}/ban`, {
      method: 'POST',
      token: adminToken,
      body: { reason: '测试封禁', days: 3 },
    });
    expect(banRes.status).toBe(200);

    // 被禁用户登录被拒（status banned）
    const loginDuring = await req('/api/auth/login', { method: 'POST', body: { identifier: 'bancyclevictim', password: 'TestPass2026!' } });
    expect(loginDuring.status).toBe(403);

    const res = await req(`/api/admin/users/${victim.id}/unban`, { method: 'POST', token: adminToken });
    expect(res.status).toBe(200);

    const user = await env.DB.prepare(`SELECT status FROM users WHERE id = ?`).bind(victim.id).first<{ status: string }>();
    expect(user?.status).toBe('active');
    const activeBan = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM bans WHERE user_id = ? AND type = 'ban' AND lifted_at IS NULL`,
    )
      .bind(victim.id)
      .first<{ n: number }>();
    expect(activeBan!.n).toBe(0);

    // 解禁后可重新登录
    const loginAfter = await req('/api/auth/login', { method: 'POST', body: { identifier: 'bancyclevictim', password: 'TestPass2026!' } });
    expect(loginAfter.status).toBe(200);
  });

  it('unban 幂等（未封禁用户调用也成功）', async () => {
    const victim = await createUser({ username: 'unban-idempotent' });
    const res = await req(`/api/admin/users/${victim.id}/unban`, { method: 'POST', token: adminToken });
    expect(res.status).toBe(200);
  });

  it('封禁原因必填（空 reason 400）', async () => {
    const victim = await createUser({ username: 'banreasoncheck' });
    const res = await req(`/api/admin/users/${victim.id}/ban`, { method: 'POST', token: adminToken, body: { reason: '' } });
    expect(res.status).toBe(400);
  });
});
