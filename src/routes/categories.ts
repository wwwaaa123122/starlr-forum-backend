/** 站点配置与分类（KV 缓存，60s TTL，管理端变更后主动失效） */
import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { ok } from '../lib/http';

const CATEGORY_CACHE_KEY = 'cache:categories:v1';
const CATEGORY_CACHE_TTL = 60;

const app = new Hono<AppEnv>();

app.get('/', async (c) => {
  const cached = await c.env.CACHE.get(CATEGORY_CACHE_KEY, 'json');
  if (cached) {
    c.header('X-Cache', 'HIT');
    return ok(c, cached as Record<string, unknown>);
  }
  const { results } = await c.env.DB.prepare(
    `SELECT id, name, slug, description, icon, sort_order AS sortOrder, post_count AS postCount
     FROM categories ORDER BY sort_order ASC, name ASC`,
  ).all();
  const payload = { categories: results ?? [] };
  await c.env.CACHE.put(CATEGORY_CACHE_KEY, JSON.stringify(payload), { expirationTtl: CATEGORY_CACHE_TTL });
  c.header('X-Cache', 'MISS');
  return ok(c, payload);
});

export default app;
export { CATEGORY_CACHE_KEY };
