/**
 * /api/admin/services/* — 第三方服务配置管理（仅 admin）
 * KV 存储 + 掩码展示 + 连通测试。支持：邮件（Resend）、S3 兼容存储、GitHub OAuth。
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types';
import { errors, ok } from '../lib/http';
import { parseJson } from '../lib/validate';
import { requireRole } from '../middleware/auth';
import { writeAuditLog } from '../lib/audit';
import { SERVICES, serviceDef, getServiceRaw, putServiceRaw, deleteServiceRaw, describeService } from '../lib/service-config';
import { s3Test } from '../lib/s3';
import { deliverViaResend, emailShell } from '../lib/mail';
import { getConfig as getGithubConfig } from './oauth-consumer';
import { nowIso } from '../lib/ids';

const app = new Hono<AppEnv>();

app.use('*', requireRole('admin'));

/** GET / — 所有服务：schema + 当前有效值（secret 掩码）+ 来源 */
app.get('/', async (c) => {
  const services = [];
  for (const def of SERVICES) services.push(await describeService(c.env, def));
  return ok(c, { services });
});

const saveSchema = z.object({
  /** 字段名 → 值；secret 字段传空串表示保持不变，传 '-' 表示清除 */
  values: z.record(z.string(), z.string().max(2000)),
});

/** PUT /:key — 保存配置 */
app.put('/:key', async (c) => {
  const key = c.req.param('key');
  const def = serviceDef(key);
  if (!def) throw errors.notFound('未知服务');

  const { values } = await parseJson(c, saveSchema);
  const existing = (await getServiceRaw(c.env, key)) ?? {};
  const next: Record<string, string> = {};
  for (const f of def.fields) {
    const incoming = values[f.name];
    if (incoming === undefined) {
      if (existing[f.name] !== undefined) next[f.name] = existing[f.name];
      continue;
    }
    if (f.secret) {
      if (incoming === '-') continue; // 清除该字段
      if (incoming === '') { if (existing[f.name]) next[f.name] = existing[f.name]; continue; } // 保持不变
    }
    next[f.name] = incoming.trim();
  }
  // 布尔字段归一化
  if (key === 's3' && next.path_style !== undefined) {
    next.path_style = String(next.path_style).toLowerCase() === 'false' ? 'false' : 'true';
  }
  await putServiceRaw(c.env, key, next);
  await writeAuditLog(c, { action: 'admin.service_config', actorId: c.get('user')!.id, targetType: 'service', targetId: key, detail: `updated:${Object.keys(values).join(',')}` });
  return ok(c, { success: true, service: await describeService(c.env, def) });
});

/** DELETE /:key — 清空该服务 KV 配置（回退到 env 变量） */
app.delete('/:key', async (c) => {
  const key = c.req.param('key');
  const def = serviceDef(key);
  if (!def) throw errors.notFound('未知服务');
  await deleteServiceRaw(c.env, key);
  await writeAuditLog(c, { action: 'admin.service_config', actorId: c.get('user')!.id, targetType: 'service', targetId: key, detail: 'deleted' });
  return ok(c, { success: true, service: await describeService(c.env, def) });
});

const testSchema = z.object({
  /** mail 测试用：收件地址 */
  to: z.string().email().optional(),
});

/** POST /:key/test — 连通测试 */
app.post('/:key/test', async (c) => {
  const key = c.req.param('key');
  const def = serviceDef(key);
  if (!def) throw errors.notFound('未知服务');
  const body = await parseJson(c, testSchema).catch(() => ({ to: undefined }));

  if (key === 'mail') {
    if (!body.to) throw errors.badRequest('请填写测试收件邮箱', 'MAIL_TO_REQUIRED');
    const html = emailShell(
      '星辰旅人论坛 · 测试邮件',
      `<p>这是一封来自管理后台的测试邮件。收到即代表 Resend 配置可用。</p><p class="text-muted" style="color:#888;font-size:12px">${nowIso()}</p>`,
      c.env.SITE_URL,
    );
    // emailShell 返回完整 html，text 版本由 deliver 内部生成——直接复用 deliverViaResend
    const result = await deliverViaResend(c.env, [body.to], '星辰旅人论坛 · 测试邮件', html, '这是一封来自管理后台的测试邮件。');
    return ok(c, result);
  }

  if (key === 's3') {
    return ok(c, await s3Test(c.env));
  }

  if (key === 'oauth-github') {
    const cfg = await getGithubConfig(c.env, 'github');
    if (!cfg) return ok(c, { ok: false, message: '尚未配置 client_id / client_secret' });
    if (!/^Ov23li|^Iv1\./.test(cfg.client_id)) {
      return ok(c, { ok: false, message: `client_id 格式可疑：${cfg.client_id.slice(0, 8)}…（GitHub 通常为 Ov23li… 或 Iv1.开头）` });
    }
    return ok(c, { ok: true, message: `凭据已配置（client_id=${cfg.client_id}）。回调地址须为 https://i.182030.xyz/oauth/callback/github，以登录页实际跳转为准。` });
  }

  throw errors.badRequest('该服务不支持测试', 'NOT_TESTABLE');
});

export default app;
