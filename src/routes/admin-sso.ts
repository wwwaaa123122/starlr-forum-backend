/**
 * /api/admin/sso/* — 「SSO 登录同步」管理（仅 admin）
 *
 * 维护第三方站点登录同步（一次性 ticket 流程）的：
 *  - 总开关（关闭后 issue/redeem 直接拒绝）
 *  - 允许的站点源白名单（KV config:sso；桥接页经公开端点动态拉取，改配置无需重新部署）
 *
 * 所有改动写入 audit_logs（action: admin.sso.update）。
 */
import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { errors, ok } from '../lib/http';
import { parseJson } from '../lib/validate';
import { z } from 'zod';
import { requireRole } from '../middleware/auth';
import { writeAuditLog } from '../lib/audit';
import { getSsoAccessConfig, SSO_KV_KEY } from './site-login';

const app = new Hono<AppEnv>();

app.use('*', requireRole('admin'));

/** GET /config — 当前生效配置（含来源标注）+ 最近同步记录 */
app.get('/config', async (c) => {
  const cfg = await getSsoAccessConfig(c.env);

  const { results } = await c.env.DB.prepare(
    `SELECT a.id, a.detail, a.ip, a.created_at AS createdAt, u.username_raw AS actorName
     FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
     WHERE a.action = 'user.site_login'
     ORDER BY a.created_at DESC LIMIT 20`,
  ).all();

  return ok(c, {
    enabled: cfg.enabled,
    origins: cfg.origins,
    source: cfg.source,
    events: results ?? [],
  });
});

const updateSchema = z.object({
  enabled: z.boolean(),
  /** 每行一个源（http/https，不带路径） */
  origins: z.array(z.string().trim().min(1).max(200)).min(0).max(50),
});

/** PUT /config — 更新总开关与站点白名单（KV 覆盖，env/默认值仅作兜底） */
app.put('/config', async (c) => {
  const body = await parseJson(c, updateSchema);

  // 归一化 + 校验：只收合法 http(s) 源（无路径/凭据），去重，最多 50 个
  const seen = new Set<string>();
  for (const raw of body.origins) {
    let origin: string;
    try {
      const u = new URL(raw);
      if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password) {
        throw errors.badRequest(`站点源格式不正确：${raw}（应为 https://example.com 这样的完整源，不带路径）`, 'SSO_ORIGIN_INVALID');
      }
      if (u.pathname !== '/' || u.search || u.hash) {
        throw errors.badRequest(`站点源不应带路径或参数：${raw}`, 'SSO_ORIGIN_INVALID');
      }
      origin = u.origin;
    } catch (e) {
      if (e && typeof e === 'object' && 'status' in e) throw e;
      throw errors.badRequest(`站点源格式不正确：${raw}`, 'SSO_ORIGIN_INVALID');
    }
    seen.add(origin);
  }
  const origins = [...seen];
  if (origins.length === 0) {
    throw errors.badRequest('至少需要保留一个允许同步的站点源', 'SSO_ORIGINS_EMPTY');
  }

  const value = { enabled: body.enabled, origins };
  await c.env.CACHE.put(SSO_KV_KEY, JSON.stringify(value));
  await writeAuditLog(c, {
    action: 'admin.sso.update',
    actorId: c.get('user')!.id,
    targetType: 'system',
    targetId: 'sso',
    detail: `enabled:${body.enabled}; origins:${origins.join(',')}`,
  });

  return ok(c, { enabled: value.enabled, origins, source: 'kv' });
});

export default app;
