/**
 * 纯前端 Worker（前后端分离部署时的静态站点）薄入口 —— 保持零数据绑定：
 *  - 仅 /robots.txt、/sitemap.xml、/feed.xml 三个 SEO 路径进 Worker（run_worker_first 白名单）
 *  - robots：只允许抓首页（内容归并到主域收录）
 *  - sitemap/feed：302（临时）到主域，避免长期缓存固化域名策略
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

/** 主站基址：环境变量 CANONICAL_SITE_URL → SITE_URL（自部署者无需改代码） */
function siteRoot(c: { env: AppEnv['Bindings'] }): string {
  const explicit = (c.env.CANONICAL_SITE_URL ?? '').trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  try {
    return new URL(c.env.SITE_URL).origin;
  } catch {
    return '';
  }
}

app.get('/sitemap.xml', (c) => {
  const root = siteRoot(c);
  return root ? c.redirect(`${root}/sitemap.xml`, 302) : c.body(null, 404);
});
app.get('/feed.xml', (c) => {
  const root = siteRoot(c);
  return root ? c.redirect(`${root}/feed.xml`, 302) : c.body(null, 404);
});

// 兜底（理论不可达）：仍转发资源层
app.all('*', (c) => c.env.ASSETS?.fetch(c.req.raw) ?? c.body(null, 404));

export default app;
