/**
 * 个人资料图片地址校验：拒绝协议相对地址（//host/x）与反斜杠绕过，
 * 避免头像/背景图被当作外链追踪像素加载。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createUser, req } from './helpers';

let token = '';

beforeAll(async () => {
  const user = await createUser({ username: 'imgurluser' });
  token = user.accessToken;
});

describe('PATCH /api/me 图片地址白名单', () => {
  it('接受站内相对路径', async () => {
    const res = await req('/api/me', { method: 'PATCH', token, body: { avatarUrl: '/api/files/uploads/a/b.png' } });
    expect(res.status).toBe(200);
  });

  it('接受 http(s) 绝对地址', async () => {
    const res = await req('/api/me', { method: 'PATCH', token, body: { avatarUrl: 'https://cdn.example.com/a.png' } });
    expect(res.status).toBe(200);
  });

  it('拒绝协议相对地址 //evil.example/x', async () => {
    const res = await req('/api/me', { method: 'PATCH', token, body: { avatarUrl: '//evil.example/x.png' } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('拒绝反斜杠绕过 /\\evil.example/x', async () => {
    const res = await req('/api/me', { method: 'PATCH', token, body: { avatarUrl: '/\\evil.example/x.png' } });
    expect(res.status).toBe(400);
  });

  it('拒绝 javascript: 伪协议', async () => {
    const res = await req('/api/me', { method: 'PATCH', token, body: { backgroundUrl: 'javascript:alert(1)' } });
    expect(res.status).toBe(400);
  });
});
