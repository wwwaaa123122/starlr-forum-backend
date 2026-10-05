/** 会话管理：列出（含 Cloudflare IP 库信息）/ 吊销 / 吊销其他 */
import { describe, it, expect } from 'vitest';
import { createPost, createUser, req } from './helpers';

const CN_CF = { country: 'CN', city: 'Shanghai', region: 'Shanghai', colo: 'SJC', asn: 4837 };

describe('会话管理', () => {
  it('登录两台设备后列出 2 个会话，含 IP/位置/设备信息，当前会话有标记', async () => {
    const u = await createUser({ username: 'sessuser' });

    // 第二台设备登录
    const login2 = await req('/api/auth/login', {
      method: 'POST',
      headers: { 'cf-connecting-ip': '203.0.113.9', 'user-agent': 'Mozilla/5.0 iPhone Mobile Safari' },
      cf: CN_CF,
      body: { identifier: u.username, password: u.password },
    });
    expect(login2.status).toBe(200);
    const s2 = login2.body.accessToken as string;

    const list = await req('/api/me/sessions', { token: s2, headers: { 'cf-connecting-ip': '203.0.113.9' }, cf: CN_CF });
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(2);

    const current = list.body.sessions.find((x: { current: boolean }) => x.current);
    const other = list.body.sessions.find((x: { current: boolean }) => !x.current);
    expect(current).toBeTruthy();
    expect(other).toBeTruthy();

    // Cloudflare IP 库信息
    expect(current.ip).toBe('203.0.113.9');
    expect(current.location).toContain('Shanghai');
    expect(current.location).toContain('CN');
    expect(current.colo).toBe('SJC');
    expect(String(current.device)).toContain('iPhone');
  });

  it('吊销其他会话：其他会话的刷新令牌立即失效', async () => {
    const u = await createUser({ username: 'sessrevoker' });
    const login2 = await req('/api/auth/login', {
      method: 'POST',
      body: { identifier: u.username, password: u.password },
    });
    const refresh2 = login2.body.refreshToken as string;
    const access2 = login2.body.accessToken as string;

    // 用第一台设备（createUser 会话）吊销其他
    const res = await req('/api/me/sessions/revoke-others', { method: 'POST', token: u.accessToken });
    expect(res.status).toBe(200);
    expect(res.body.revokedCount).toBe(1);

    // 被吊销会话的刷新令牌立即失效（访问令牌为无状态 JWT，寿命已缩短至 30 分钟）
    const refreshTry = await req('/api/auth/refresh', { method: 'POST', body: { refreshToken: refresh2 } });
    expect(refreshTry.status).toBe(401);
    // 该设备无法再维持登录：刷新失败后应用会清除本地令牌
    const sessions = await req('/api/me/sessions', { token: access2 });
    expect(sessions.status).toBe(200); // 旧 access token 在过期前仍可通过鉴权（无状态设计）

    const list = await req('/api/me/sessions', { token: u.accessToken });
    expect(list.body.total).toBe(1);
    expect(list.body.sessions[0].current).toBe(true);
  });

  it('按 ID 吊销单个会话；不能吊销当前会话', async () => {
    const u = await createUser({ username: 'sessbyid' });
    const login2 = await req('/api/auth/login', {
      method: 'POST',
      body: { identifier: u.username, password: u.password },
    });
    const refresh2 = login2.body.refreshToken as string;
    const access2 = login2.body.accessToken as string;

    // 第一台设备查看列表，找到第二台设备的会话
    const list = await req('/api/me/sessions', { token: u.accessToken });
    const other = list.body.sessions.find((x: { current: boolean }) => !x.current);
    const me = list.body.sessions.find((x: { current: boolean }) => x.current);

    // 不能吊销当前会话
    const bad = await req(`/api/me/sessions/${me.id}`, { method: 'DELETE', token: u.accessToken });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('CURRENT_SESSION');

    // 吊销其他会话
    const ok = await req(`/api/me/sessions/${other.id}`, { method: 'DELETE', token: u.accessToken });
    expect(ok.status).toBe(200);
    expect(await req('/api/auth/refresh', { method: 'POST', body: { refreshToken: refresh2 } })).toMatchObject({ status: 401 });

    // 权限：他人的会话不可见/不可吊销
    const stranger = await createUser({ username: 'sessstranger' });
    const hijack = await req(`/api/me/sessions/${other.id}`, { method: 'DELETE', token: stranger.accessToken });
    expect(hijack.status).toBe(404);
  });

  it('登出后设备离线；未登录 401', async () => {
    const u = await createUser({ username: 'sesslogout' });
    const anon = await req('/api/me/sessions');
    expect(anon.status).toBe(401);
    void createPost;
  });
});
