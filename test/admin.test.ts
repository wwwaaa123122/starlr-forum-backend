/** 管理后台：用户列表状态（emailVerified/mutedUntil）与热门标签接口 */
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createUser, req } from './helpers';

describe('用户列表状态与禁言联动', () => {
  it('用户列表返回 emailVerified 与 mutedUntil/mutedPermanent，禁言后状态变化', async () => {
    const admin = await createUser({ username: 'statusadmin' });
    await env.DB.prepare(`UPDATE users SET role='admin' WHERE username='statusadmin'`).run();
    const target = await createUser({ username: 'statustarget' });

    const before = await req('/api/admin/users?pageSize=20', { token: admin.accessToken });
    expect(before.status).toBe(200);
    const row = before.body.users.find((u: { id: string }) => u.id === target.id);
    expect(row.emailVerified).toBe(1);
    expect(row.mutedUntil).toBeNull();

    // 自定义时长禁言 3 天
    const mute = await req(`/api/admin/users/${target.id}/mute`, {
      method: 'POST',
      token: admin.accessToken,
      body: { reason: '测试禁言', days: 3 },
    });
    expect(mute.status).toBe(200);

    const after = await req('/api/admin/users?pageSize=20', { token: admin.accessToken });
    const mutedRow = after.body.users.find((u: { id: string }) => u.id === target.id);
    expect(mutedRow.mutedUntil).toBeTruthy();
    expect(mutedRow.mutedPermanent).toBe(0);

    // 永久禁言
    await req(`/api/admin/users/${target.id}/mute`, {
      method: 'POST',
      token: admin.accessToken,
      body: { reason: '永久测试', days: null },
    });
    const perm = await req('/api/admin/users?pageSize=20', { token: admin.accessToken });
    const permRow = perm.body.users.find((u: { id: string }) => u.id === target.id);
    expect(permRow.mutedUntil).toBeNull();
    expect(permRow.mutedPermanent).toBe(1);

    // 解除后恢复
    await req(`/api/admin/users/${target.id}/unmute`, { method: 'POST', token: admin.accessToken });
    const clean = await req('/api/admin/users?pageSize=20', { token: admin.accessToken });
    const cleanRow = clean.body.users.find((u: { id: string }) => u.id === target.id);
    expect(cleanRow.mutedUntil).toBeNull();
    expect(cleanRow.mutedPermanent).toBeNull();
  });

  it('公开热门标签接口：返回使用数排序的标签', async () => {
    const u = await createUser({ username: 'tagposter' });
    await req('/api/posts', {
      method: 'POST',
      token: u.accessToken,
      body: { title: '标签测试帖', content: '内容', categoryId: 'cat0tech000000001', tags: ['cloudflare', 'react'] },
    });
    const res = await req('/api/posts/tags');
    expect(res.status).toBe(200);
    const names = res.body.tags.map((t: { name: string }) => t.name);
    expect(names).toContain('cloudflare');
    expect(names).toContain('react');
    expect(res.body.tags[0].count).toBeGreaterThanOrEqual(1);
  });
});
