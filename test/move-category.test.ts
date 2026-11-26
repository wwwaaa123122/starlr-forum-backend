/**
 * PATCH /api/admin/posts/:id/category — 管理员移动帖子分类：
 * 计数迁移、staff 版块限制、辖区限制、幂等、已删帖拒绝、审计。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { createPost, createUser, req } from './helpers';

let adminToken = '';
let authorToken = '';
let targetCatId = '';
let sourceCatId = '';

beforeAll(async () => {
  const admin = await createUser({ username: 'movecatadmin' });
  await env.DB.prepare(`UPDATE users SET role='admin' WHERE username='movecatadmin'`).run();
  adminToken = admin.accessToken;
  const author = await createUser({ username: 'movecatauthor' });
  authorToken = author.accessToken;

  // 建两个测试分类
  const src = await req<{ id: string }>('/api/admin/categories', {
    method: 'POST', token: adminToken,
    body: { name: '移动源分类', slug: 'move-src', description: '', icon: '🧪' },
  });
  sourceCatId = src.body.id;
  const dst = await req<{ id: string }>('/api/admin/categories', {
    method: 'POST', token: adminToken,
    body: { name: '移动目标分类', slug: 'move-dst', description: '', icon: '🧪' },
  });
  targetCatId = dst.body.id;
});

const move = (postId: string, categoryId: string, token = adminToken) =>
  req(`/api/admin/posts/${postId}/category`, { method: 'PATCH', token, body: { categoryId } });

describe('PATCH /api/admin/posts/:id/category', () => {
  it('移动成功：category_id 变更 + 两分类计数一减一增 + 审计', async () => {
    const postId = (await createPost(authorToken, { title: '移动验证帖', content: 'x', categoryId: sourceCatId })).body.id as string;
    const beforeSrc = await env.DB.prepare(`SELECT post_count FROM categories WHERE id = ?`).bind(sourceCatId).first<{ post_count: number }>();
    const beforeDst = await env.DB.prepare(`SELECT post_count FROM categories WHERE id = ?`).bind(targetCatId).first<{ post_count: number }>();

    const res = await move(postId, targetCatId);
    expect(res.status).toBe(200);
    expect(res.body.moved).toBe(true);

    // post.category_id 已变
    const post = await env.DB.prepare(`SELECT category_id FROM posts WHERE id = ?`).bind(postId).first<{ category_id: string }>();
    expect(post?.category_id).toBe(targetCatId);

    // 计数：源 -1、目标 +1（相对 before）
    const afterSrc = await env.DB.prepare(`SELECT post_count FROM categories WHERE id = ?`).bind(sourceCatId).first<{ post_count: number }>();
    const afterDst = await env.DB.prepare(`SELECT post_count FROM categories WHERE id = ?`).bind(targetCatId).first<{ post_count: number }>();
    expect(afterSrc?.post_count).toBe(beforeSrc!.post_count - 1);
    expect(afterDst?.post_count).toBe(beforeDst!.post_count + 1);

    // 审计日志
    const log = await env.DB.prepare(
      `SELECT detail FROM audit_logs WHERE action = 'admin.post.move_category' AND target_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(postId)
      .first<{ detail: string }>();
    expect(log?.detail).toContain('→');
  });

  it('幂等：移到当前所在分类返回 moved=false，不重复计数', async () => {
    const postId = (await createPost(authorToken, { title: '幂等验证帖', content: 'x', categoryId: targetCatId })).body.id as string;
    const before = await env.DB.prepare(`SELECT post_count FROM categories WHERE id = ?`).bind(targetCatId).first<{ post_count: number }>();
    const res = await move(postId, targetCatId);
    expect(res.status).toBe(200);
    expect(res.body.moved).toBe(false);
    const after = await env.DB.prepare(`SELECT post_count FROM categories WHERE id = ?`).bind(targetCatId).first<{ post_count: number }>();
    expect(after?.post_count).toBe(before?.post_count);
  });

  it('目标分类不存在：400', async () => {
    const postId = (await createPost(authorToken, { title: '不存在验证帖', content: 'x', categoryId: sourceCatId })).body.id as string;
    expect((await move(postId, 'cat-nonexistent-xyz')).status).toBe(400);
  });

  it('已删除的帖子不能移动：400', async () => {
    const postId = (await createPost(authorToken, { title: '已删验证帖', content: 'x', categoryId: sourceCatId })).body.id as string;
    await req(`/api/posts/${postId}`, { method: 'DELETE', token: authorToken });
    expect((await move(postId, targetCatId)).status).toBe(400);
  });

  it('普通用户 403（作者本人改分类走 PATCH /api/posts/:id，非此端点）', async () => {
    const postId = (await createPost(authorToken, { title: '权限验证帖', content: 'x', categoryId: sourceCatId })).body.id as string;
    expect((await move(postId, targetCatId, authorToken)).status).toBe(403);
  });

  it('版主不能把别版帖子搬进自己辖区（源分类也要在辖区内）', async () => {
    const mod = await createUser({ username: 'movecatmod' });
    await env.DB.prepare(`UPDATE users SET role='moderator' WHERE id = ?`).bind(mod.id).run();
    await env.DB.prepare(`INSERT INTO moderators (user_id, category_id) VALUES (?, ?)`).bind(mod.id, targetCatId).run();

    const postId = (await createPost(authorToken, { title: '跨版越权验证帖', content: 'x', categoryId: sourceCatId })).body.id as string;
    const res = await move(postId, targetCatId, mod.accessToken);
    expect(res.status).toBe(403);

    // 帖子仍在源分类
    const post = await env.DB.prepare(`SELECT category_id FROM posts WHERE id = ?`).bind(postId).first<{ category_id: string }>();
    expect(post?.category_id).toBe(sourceCatId);
  });

  it('staff 版块不能移入（post_policy 限制对移动同样生效）', async () => {
    // 站务公告是 staff 版块
    const cats = await req<{ categories: { id: string; slug: string }[] }>('/api/categories');
    const staffCat = cats.body.categories.find((c) => c.slug === 'announcements');
    if (staffCat) {
      const postId = (await createPost(authorToken, { title: 'staff 验证帖', content: 'x', categoryId: sourceCatId })).body.id as string;
      const res = await move(postId, staffCat.id);
      expect(res.status).toBe(403);
    }
  });
});
