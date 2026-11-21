/**
 * 分类删除防护与计数一致性：
 * - 有帖子的分类不可删除（409）
 * - 删除后 post_count 计数与真实帖子数一致（软删减计数）
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { createPost, createUser, req } from './helpers';

let adminToken = '';
let authorToken = '';

beforeAll(async () => {
  const admin = await createUser({ username: 'catdeladmin' });
  await env.DB.prepare(`UPDATE users SET role='admin' WHERE username='catdeladmin'`).run();
  adminToken = admin.accessToken;
  const author = await createUser({ username: 'catdelauthor' });
  authorToken = author.accessToken;
});

/** 建一个空分类并返回 id */
async function createCategory(name: string, slug?: string): Promise<string> {
  // slug 必须匹配 /^[a-z0-9-]+$/（schema 校验），不能用中文名派生
  const res = await req<{ id: string }>('/api/admin/categories', {
    method: 'POST',
    token: adminToken,
    body: { name, slug: slug ?? `cat-${Math.random().toString(36).slice(2, 10)}`, description: '', icon: '🧪' },
  });
  expect(res.status).toBe(201);
  return res.body.id;
}

describe('分类删除防护与计数一致性', () => {
  it('空分类可删除（删除后列表不再包含）', async () => {
    const id = await createCategory('可删除分类');
    const del = await req(`/api/admin/categories/${id}`, { method: 'DELETE', token: adminToken });
    expect(del.status).toBe(200);
    const cats = await req<{ categories: { id: string }[] }>('/api/categories');
    expect(cats.body.categories.some((c) => c.id === id)).toBe(false);
  });

  it('有帖子的分类删除被拒（409 conflict）', async () => {
    const id = await createCategory('有帖分类');
    await createPost(authorToken, { title: '守卫验证帖', content: 'x', categoryId: id });
    const del = await req(`/api/admin/categories/${id}`, { method: 'DELETE', token: adminToken });
    expect(del.status).toBe(409);
    // 分类仍在
    const cats = await req<{ categories: { id: string }[] }>('/api/categories');
    expect(cats.body.categories.some((c) => c.id === id)).toBe(true);
  });

  it('软删帖子的分类仍不可删除（COUNT 不分软删态，实现事实固化）', async () => {
    const id = await createCategory('软删守卫分类');
    const postId = (await createPost(authorToken, { title: '待软删帖', content: 'x', categoryId: id })).body.id as string;
    await req(`/api/posts/${postId}`, { method: 'DELETE', token: authorToken });
    // 软删后 posts 行还在（is_deleted=1），COUNT(*) 仍 > 0 → 删除仍被拒
    const del = await req(`/api/admin/categories/${id}`, { method: 'DELETE', token: adminToken });
    expect(del.status).toBe(409);
  });

  it('post_count 计数与真实可见帖子数一致（发帖+1、软删-1）', async () => {
    const id = await createCategory('计数验证分类');
    const before = await env.DB.prepare(`SELECT post_count FROM categories WHERE id = ?`).bind(id).first<{ post_count: number }>();
    expect(before?.post_count).toBe(0);

    const p1 = (await createPost(authorToken, { title: '计数帖一', content: 'x', categoryId: id })).body.id as string;
    let row = await env.DB.prepare(`SELECT post_count FROM categories WHERE id = ?`).bind(id).first<{ post_count: number }>();
    expect(row?.post_count).toBe(1);

    const p2 = (await createPost(authorToken, { title: '计数帖二', content: 'x', categoryId: id })).body.id as string;
    row = await env.DB.prepare(`SELECT post_count FROM categories WHERE id = ?`).bind(id).first<{ post_count: number }>();
    expect(row?.post_count).toBe(2);

    // 软删一帖 → -1
    await req(`/api/posts/${p1}`, { method: 'DELETE', token: authorToken });
    row = await env.DB.prepare(`SELECT post_count FROM categories WHERE id = ?`).bind(id).first<{ post_count: number }>();
    expect(row?.post_count).toBe(1);
    void p2;
  });
});
