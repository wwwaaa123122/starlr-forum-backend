/**
 * 服务配置接口单测：掩码回显、保存语义（空串保持/短横线清除/普通字段直写）、
 * 清空回退 env、来源标注、权限。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { createUser, req } from './helpers';

let adminToken = '';

beforeAll(async () => {
  const admin = await createUser({ username: 'svcadmin' });
  await env.DB.prepare(`UPDATE users SET role='admin' WHERE username='svcadmin'`).run();
  adminToken = admin.accessToken;
});

const services = () => req<{ services: { key: string; configured: boolean; fields: { name: string; value: string | null; source: string | null; secret: boolean }[] }[] }>('/api/admin/services', { token: adminToken });

describe('GET /api/admin/services', () => {
  it('返回全部服务且不含明文 secret', async () => {
    const res = await services();
    expect(res.status).toBe(200);
    const keys = res.body.services.map((s) => s.key);
    // 核心服务必须出现
    for (const k of ['mail', 's3', 'seo', 'oauth-github']) expect(keys).toContain(k);
    // 任何 secret 字段不得出现完整明文
    const raw = JSON.stringify(res.body);
    expect(raw).not.toMatch(/"value":"[^"]{12,}"/); // 掩码形如 ••••••••xxxx
  });

  it('非管理员 403', async () => {
    const user = await createUser({ username: 'svcuser' });
    expect((await req('/api/admin/services', { token: user.accessToken })).status).toBe(403);
  });

  it('未配置的服务：configured=false，secret 字段 value=null', async () => {
    await env.CACHE.delete('config:seo');
    const res = await services();
    const seo = res.body.services.find((s) => s.key === 'seo')!;
    expect(seo.configured).toBe(false);
    const token = seo.fields.find((f) => f.name === 'baidu_push_token')!;
    expect(token.value).toBeNull();
    expect(token.secret).toBe(true);
  });
});

describe('PUT /api/admin/services/:key（保存语义）', () => {
  it('普通字段直写、secret 字段掩码回显（只露末 4 位）', async () => {
    const put = await req('/api/admin/services/seo', {
      method: 'PUT',
      token: adminToken,
      body: { values: { canonical_host: 'blog.example.com', baidu_push_token: 'super-secret-token-9999' } },
    });
    expect(put.status).toBe(200);

    const res = await services();
    const seo = res.body.services.find((s) => s.key === 'seo')!;
    const host = seo.fields.find((f) => f.name === 'canonical_host')!;
    const tok = seo.fields.find((f) => f.name === 'baidu_push_token')!;
    expect(host.value).toBe('blog.example.com'); // 普通字段明文
    expect(host.source).toBe('kv');
    expect(tok.value).toBe('••••••••9999'); // secret 只露末 4 位
    expect(JSON.stringify(res.body)).not.toContain('super-secret-token-9999');
  });

  it('secret 传空串 = 保持原值；传 "-" = 清除该字段', async () => {
    // 先写入
    await req('/api/admin/services/seo', { method: 'PUT', token: adminToken, body: { values: { baidu_push_token: 'keep-me-token-8888' } } });
    // 空串 → 保持
    await req('/api/admin/services/seo', { method: 'PUT', token: adminToken, body: { values: { baidu_push_token: '' } } });
    let res = await services();
    expect(res.body.services.find((s) => s.key === 'seo')!.fields.find((f) => f.name === 'baidu_push_token')!.value).toBe('••••••••8888');
    // "-" → 清除
    await req('/api/admin/services/seo', { method: 'PUT', token: adminToken, body: { values: { baidu_push_token: '-' } } });
    res = await services();
    expect(res.body.services.find((s) => s.key === 'seo')!.fields.find((f) => f.name === 'baidu_push_token')!.value).toBeNull();
  });

  it('DELETE /:key 清空回退：字段值变 null', async () => {
    await req('/api/admin/services/seo', { method: 'PUT', token: adminToken, body: { values: { canonical_host: 'temp.example.com' } } });
    const del = await req('/api/admin/services/seo', { method: 'DELETE', token: adminToken });
    expect(del.status).toBe(200);
    const res = await services();
    expect(res.body.services.find((s) => s.key === 'seo')!.fields.find((f) => f.name === 'canonical_host')!.value).toBeNull();
  });

  it('未知服务 key 返回 404', async () => {
    expect((await req('/api/admin/services/no-such', { method: 'PUT', token: adminToken, body: { values: {} } })).status).toBe(404);
    expect((await req('/api/admin/services/no-such', { method: 'DELETE', token: adminToken })).status).toBe(404);
  });

  it('缺少 values 返回 400', async () => {
    expect((await req('/api/admin/services/seo', { method: 'PUT', token: adminToken, body: {} })).status).toBe(400);
  });
});

describe('GET/PATCH /api/admin/services/site（站点信息）', () => {
  it('GET 返回四字段；PATCH 修改后生效（snake_case 字段）', async () => {
    const before = await req<{ site: { site_name: string; site_tagline: string; site_description: string; site_footer: string } }>('/api/admin/services/site', { token: adminToken });
    expect(before.status).toBe(200);
    expect(before.body.site.site_name).toBeTruthy();

    const patch = await req<{ site: { site_name: string } }>('/api/admin/services/site', {
      method: 'PATCH',
      token: adminToken,
      body: { site_name: '配置检查站' },
    });
    expect(patch.status).toBe(200);
    expect(patch.body.site.site_name).toBe('配置检查站');

    // 还原默认名，避免影响其他用例/站点语义
    await req('/api/admin/services/site', { method: 'PATCH', token: adminToken, body: { site_name: 'Starlr Forum' } });
  });

  it('PATCH 空串站点名被拒绝（min 1）', async () => {
    expect((await req('/api/admin/services/site', { method: 'PATCH', token: adminToken, body: { site_name: '' } })).status).toBe(400);
  });

  it('非管理员无权改站点信息', async () => {
    const user = await createUser({ username: 'siteuser' });
    expect((await req('/api/admin/services/site', { method: 'PATCH', token: user.accessToken, body: { site_name: 'x' } })).status).toBe(403);
  });
});

describe('GHSA-mrhx-c7xc-m3w5 防线（超大请求体）', () => {
  it('超过 512KB 的请求体被 400 拒绝（不进入 zod 解析）', async () => {
    // 构造 ~1MB 合法 JSON：海量小键值（真实攻击可达 8M 键导致 OOM，测试用 1MB 验证门）
    const huge: Record<string, string> = {};
    for (let i = 0; i < 24000; i++) huge[`field_${i}_with_padding_for_size`] = 'v'.repeat(10);
    const body = JSON.stringify({ values: huge });
    expect(body.length).toBeGreaterThan(512 * 1024);
    const res = await req('/api/admin/services/seo', { method: 'PUT', token: adminToken, body, headers: { 'Content-Type': 'application/json' } });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('正常大小的请求体不受影响（回归对照）', async () => {
    const res = await req('/api/admin/services/seo', {
      method: 'PUT',
      token: adminToken,
      body: { values: { canonical_host: 'guard.example.com' } },
    });
    expect(res.status).toBe(200);
  });
});
