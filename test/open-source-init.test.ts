/**
 * 开源初始化适配回归测试：
 *  - 首个注册用户自动成为管理员（且只有一个）
 *  - 站点初始化开关（注册总开关 / 邮箱非必填）
 *  - 站点信息（config:site）读写与 /api/config 暴露
 */
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { createUser, req } from './helpers';

const DB = () => (env as unknown as { DB: D1Database }).DB;
const CACHE = () => (env as unknown as { CACHE: KVNamespace }).CACHE;

describe('首个注册用户自动成为管理员', () => {
  it('全新站点：第一个注册者 role=admin 且邮箱视为已验证', async () => {
    const res = await req<{ user: { role: string; emailVerified: boolean } }>('/api/auth/register', {
      method: 'POST',
      body: { username: 'bootstrap1', email: 'bootstrap1@test.local', password: 'BootPass2026!' },
    });
    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('admin');
    expect(res.body.user.emailVerified).toBe(true);
  });

  it('第二个注册者是普通用户（不会产生多个初始管理员）', async () => {
    const first = await req<{ user: { role: string } }>('/api/auth/register', {
      method: 'POST',
      body: { username: 'bootstrap2', email: 'bootstrap2@test.local', password: 'BootPass2026!' },
    });
    expect(first.body.user.role).toBe('admin');

    const second = await req<{ user: { role: string } }>('/api/auth/register', {
      method: 'POST',
      body: { username: 'bootstrap3', email: 'bootstrap3@test.local', password: 'BootPass2026!' },
    });
    expect(second.status).toBe(201);
    expect(second.body.user.role).toBe('user');

    const admins = await DB().prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin'`).first<{ n: number }>();
    expect(admins!.n).toBe(1);
  });

  it('管理员被删除后，新注册者不会自动获得管理员（不白送权限）', async () => {
    await req('/api/auth/register', {
      method: 'POST',
      body: { username: 'bootstrap4', email: 'bootstrap4@test.local', password: 'BootPass2026!' },
    });
    // 已有普通用户后删除全部管理员，模拟「管理员账号被误删」
    await createUser({ username: 'bootstrap5' });
    await DB().prepare(`UPDATE users SET role = 'user' WHERE role = 'admin'`).run();

    const later = await req<{ user: { role: string } }>('/api/auth/register', {
      method: 'POST',
      body: { username: 'bootstrap6', email: 'bootstrap6@test.local', password: 'BootPass2026!' },
    });
    expect(later.body.user.role).toBe('user');
  });
});

describe('站点初始化开关', () => {
  it('关闭注册后注册接口返回 403 REGISTRATION_CLOSED', async () => {
    await CACHE().put(
      'config:setup',
      JSON.stringify({ registration_enabled: false, registration_email_required: true, uploads_storage: 'r2' }),
    );
    const res = await req<{ error: { code: string } }>('/api/auth/register', {
      method: 'POST',
      body: { username: 'closed1', email: 'closed1@test.local', password: 'ClosedPass2026!' },
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('REGISTRATION_CLOSED');
  });

  it('邮箱非必填：只给用户名+密码即可注册，账号直接激活', async () => {
    await CACHE().put(
      'config:setup',
      JSON.stringify({ registration_enabled: true, registration_email_required: false, uploads_storage: 'r2' }),
    );
    // 先占位一个用户，避免首个用户被提升为管理员干扰断言
    await createUser({ username: 'noemailseed' });
    const res = await req<{ user: { role: string; emailVerified: boolean } }>('/api/auth/register', {
      method: 'POST',
      body: { username: 'noemail1', password: 'NoMailPass2026!' },
    });
    expect(res.status).toBe(201);
    expect(res.body.user.emailVerified).toBe(true);
    expect(res.body.user.role).toBe('user');

    // 用用户名 + 密码可直接登录
    const login = await req('/api/auth/login', {
      method: 'POST',
      body: { identifier: 'noemail1', password: 'NoMailPass2026!' },
    });
    expect(login.status).toBe(200);
  });

  it('邮箱必填时缺邮箱返回 400', async () => {
    await CACHE().put(
      'config:setup',
      JSON.stringify({ registration_enabled: true, registration_email_required: true, uploads_storage: 'r2' }),
    );
    const res = await req('/api/auth/register', {
      method: 'POST',
      body: { username: 'needmail1', password: 'NeedMail2026!' },
    });
    expect(res.status).toBe(400);
  });
});

describe('站点信息配置', () => {
  it('/api/config 暴露站点信息与注册开关', async () => {
    const res = await req<{ siteName: string; siteTagline: string; registrationEnabled: boolean; emailRequired: boolean }>(
      '/api/config',
    );
    expect(res.status).toBe(200);
    expect(typeof res.body.siteName).toBe('string');
    expect(res.body.siteName.length).toBeGreaterThan(0);
    expect(typeof res.body.registrationEnabled).toBe('boolean');
    expect(typeof res.body.emailRequired).toBe('boolean');
  });

  it('管理端可改站点名，改后 /api/config 立即生效', async () => {
    const admin = await createUser({ username: 'siteadmin', role: 'admin' });
    const patch = await req<{ site: { site_name: string } }>('/api/admin/services/site', {
      method: 'PATCH',
      token: admin.accessToken,
      body: { site_name: '我的论坛', site_tagline: '自部署测试' },
    });
    expect(patch.status).toBe(200);
    expect(patch.body.site.site_name).toBe('我的论坛');

    const cfg = await req<{ siteName: string }>('/api/config');
    expect(cfg.body.siteName).toBe('我的论坛');
  });

  it('普通用户不能修改站点信息（403）', async () => {
    const user = await createUser({ username: 'siteuser' });
    const patch = await req('/api/admin/services/site', {
      method: 'PATCH',
      token: user.accessToken,
      body: { site_name: '劫持站点' },
    });
    expect(patch.status).toBe(403);
  });
});
