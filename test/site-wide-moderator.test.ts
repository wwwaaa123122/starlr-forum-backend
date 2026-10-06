import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { createPost, createUser, req } from './helpers';

interface TestUser { id: string; accessToken: string; username: string }

async function makeAdminUser(username: string): Promise<TestUser> {
  const u = await createUser({ username });
  await env.DB.prepare(`UPDATE users SET role = 'admin' WHERE id = ?`).bind(u.id).run();
  return u as TestUser;
}

describe('全站版主与已删除内容可见性', () => {
  it('全站版主管辖所有版块', async () => {
    const admin = await makeAdminUser('swadmin');
    const sw = await createUser({ username: 'sitewidemod' });
    const categories = (await req('/api/categories')).body.categories as { id: string }[];
    await req(`/api/admin/users/${sw.id}/role`, {
      method: 'PATCH',
      token: admin.accessToken,
      body: { role: 'moderator' },
    });
    const grant = await req('/api/admin/moderators', {
      method: 'POST',
      token: admin.accessToken,
      body: { username: 'sitewidemod', siteWide: true },
    });
    expect(grant.status).toBe(200);
    expect(grant.body.siteWide).toBe(true);

    // 在两个不同版块发帖，全站版主均能管理
    for (const cat of categories.filter((c) => (c as { postPolicy?: string }).postPolicy === 'everyone')) {
      const { id } = (await createPost(sw.accessToken, { categoryId: cat.id })).body;
      const res = await req(`/api/admin/posts/${id}`, { method: 'DELETE', token: sw.accessToken });
      expect(res.status).toBe(200);
      // 已删除内容：辖区（全站）版主可见，作者不可见
      expect((await req(`/api/posts/${id}`, { token: sw.accessToken })).status).toBe(200);
      expect((await req(`/api/posts/${id}`, { token: admin.accessToken })).status).toBe(200);
      expect((await req(`/api/posts/${id}`)).status).toBe(404);
      expect((await req(`/api/admin/posts/${id}/restore`, { method: 'POST', token: sw.accessToken })).status).toBe(200);
    }

    // 列表返回 siteWide 分组
    const list = await req('/api/admin/moderators', { token: admin.accessToken });
    expect((list.body.siteWide as { userId: string }[]).some((m) => m.userId === sw.id)).toBe(true);
  });

  it('撤销全部版主权限', async () => {
    const admin = await makeAdminUser('swadmin');
    const mod = await createUser({ username: 'revokeallmod' });
    await req(`/api/admin/users/${mod.id}/role`, {
      method: 'PATCH',
      token: admin.accessToken,
      body: { role: 'moderator' },
    });
    await req('/api/admin/moderators', {
      method: 'POST',
      token: admin.accessToken,
      body: { username: 'revokeallmod', siteWide: true },
    });
    const del = await req(`/api/admin/moderators/${mod.id}`, { method: 'DELETE', token: admin.accessToken });
    expect(del.status).toBe(200);

    // 权限收口：已删除帖子对无辖区版主不可见
    const author = await createUser({ username: 'revokeallauthor' });
    const { id } = (await createPost(author.accessToken)).body;
    await req(`/api/admin/posts/${id}`, { method: 'DELETE', token: admin.accessToken });
    expect((await req(`/api/posts/${id}`, { token: mod.accessToken })).status).toBe(404);
  });
});
