/**
 * 审计日志查询端点：分页、action 过滤、actor 关联、权限。
 * 各管理动作写审计日志的行为已分散在各自用例（sso/category-sort 等）中验证。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { createPost, createUser, req } from './helpers';

let adminToken = '';

beforeAll(async () => {
  const admin = await createUser({ username: 'auditadmin' });
  await env.DB.prepare(`UPDATE users SET role='admin' WHERE username='auditadmin'`).run();
  adminToken = admin.accessToken;
  // 产生一条可过滤的审计记录（改站点名会写 admin.site.update）
  await req('/api/admin/services/site', {
    method: 'PATCH',
    token: adminToken,
    body: { site_name: '审计测试站名' },
  });
  // 还原
  await req('/api/admin/services/site', {
    method: 'PATCH',
    token: adminToken,
    body: { site_name: 'Starlr Forum' },
  });
});

describe('GET /api/admin/audit-logs', () => {
  it('分页结构完整（logs/pagination）', async () => {
    const res = await req<{ logs: unknown[]; pagination: { page: number; pageSize: number; total: number } }>(
      '/api/admin/audit-logs',
      { token: adminToken },
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.logs)).toBe(true);
    expect(res.body.logs.length).toBeGreaterThan(0);
    expect(res.body.pagination.page).toBe(1);
  });

  it('action 过滤：只返回匹配的记录', async () => {
    const res = await req<{ logs: { action: string }[] }>('/api/admin/audit-logs?action=admin.site.update', { token: adminToken });
    expect(res.status).toBe(200);
    expect(res.body.logs.length).toBeGreaterThan(0);
    for (const log of res.body.logs) {
      expect(log.action).toBe('admin.site.update');
    }
  });

  it('action 过滤无匹配时返回空列表', async () => {
    const res = await req<{ logs: unknown[]; pagination: { total: number } }>('/api/admin/audit-logs?action=no.such.action', { token: adminToken });
    expect(res.status).toBe(200);
    expect(res.body.logs).toEqual([]);
    expect(res.body.pagination.total).toBe(0);
  });

  it('日志含 actorName（LEFT JOIN users）', async () => {
    const res = await req<{ logs: { action: string; actorName: string | null }[] }>('/api/admin/audit-logs?action=admin.site.update', { token: adminToken });
    const withActor = res.body.logs.find((l) => l.actorName);
    expect(withActor).toBeTruthy();
    expect(withActor!.actorName).toBe('auditadmin');
  });

  it('按 created_at DESC 排序', async () => {
    const res = await req<{ logs: { createdAt: string }[] }>('/api/admin/audit-logs?pageSize=50', { token: adminToken });
    const times = res.body.logs.map((l) => l.createdAt);
    const sorted = [...times].sort().reverse();
    expect(times).toEqual(sorted);
  });

  it('非管理员 403', async () => {
    const user = await createUser({ username: 'audituser' });
    expect((await req('/api/admin/audit-logs', { token: user.accessToken })).status).toBe(403);
  });
});
