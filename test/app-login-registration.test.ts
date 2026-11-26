/**
 * App 登录桥接（/api/auth/app-login/*）必须遵守站点的注册开关。
 * 历史问题：/prepare 的注册分支完全不读 config:setup，后台关闭注册后 App 端仍能建号。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { env } from 'cloudflare:test';
import { createUser, req } from './helpers';

const SETUP_KEY = 'config:setup';

describe('App 登录桥接：注册开关', () => {
  beforeAll(async () => {
    await env.CACHE.delete(SETUP_KEY);
    // 建一个已存在用户，供「登录模式不受注册开关影响」用例使用
    await createUser({ username: 'apploginuser' });
  });

  afterAll(async () => {
    await env.CACHE.delete(SETUP_KEY);
  });

  it('关闭注册后 /app-login/prepare 注册被拒绝（403 REGISTRATION_CLOSED）', async () => {
    await env.CACHE.put(
      SETUP_KEY,
      JSON.stringify({ registration_enabled: false, registration_email_required: true, uploads_storage: 'r2' }),
    );
    const res = await req('/api/auth/app-login/prepare', {
      method: 'POST',
      body: { mode: 'register', username: 'appregblocked', email: 'appregblocked@test.local', password: 'TestPass2026!' },
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('REGISTRATION_CLOSED');
  });

  it('登录模式不受注册开关影响', async () => {
    await env.CACHE.put(
      SETUP_KEY,
      JSON.stringify({ registration_enabled: false, registration_email_required: true, uploads_storage: 'r2' }),
    );
    const res = await req('/api/auth/app-login/prepare', {
      method: 'POST',
      body: { mode: 'login', identifier: 'apploginuser', password: 'TestPass2026!' },
    });
    expect(res.status).toBe(200);
    expect(typeof res.body.preauth).toBe('string');
  });

  it('开放注册时注册分支正常工作', async () => {
    await env.CACHE.delete(SETUP_KEY);
    const res = await req('/api/auth/app-login/prepare', {
      method: 'POST',
      body: { mode: 'register', username: 'appregopen', email: 'appregopen@test.local', password: 'TestPass2026!' },
    });
    expect(res.status).toBe(200);
    expect(typeof res.body.preauth).toBe('string');
  });
});
