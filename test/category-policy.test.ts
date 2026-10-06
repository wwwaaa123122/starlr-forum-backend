/** 版块发布权限：staff 版块（站务公告）仅版主及以上可发 */
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createUser, req } from './helpers';

async function makeRole(username: string, role: 'moderator' | 'admin') {
  const u = await createUser({ username });
  await env.DB.prepare(`UPDATE users SET role = ? WHERE id = ?`).bind(role, u.id).run();
  return u;
}

describe('版块发布权限', () => {
  it('普通用户不能发站务公告，版主/管理员可以；换版块编辑同样受限', async () => {
    const user = await createUser({ username: 'policyuser' });
    const mod = await makeRole('policymod', 'moderator');
    const admin = await makeRole('policyadmin', 'admin');

    // 普通用户 → 403
    const denied = await req('/api/posts', {
      method: 'POST', token: user.accessToken,
      body: { title: '普通用户公告', content: 'x', categoryId: 'cat0welcome0000001', tags: [] },
    });
    expect(denied.status).toBe(403);
    expect(denied.body.error?.message).toContain('版主');

    // 版主 / 管理员 → 201
    const byMod = await req('/api/posts', {
      method: 'POST', token: mod.accessToken,
      body: { title: '版主公告', content: 'x', categoryId: 'cat0welcome0000001', tags: [] },
    });
    expect(byMod.status).toBe(201);
    const byAdmin = await req('/api/posts', {
      method: 'POST', token: admin.accessToken,
      body: { title: '管理员公告', content: 'x', categoryId: 'cat0welcome0000001', tags: [] },
    });
    expect(byAdmin.status).toBe(201);

    // 普通用户在其他版块正常发帖，然后把帖子改到公告版 → 403
    const own = await req('/api/posts', {
      method: 'POST', token: user.accessToken,
      body: { title: '普通帖', content: 'x', categoryId: 'cat0tech000000001', tags: [] },
    });
    expect(own.status).toBe(201);
    const move = await req(`/api/posts/${own.body.id}`, {
      method: 'PATCH', token: user.accessToken,
      body: { categoryId: 'cat0welcome0000001' },
    });
    expect(move.status).toBe(403);

    // 分类列表带 postPolicy
    const cats = await req('/api/categories');
    const announcements = (cats.body.categories as { slug: string; postPolicy: string }[]).find((c) => c.slug === 'announcements');
    expect(announcements?.postPolicy).toBe('staff');
  });
});
