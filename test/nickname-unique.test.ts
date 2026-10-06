import { describe, expect, it } from 'vitest';
import { createUser, req } from './helpers';

describe('昵称唯一性', () => {
  it('重复昵称被拒绝（409），空档昵称可用，本人原名不受影响', async () => {
    const a = await createUser({ username: 'nicka' });
    const b = await createUser({ username: 'nickb' });

    // a 改成 b 的用户名同名昵称 → 409
    const dup = await req('/api/me', { method: 'PATCH', token: a.accessToken, body: { nickname: 'nickb' } });
    expect(dup.status).toBe(409);
    expect(dup.body.error.message).toContain('已被其他用户使用');

    // b 改成与 a 相同昵称（a 之前没改成功，仍是默认）→ 409
    const dup2 = await req('/api/me', { method: 'PATCH', token: b.accessToken, body: { nickname: 'nicka' } });
    expect(dup2.status).toBe(409);

    // 改成全新昵称 → 200，主页路由可解析
    const ok1 = await req('/api/me', { method: 'PATCH', token: a.accessToken, body: { nickname: '独特昵称甲' } });
    expect(ok1.status).toBe(200);
    const page = await req('/api/users/' + encodeURIComponent('独特昵称甲'));
    expect(page.status).toBe(200);
    expect(page.body.user.username).toBe('nicka');

    // b 再改成同昵称 → 409（动态校验，不依赖初始数据）
    expect((await req('/api/me', { method: 'PATCH', token: b.accessToken, body: { nickname: '独特昵称甲' } })).status).toBe(409);

    // a 改回自己原来的昵称（等于自己当前值）→ 200
    const self = await req('/api/me', { method: 'PATCH', token: a.accessToken, body: { nickname: '独特昵称甲' } });
    expect(self.status).toBe(200);
  });
});
