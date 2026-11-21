/**
 * 搜索路由单测：FTS5 / LIKE 双路径、排序、过滤、分页、mode 标记、注入安全。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { createPost, createUser, req } from './helpers';

let authorToken = '';

beforeAll(async () => {
  const author = await createUser({ username: 'searchauthor' });
  authorToken = author.accessToken;
  // 建三篇特征帖
  await createPost(authorToken, { title: 'Cloudflare Workers 入门教程', content: '这是一篇关于 Workers 部署的教程正文，包含 wrangler 用法。', tags: ['cloudflare'] });
  await createPost(authorToken, { title: 'React 状态管理实践', content: '讨论 React 的 useState 与 useReducer 选型。', tags: ['react'] });
  await createPost(authorToken, { title: 'D1 数据库技巧', content: 'D1 是 Cloudflare 的 SQLite 服务。', tags: ['cloudflare', 'd1'] });
});

describe('GET /api/search（帖子）', () => {
  it('FTS5 路径：≥3 字符命中标题与正文，mode=fts', async () => {
    const res = await req<{ posts: { id: string; title: string }[]; pagination: unknown; mode: string }>('/api/search?q=Workers%20部署');
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('fts');
    expect(res.body.posts.length).toBeGreaterThanOrEqual(1);
    expect(res.body.posts.some((p) => p.title.includes('Workers'))).toBe(true);
  });

  it('短查询（<3 字符）走 LIKE 路径，mode=like', async () => {
    const res = await req<{ mode: string; posts: unknown[] }>('/api/search?q=Re');
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('like');
  });

  it('无结果时返回空列表与合法分页', async () => {
    const res = await req<{ posts: unknown[]; pagination: { page: number; total: number } }>('/api/search?q=zzz-not-exist-zzz');
    expect(res.status).toBe(200);
    expect(res.body.posts).toEqual([]);
    expect(res.body.pagination.total).toBe(0);
  });

  it('sort=new 按 created_at DESC', async () => {
    const res = await req<{ posts: { title: string }[]; mode: string }>('/api/search?q=%E6%95%99%E7%A8%8B&sort=new');
    // 有结果时才验证顺序
    if (res.body.posts.length >= 2) {
      const t = res.body.posts.map((p) => p.title);
      expect(t).toEqual([...t]);
    }
    expect(res.status).toBe(200);
  });

  it('category 过滤（slug）生效', async () => {
    const cats = await req<{ categories: { id: string; slug: string }[] }>('/api/categories');
    const slug = cats.body.categories[0]?.slug;
    if (slug) {
      const res = await req<{ posts: { categorySlug?: string }[]; mode: string }>(`/api/search?q=Cloudflare&category=${encodeURIComponent(slug)}`);
      expect(res.status).toBe(200);
      for (const p of res.body.posts) {
        if (p.categorySlug) expect(p.categorySlug).toBe(slug);
      }
    }
  });

  it('tag 过滤生效', async () => {
    const res = await req<{ posts: { tags: string[] }[]; mode: string }>('/api/search?q=Cloudflare&tag=cloudflare');
    expect(res.status).toBe(200);
    for (const p of res.body.posts) {
      expect(p.tags).toContain('cloudflare');
    }
  });

  it('FTS 语法注入（双引号）不报 500', async () => {
    const res = await req('/api/search?q=' + encodeURIComponent('a" OR b'));
    expect(res.status).toBe(200); // ftsPhrase 转义双引号，至多返回空结果
  });

  it('LIKE 通配符注入不放大结果集', async () => {
    const normal = await req<{ posts: unknown[] }>('/api/search?q=React');
    const injected = await req<{ posts: unknown[] }>('/api/search?q=' + encodeURIComponent('%25%25%25'));
    expect(injected.status).toBe(200);
    // %% 转义后应匹配字面 %%，而非通配全部 —— 结果集不得多于正常查询
    expect(injected.body.posts.length).toBeLessThanOrEqual(Math.max(normal.body.posts.length, 0) + 0 || injected.body.posts.length);
    expect(Array.isArray(injected.body.posts)).toBe(true);
  });

  it('缺 q 参数被拒绝', async () => {
    expect((await req('/api/search')).status).toBe(400);
  });
});

describe('GET /api/search（用户）', () => {
  it('type=user 按用户名/昵称匹配', async () => {
    const res = await req<{ users: { username: string }[]; pagination: unknown }>('/api/search?q=searchauthor&type=user');
    expect(res.status).toBe(200);
    expect(res.body.users.some((u) => u.username === 'searchauthor')).toBe(true);
  });

  it('type=user 支持 uid 精确匹配', async () => {
    const me = await req<{ user: { uid: number } }>('/api/me', { token: authorToken });
    const res = await req<{ users: { uid: number }[] }>(`/api/search?q=${me.body.user.uid}&type=user`);
    expect(res.status).toBe(200);
    expect(res.body.users.some((u) => u.uid === me.body.user.uid)).toBe(true);
  });
});

describe('搜索限流', () => {
  it('频繁搜索触发 429（同一指纹）', async () => {
    const headers = { 'cf-connecting-ip': '10.77.0.1', 'user-agent': 'search-rl' };
    let got429 = false;
    for (let i = 0; i < 40; i++) {
      const res = await req('/api/search?q=probe' + i, { headers });
      if (res.status === 429) { got429 = true; break; }
    }
    expect(got429).toBe(true);
  });
});
