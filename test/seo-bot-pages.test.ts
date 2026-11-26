/**
 * 爬虫预渲染页回归：
 *  - /categories 曾引用不存在的 categories.position 列（实际列名 sort_order）→ 爬虫拿到 500
 *  - /:keyfile 通配曾注册在 /explore 之前 → /explore 被截胡，爬虫只拿到空 SPA 壳
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createPost, createUser, req } from './helpers';

const botHeaders = {
  'user-agent': 'Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)',
  accept: 'text/html,application/xhtml+xml',
};

let postTitle = '';

beforeAll(async () => {
  const author = await createUser({ username: 'seobotauthor' });
  postTitle = `SEO 爬虫验证帖 ${Date.now()}`;
  await createPost(author.accessToken, { title: postTitle, content: '爬虫正文验证内容' });
});

describe('爬虫动态渲染', () => {
  it('/categories 返回 200 且含真实分类', async () => {
    const res = await req('/categories', { headers: botHeaders });
    expect(res.status).toBe(200);
    expect(String(res.body)).toContain('全部板块');
    expect(String(res.body)).toContain('技术分享');
  });

  it('/explore 返回热门页正文（不被 /:keyfile 通配截胡）', async () => {
    const res = await req('/explore', { headers: botHeaders });
    expect(res.status).toBe(200);
    const html = String(res.body);
    expect(html).toContain('<h1>热门探索</h1>');
    // 预渲染页应含帖子链接（而不是空 SPA 壳）
    expect(html).toContain('/post/');
  });

  it('真人访问 /categories 仍走 SPA 兜底（测试环境无 ASSETS → 404）', async () => {
    const res = await req('/categories', { headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120' } });
    expect(res.status).toBe(404);
  });
});
