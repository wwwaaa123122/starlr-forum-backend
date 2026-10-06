/** 浏览统计：事件记录（去重后）与管理端聚合接口 */
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createPost, createUser, req } from './helpers';

describe('浏览统计', () => {
  it('浏览去重只记一次事件，事件含国家/设备；管理端聚合正确', async () => {
    const author = await createUser({ username: 'viewauthor' });
    const admin = await createUser({ username: 'viewadmin' });
    await env.DB.prepare(`UPDATE users SET role='admin' WHERE id=?`).bind(admin.id).run();
    const { id } = (await createPost(author.accessToken, { title: '浏览统计测试帖' })).body;

    // 同一指纹两次浏览 → 只计一次
    console.log('POST URL:', `/api/posts/${id}/view`);
    const v1 = await req(`/api/posts/${id}/view`, { method: 'POST', headers: { 'cf-connecting-ip': '10.7.0.1', 'user-agent': 'ua-view-1' } });
    const v2 = await req(`/api/posts/${id}/view`, { method: 'POST', headers: { 'cf-connecting-ip': '10.7.0.1', 'user-agent': 'ua-view-1' } });
    console.log('V1:', JSON.stringify(v1.body).slice(0,150), v1.status);
    console.log('V2:', JSON.stringify(v2.body).slice(0,150), v2.status);
    expect(v1.body.counted).toBe(true);
    expect(v2.body.counted).toBe(false);

    // 第二个访客（带地理与设备）
    await req(`/api/posts/${id}/view`, {
      method: 'POST',
      headers: { 'cf-connecting-ip': '10.7.0.2', 'user-agent': 'iPhone Mozilla Mobile' },
      cf: { country: 'CN', city: 'Beijing', colo: 'SJC' },
      token: admin.accessToken, // 登录用户浏览
    });

    const stats = await req('/api/admin/views', { token: admin.accessToken });
    expect(stats.status).toBe(200);
    expect(stats.body.totals.today).toBe(2);
    expect(stats.body.daily.length).toBe(14);
    expect(stats.body.daily[13].views).toBe(2);
    expect(stats.body.top[0]).toMatchObject({ postId: id, views: 2 });

    const recent = stats.body.recent as { device: string; country: string; colo: string; userName: string | null }[];
    const guest = recent.find((r) => !r.userName);
    const logged = recent.find((r) => r.userName === 'viewadmin');
    expect(guest?.device).toBe('desktop');
    expect(logged).toMatchObject({ country: 'CN', city: 'Beijing', colo: 'SJC', device: 'mobile' });

    // 普通用户 403
    const forbidden = await req('/api/admin/views', { token: author.accessToken });
    expect(forbidden.status).toBe(403);
  });
});
