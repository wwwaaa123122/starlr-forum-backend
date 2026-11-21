/**
 * POST /api/admin/categories/restore-defaults 幂等性：
 * AGENTS.md 明言「仅补齐缺失的种子分类，不动已有分类的数据」——
 * 用户改过名字/排序的分类绝不能被覆盖。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { createUser, req } from './helpers';

let adminToken = '';

beforeAll(async () => {
  const admin = await createUser({ username: 'rstdadmin' });
  await env.DB.prepare(`UPDATE users SET role='admin' WHERE username='rstdadmin'`).run();
  adminToken = admin.accessToken;
});

const restore = () => req<{ restored: string[] }>('/api/admin/categories/restore-defaults', { method: 'POST', token: adminToken });

describe('POST /api/admin/categories/restore-defaults', () => {
  it('删除全部种子分类后：恢复缺失的 4 个', async () => {
    await env.DB.prepare(`DELETE FROM categories`).run();
    const res = await restore();
    expect(res.status).toBe(200);
    expect(res.body.restored.length).toBe(4);
    const cats = await req<{ categories: { slug: string }[] }>('/api/categories');
    for (const slug of ['announcements', 'tech', 'idle', 'qa']) {
      expect(cats.body.categories.some((c) => c.slug === slug)).toBe(true);
    }
  });

  it('幂等：连续调用第二次 restored 为空（不重复创建）', async () => {
    const second = await restore();
    expect(second.status).toBe(200);
    expect(second.body.restored).toEqual([]);
  });

  it('不改已有分类的数据（改名/改序的分类保持原样）', async () => {
    // 把 tech 分类改名 + 改排序
    const cats = await req<{ categories: { id: string; name: string; slug: string }[] }>('/api/categories');
    const tech = cats.body.categories.find((c) => c.slug === 'tech')!;
    await req(`/api/admin/categories/${tech.id}`, {
      method: 'PATCH',
      token: adminToken,
      body: { name: '技术分享改名版', sort_order: 99 },
    });
    const before = await env.DB.prepare(`SELECT name, sort_order FROM categories WHERE slug = 'tech'`).first<{ name: string; sort_order: number }>();

    const res = await restore();
    expect(res.status).toBe(200);
    expect(res.body.restored).toEqual([]); // tech 仍存在 → 不动

    const after = await env.DB.prepare(`SELECT name, sort_order FROM categories WHERE slug = 'tech'`).first<{ name: string; sort_order: number }>();
    expect(after?.name).toBe(before?.name); // 名字未被种子值覆盖
    expect(after?.sort_order).toBe(before?.sort_order); // 排序未被覆盖
  });

  it('非管理员 403', async () => {
    const user = await createUser({ username: 'rstduser' });
    expect((await req('/api/admin/categories/restore-defaults', { method: 'POST', token: user.accessToken })).status).toBe(403);
  });

  it('恢复的分类带正确 post_policy（staff/everyone）', async () => {
    await env.DB.prepare(`DELETE FROM categories`).run();
    await restore();
    const rows = await env.DB.prepare(`SELECT slug, post_policy FROM categories`).all<{ slug: string; post_policy: string }>();
    const map = new Map((rows.results ?? []).map((r) => [r.slug, r.post_policy]));
    expect(map.get('announcements')).toBe('staff'); // 站务公告仅staff可发
    expect(map.get('tech')).toBe('everyone');
  });
});
