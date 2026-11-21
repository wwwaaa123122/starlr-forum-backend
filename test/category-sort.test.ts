/**
 * 分类排序批量更新（PATCH /api/admin/categories-sort）边界用例：
 * 顺序映射、部分无效 id 不报错、重复 id、权限。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { createUser, req } from './helpers';

let adminToken = '';

beforeAll(async () => {
  const admin = await createUser({ username: 'sortadmin' });
  await env.DB.prepare(`UPDATE users SET role='admin' WHERE username='sortadmin'`).run();
  adminToken = admin.accessToken;
});

const sort = (ids: string[]) =>
  req('/api/admin/categories-sort', { method: 'PATCH', token: adminToken, body: { ids } });

async function categoryOrder(): Promise<Map<string, number>> {
  const res = await req<{ categories: { id: string; sortOrder?: number; position?: number }[] }>('/api/categories');
  // 公开接口可能不含 sort_order —— 直接查库
  const { results } = await env.DB.prepare(`SELECT id, sort_order FROM categories`).all<{ id: string; sort_order: number }>();
  void res;
  return new Map((results ?? []).map((r) => [r.id, r.sort_order]));
}

describe('PATCH /api/admin/categories-sort', () => {
  it('按数组顺序重排 sort_order（0 起）', async () => {
    const before = await categoryOrder();
    const ids = [...before.keys()];
    // 反转顺序提交
    const reversed = [...ids].reverse();
    const res = await sort(reversed);
    expect(res.status).toBe(200);

    const after = await categoryOrder();
    reversed.forEach((id, i) => {
      expect(after.get(id)).toBe(i);
    });
    // 还原
    await sort(ids);
  });

  it('含未知 id 的列表：无效 id 静默跳过，有效 id 仍更新', async () => {
    const before = await categoryOrder();
    const first = [...before.keys()][0];
    const res = await sort([first, 'cat-nonexistent-xyz']);
    expect(res.status).toBe(200);
    const after = await categoryOrder();
    expect(after.get(first)).toBe(0);
  });

  it('重复 id：以最后出现的顺序位为准（后写覆盖）', async () => {
    const before = await categoryOrder();
    const ids = [...before.keys()];
    const first = ids[0];
    // 把同一 id 放两个位置：后写的 index 覆盖前者
    await sort([first, ...ids.filter((x) => x !== first).slice(0, 2), first]);
    const after = await categoryOrder();
    expect(after.get(first)).toBe(3); // 最后一次出现在 index 3
    await sort(ids); // 还原
  });

  it('非管理员 403', async () => {
    const user = await createUser({ username: 'sortuser' });
    expect((await req('/api/admin/categories-sort', { method: 'PATCH', token: user.accessToken, body: { ids: ['x'] } })).status).toBe(403);
  });

  it('空数组被拒绝（min 1）', async () => {
    expect((await sort([])).status).toBe(400);
  });

  it('改动写入审计日志', async () => {
    const before = await categoryOrder();
    const ids = [...before.keys()];
    await sort(ids);
    const log = await env.DB.prepare(
      `SELECT detail FROM audit_logs WHERE action = 'admin.category.sort' ORDER BY created_at DESC LIMIT 1`,
    ).first<{ detail: string }>();
    expect(log?.detail).toContain(ids[0]);
  });
});
