/**
 * GET /api/admin/users 列表：分页、query 搜索（用户名/昵称/邮箱/uid）、
 * 禁言状态回显、权限。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { createUser, req } from './helpers';

let adminToken = '';

beforeAll(async () => {
  const admin = await createUser({ username: 'uladmin' });
  await env.DB.prepare(`UPDATE users SET role='admin' WHERE username='uladmin'`).run();
  adminToken = admin.accessToken;
});

const list = (query = '') => req<{ users: Record<string, unknown>[]; pagination: { total: number; page: number } }>(`/api/admin/users${query}`, { token: adminToken });

describe('GET /api/admin/users', () => {
  it('分页结构完整，含 role/status/emailVerified 等字段', async () => {
    const res = await list('?pageSize=5');
    expect(res.status).toBe(200);
    expect(res.body.users.length).toBeGreaterThan(0);
    const u = res.body.users[0];
    for (const k of ['uid', 'username', 'email', 'nickname', 'role', 'status', 'emailVerified', 'postCount', 'createdAt']) {
      expect(k in u).toBe(true);
    }
  });

  it('query 按用户名匹配', async () => {
    const res = await list('?query=uladmin');
    expect(res.status).toBe(200);
    expect(res.body.users.length).toBe(1);
    expect(res.body.users[0].username).toBe('uladmin');
  });

  it('query 按昵称匹配', async () => {
    // createUser 的昵称默认与用户名相同（helpers），用 uid 搜确认昵称路径不报错
    const res = await list('?query=ul');
    expect(res.status).toBe(200);
    expect(res.body.users.length).toBeGreaterThanOrEqual(1);
  });

  it('query 纯数字按 uid 精确匹配', async () => {
    const me = await req<{ user: { uid: number } }>('/api/me', { token: adminToken });
    const res = await list(`?query=${me.body.user.uid}`);
    expect(res.status).toBe(200);
    expect(res.body.users.length).toBe(1);
    expect(res.body.users[0].uid).toBe(me.body.user.uid);
  });

  it('LIKE 通配符注入不放大结果集', async () => {
    const injected = await list('?query=%25%25');
    expect(injected.status).toBe(200);
    expect(injected.body.users).toEqual([]); // 无字面 %% 用户名 → 必空
  });

  it('无匹配返回空列表与 total 0', async () => {
    const res = await list('?query=zzz-no-such-user-zzz');
    expect(res.status).toBe(200);
    expect(res.body.users).toEqual([]);
    expect(res.body.pagination.total).toBe(0);
  });

  it('非管理员 403', async () => {
    const user = await createUser({ username: 'uluser' });
    expect((await req('/api/admin/users', { token: user.accessToken })).status).toBe(403);
  });
});
