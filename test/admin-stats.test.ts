/** 管理后台统计：总浏览量 / 篇均浏览 / 浏览量排行 */
import { describe, it, expect } from 'vitest';
import { createPost, createUser, req } from './helpers';

describe('后台浏览量统计', () => {
  it('stats 返回 totalViews/avgViews/topPosts，且按浏览量排序', async () => {
    const admin = await createUser({ username: 'statsadmin' });
    await (await import('cloudflare:test')).env.DB.prepare(`UPDATE users SET role='admin' WHERE username='statsadmin'`).run();

    const author = await createUser({ username: 'statsauthor' });
    const p1 = (await createPost(author.accessToken, { title: '高浏览帖子' })).body.id as string;
    const p2 = (await createPost(author.accessToken, { title: '低浏览帖子' })).body.id as string;

    // p1 浏览 3 次（不同指纹），p2 浏览 1 次
    for (const i of [1, 2, 3]) {
      await req(`/api/posts/${p1}/view`, { method: 'POST', headers: { 'cf-connecting-ip': `10.9.0.${i}`, 'user-agent': `ua-${i}` } });
    }
    await req(`/api/posts/${p2}/view`, { method: 'POST', headers: { 'cf-connecting-ip': '10.9.0.9', 'user-agent': 'ua-9' } });

    const res = await req('/api/admin/stats', { token: admin.accessToken });
    expect(res.status).toBe(200);
    expect(res.body.totalViews).toBeGreaterThanOrEqual(4);
    expect(res.body.avgViews).toBeGreaterThanOrEqual(2);
    expect(res.body.topPosts.length).toBeGreaterThanOrEqual(2);
    expect(res.body.topPosts[0].id).toBe(p1);
    expect(res.body.topPosts[0].viewCount).toBeGreaterThanOrEqual(res.body.topPosts[1].viewCount);
    expect(res.body.topPosts[0].title).toBe('高浏览帖子');
  });

  it('非管理员无权访问', async () => {
    const user = await createUser({ username: 'statsuser' });
    const res = await req('/api/admin/stats', { token: user.accessToken });
    expect(res.status).toBe(403);
  });
});
