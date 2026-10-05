/**
 * 星辰旅人论坛 — Cloudflare Worker 入口
 *
 * 职责分层：
 *   middleware/  认证与权限
 *   lib/         JWT、密码、限流、Turnstile、审计等基础设施
 *   routes/      REST API
 *   静态资源     frontend/dist（React + shadcn/ui，前后端分离构建）
 */
import { Hono } from 'hono';
import type { AppEnv } from './types';
import { ApiError, jsonError } from './lib/http';
import { optionalAuth } from './middleware/auth';

import authRoutes from './routes/auth';
import { meRoutes } from './routes/me';
import categoryRoutes from './routes/categories';
import postRoutes from './routes/posts';
import replyRoutes from './routes/replies';
import searchRoutes from './routes/search';
import userRoutes from './routes/users';
import notificationRoutes from './routes/notifications';
import reportRoutes from './routes/reports';
import uploadRoutes from './routes/upload';
import adminRoutes from './routes/admin';
import wellKnownRoutes from './routes/well-known';
import oauthRoutes from './routes/oauth';

const app = new Hono<AppEnv>();

// ---------- 通用中间件 ----------
app.use('*', async (c, next) => {
  const requestId = crypto.randomUUID().slice(0, 8);
  c.set('requestId', requestId);
  c.header('X-Request-Id', requestId);
  await next();
});

// CORS：默认同域部署无需开启；独立域名部署时配置 ALLOWED_ORIGINS（逗号分隔）
app.use('/api/*', async (c, next) => {
  const origin = c.req.header('origin');
  const allowed = (c.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (origin && (allowed.includes(origin) || allowed.includes('*'))) {
    c.header('Access-Control-Allow-Origin', origin);
    c.header('Access-Control-Allow-Credentials', 'false');
    c.header('Vary', 'Origin');
    if (c.req.method === 'OPTIONS') {
      c.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
      c.header('Access-Control-Allow-Headers', 'Content-Type,Authorization');
      c.header('Access-Control-Max-Age', '86400');
      return c.body(null, 204);
    }
  }
  await next();
});

app.use('/api/*', optionalAuth);

// ---------- 路由 ----------
app.route('/api/auth', authRoutes);
app.route('/api/categories', categoryRoutes);
app.route('/api/posts', postRoutes);
app.route('/api/replies', replyRoutes);
app.route('/api/search', searchRoutes);
app.route('/api/users', userRoutes);
app.route('/api/notifications', notificationRoutes);
app.route('/api/reports', reportRoutes);
app.route('/api/upload', uploadRoutes);
app.route('/api/admin', adminRoutes);
app.route('/.well-known', wellKnownRoutes);
app.route('/oauth', oauthRoutes);

// 当前用户资料
app.route('/api/me', meRoutes);

app.get('/api/health', (c) => c.json({ status: 'ok', time: new Date().toISOString() }));

// 公开站点配置（前端启动时获取 Turnstile site key 等）
app.get('/api/config', (c) => {
  return c.json({
    siteName: '星辰旅人论坛',
    turnstileSiteKey: c.env.TURNSTILE_SITE_KEY || null,
    registrationEnabled: true,
  });
});

// ---------- 错误处理 ----------
app.onError((err, c) => {
  if (err instanceof ApiError) {
    return jsonError(c, err);
  }
  // 内部错误：记录日志（Workers 实时日志可见），不向客户端泄露堆栈
  console.error(`[unhandled] ${c.get('requestId')}`, err);
  return c.json({ error: { code: 'INTERNAL_ERROR', message: '服务器内部错误' } }, 500);
});

app.notFound((c) => {
  if (c.req.path.startsWith('/api/') || c.req.path.startsWith('/oauth/')) {
    return c.json({ error: { code: 'NOT_FOUND', message: '接口不存在' } }, 404);
  }
  // 非 API 路径交给静态资源层（SPA fallback → index.html）
  return c.env.ASSETS.fetch(c.req.raw);
});

export default app;
