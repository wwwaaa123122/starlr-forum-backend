/**
 * f.182030.xyz（纯前端 Worker）薄入口 —— 保持零数据绑定：
 *  - robots.txt：只允许抓首页（内容归并到主域 forum.182030.xyz 收录）
 *  - /sitemap.xml、/feed.xml：301 到主域对应地址
 *  - 其余请求：转发静态资源（SPA）
 * 爬虫动态渲染只存在于主域 Worker（x.182030.xyz / forum.182030.xyz），f 站不查库。
 */
import { Hono } from 'hono';
import type { AppEnv } from './types';

const app = new Hono<AppEnv>();

app.get('/robots.txt', (c) => {
  c.header('Content-Type', 'text/plain; charset=utf-8');
  c.header('Cache-Control', 'public, max-age=3600');
  return c.body('User-agent: *\nAllow: /$\nDisallow: /\n');
});

app.get('/sitemap.xml', (c) => c.redirect('https://forum.182030.xyz/sitemap.xml', 301));
app.get('/feed.xml', (c) => c.redirect('https://forum.182030.xyz/feed.xml', 301));

app.get('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
