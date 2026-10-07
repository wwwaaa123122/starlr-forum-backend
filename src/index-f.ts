/**
 * f.182030.xyz（纯前端 Worker）薄入口 —— 保持零数据绑定：
 *  - 仅 /robots.txt、/sitemap.xml、/feed.xml 三个 SEO 路径进 Worker（run_worker_first 白名单）
 *  - robots：只允许抓首页（内容归并主域 forum.182030.xyz 收录）
 *  - sitemap/feed：301 到主域
 *  - 其余请求由 assets 层直出（SPA fallback 照旧），Worker 不参与
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

// 兜底（理论不可达）：仍转发资源层
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
