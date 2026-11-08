/**
 * 经典版前端 Worker（starlr.tech / frontend.182030.xyz）薄入口 —— 零数据绑定：
 *  - /robots.txt /sitemap.xml /feed.xml：SEO 路径（robots 只允许抓首页，sitemap/feed 302 主域）
 *  - /api/*、/oauth/*、/.well-known/*：经 service binding 代理到主 Worker（xingchen-forum-x，同库同 JWT 密钥），
 *    使桥接页 app-auth.html 的同源 fetch 与 Android 客户端 API 直连 starlr.tech 都能工作
 *  - /app-auth：Android 登录桥接页（public/app-auth.html 静态直出，SPA fallback 亦可命中）
 *  - 其余请求由 assets 层直出（SPA fallback 照旧）
 */
import { Hono } from 'hono';
import type { AppEnv } from './types';

const app = new Hono<AppEnv>();

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

/** 代理到主 Worker（xingchen-forum-x：API + app-auth 同源） */
const MAIN_ORIGIN = 'https://x.182030.xyz';
function proxyToMain(c: { env: AppEnv['Bindings']; req: { raw: Request } }): Response | Promise<Response> {
  const main = (c.env as { MAIN?: Fetcher }).MAIN;
  if (!main) return new Response(null, { status: 502 });
  const url = new URL(c.req.raw.url);
  const out = new Request(`${MAIN_ORIGIN}${url.pathname}${url.search}`, c.req.raw);
  return main.fetch(out);
}

app.all('/api/*', (c) => proxyToMain(c));
app.all('/oauth/*', (c) => proxyToMain(c));
app.all('/.well-known/*', (c) => proxyToMain(c));

app.get('/robots.txt', (c) => {
  c.header('Content-Type', 'text/plain; charset=utf-8');
  c.header('Cache-Control', 'public, max-age=3600');
  return c.body('User-agent: *\nAllow: /$\nDisallow: /\n');
});

// 本 Worker 即主域，sitemap/feed 由主 Worker（xingchen-forum-x）生成 —— 直接代理而非 302（避免自指回环）
app.get('/sitemap.xml', (c) => proxyToMain(c));
app.get('/feed.xml', (c) => proxyToMain(c));

// 兜底：转发资源层（/app-auth 静态文件等由 SPA fallback 命中）
app.all('*', (c) => c.env.ASSETS?.fetch(c.req.raw) ?? c.body(null, 404));

export default app;
