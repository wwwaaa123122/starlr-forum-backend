/**
 * /api/admin/sso/* 单测：配置读写、origin 归一化校验、审计记录、权限。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { createUser, req } from './helpers';

let adminToken = '';

beforeAll(async () => {
  const admin = await createUser({ username: 'ssoadmin' });
  await env.DB.prepare(`UPDATE users SET role='admin' WHERE username='ssoadmin'`).run();
  adminToken = admin.accessToken;
  await env.CACHE.delete('config:sso');
});

const getConfig = () => req<{ enabled: boolean; origins: string[]; source: string }>('/api/admin/sso/config', { token: adminToken });
const putConfig = (body: unknown) => req('/api/admin/sso/config', { method: 'PUT', token: adminToken, body });

describe('GET /api/admin/sso/config', () => {
  it('无 KV 配置时回退默认（enabled/origins 有值）', async () => {
    const res = await getConfig();
    expect(res.status).toBe(200);
    expect(typeof res.body.enabled).toBe('boolean');
    expect(Array.isArray(res.body.origins)).toBe(true);
    expect(res.body.origins.length).toBeGreaterThan(0); // 默认白名单不为空
  });

  it('非管理员 403', async () => {
    const user = await createUser({ username: 'ssouser' });
    expect((await req('/api/admin/sso/config', { token: user.accessToken })).status).toBe(403);
  });
});

describe('PUT /api/admin/sso/config', () => {
  it('正常保存：enabled + origins 去重、origin 归一化（去尾斜杠）', async () => {
    const res = await putConfig({
      enabled: true,
      origins: ['https://a.example.com', 'https://a.example.com/', 'https://b.example.com'],
    });
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    // 保存的两条 + 自动追加的 app-auth 桥接源（设计如此：老 APK 登录兜底，不得删）
    expect(res.body.origins).toContain('https://a.example.com');
    expect(res.body.origins).toContain('https://b.example.com');
    expect(res.body.source).toBe('kv');

    // GET 读回一致（含桥接源）
    const cfg = await getConfig();
    expect(cfg.body.origins).toEqual(expect.arrayContaining(['https://a.example.com', 'https://b.example.com']));
  });

  it('origin 带路径/参数被拒绝', async () => {
    expect((await putConfig({ enabled: true, origins: ['https://a.com/path'] })).status).toBe(400);
    expect((await putConfig({ enabled: true, origins: ['https://a.com?x=1'] })).status).toBe(400);
    expect((await putConfig({ enabled: true, origins: ['https://a.com#frag'] })).status).toBe(400);
  });

  it('带凭据的 origin（user:pass@）被拒绝', async () => {
    expect((await putConfig({ enabled: true, origins: ['https://user:pass@a.com'] })).status).toBe(400);
  });

  it('非 http(s) 协议被拒绝', async () => {
    expect((await putConfig({ enabled: true, origins: ['ftp://a.com'] })).status).toBe(400);
    expect((await putConfig({ enabled: true, origins: ['javascript:alert(1)'] })).status).toBe(400);
  });

  it('格式完全非法的字符串被拒绝', async () => {
    expect((await putConfig({ enabled: true, origins: ['not-a-url'] })).status).toBe(400);
  });

  it('空白名单被拒绝（至少保留一个源）', async () => {
    expect((await putConfig({ enabled: true, origins: [] })).status).toBe(400);
  });

  it('关闭开关：enabled=false 保存并读回', async () => {
    const res = await putConfig({ enabled: false, origins: ['https://a.example.com'] });
    expect(res.status).toBe(200);
    expect((await getConfig()).body.enabled).toBe(false);
    // 还原开启
    await putConfig({ enabled: true, origins: ['https://a.example.com'] });
  });

  it('改动写入审计日志（admin.sso.update）', async () => {
    const adminId = await env.DB.prepare(`SELECT id FROM users WHERE username = 'ssoadmin'`).first<{ id: string }>();
    await putConfig({ enabled: true, origins: ['https://audit.example.com'] });
    const log = await env.DB.prepare(
      `SELECT detail FROM audit_logs WHERE actor_id = ? AND action = 'admin.sso.update' ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(adminId!.id)
      .first<{ detail: string }>();
    expect(log).not.toBeNull();
    expect(log!.detail).toContain('https://audit.example.com');
  });

  it('origins 超 50 个被拒绝', async () => {
    const many = Array.from({ length: 51 }, (_, i) => `https://h${i}.example.com`);
    expect((await putConfig({ enabled: true, origins: many })).status).toBe(400);
  });
});
