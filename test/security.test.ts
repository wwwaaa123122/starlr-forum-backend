/**
 * 安全测试：JWT 算法混淆 / iss / aud / 过期 / Replay / 恶意上传 / 暴力登录 / 限流
 */
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createUser, createPost, req, login, forgeToken, baseClaims } from './helpers';
import app from '../src/index';
import type { Env } from '../src/types';

type BlobPart = ArrayBuffer | ArrayBufferView | Blob | string;

describe('JWT 校验（算法混淆 / none / iss / aud / exp / iat）', () => {
  it('拒绝 alg:none', async () => {
    const token = await forgeToken(baseClaims(), { alg: 'none' });
    const res = await req('/api/me', { token });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_TOKEN');
  });

  it('拒绝错误 iss', async () => {
    const token = await forgeToken(baseClaims({ iss: 'https://evil.example.com' }));
    const res = await req('/api/me', { token });
    expect(res.status).toBe(401);
  });

  it('拒绝错误 aud', async () => {
    const token = await forgeToken(baseClaims({ aud: 'admin-panel' }));
    const res = await req('/api/me', { token });
    expect(res.status).toBe(401);
  });

  it('拒绝过期 Token', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await forgeToken(baseClaims({ iat: now - 7200, exp: now - 3600 }));
    const res = await req('/api/me', { token });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_EXPIRED');
  });

  it('拒绝未来的 iat（未生效 Token）', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await forgeToken(baseClaims({ iat: now + 3600, exp: now + 7200 }));
    const res = await req('/api/me', { token });
    expect(res.status).toBe(401);
  });

  it('未知 kid 被拒绝', async () => {
    const token = await forgeToken(baseClaims(), { kid: 'attacker-key' });
    const res = await req('/api/me', { token });
    expect(res.status).toBe(401);
  });

  it('畸形 Token / 空字符串被拒绝', async () => {
    expect((await req('/api/me', { token: 'abc' })).status).toBe(401);
    expect((await req('/api/me', { token: 'a.b.c' })).status).toBe(401);
    expect((await req('/api/me', { token: '' })).status).toBe(401);
    expect((await req('/api/me', { headers: { Authorization: 'Basic dXNlcjpwYXNz' } })).status).toBe(401);
  });

  it('typ 必须是 access（未来 id_token 不可用于 API 认证）', async () => {
    const token = await forgeToken(baseClaims({ typ: 'id_token' }));
    const res = await req('/api/me', { token });
    expect(res.status).toBe(401);
  });

  it('JWT 中不包含密码等敏感字段', async () => {
    const user = await createUser({ username: 'nocredentials' });
    const payload = JSON.parse(atob(user.accessToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    const serialized = JSON.stringify(payload).toLowerCase();
    expect(serialized).not.toContain('password');
    expect(serialized).not.toContain('email');
    expect(Object.keys(payload).sort()).toEqual(['aud', 'exp', 'iat', 'iss', 'jti', 'role', 'sid', 'sub', 'typ']);
  });
});

describe('Refresh Token Replay', () => {
  it('重放被拒绝并撤销整链', async () => {
    const user = await createUser({ username: 'secreplay' });
    const r1 = await req('/api/auth/refresh', { method: 'POST', body: { refreshToken: user.refreshToken } });
    const replay = await req('/api/auth/refresh', { method: 'POST', body: { refreshToken: user.refreshToken } });
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('TOKEN_REPLAY');

    const child = r1.body.refreshToken;
    const after = await req('/api/auth/refresh', { method: 'POST', body: { refreshToken: child } });
    expect(after.status).toBe(401);

    // 数据库记录撤销原因
    const { results } = await (env.DB as unknown as D1Database)
      .prepare("SELECT revoked_reason FROM refresh_tokens WHERE revoked_at IS NOT NULL AND revoked_reason = 'refresh_token_replay'")
      .all<{ revoked_reason: string }>();
    expect(results!.length).toBeGreaterThanOrEqual(2);
  });

  it('随机伪造的 Refresh Token 返回 invalid', async () => {
    const res = await req('/api/auth/refresh', { method: 'POST', body: { refreshToken: 'totally-fake-token-123456' } });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_TOKEN');
  });
});

describe('恶意上传', () => {
  async function upload(token: string, bytes: Uint8Array, mime: string, filename = 'file') {
    const form = new FormData();
    form.append('file', new File([bytes as unknown as BlobPart], filename, { type: mime }));
    return app.request(
      '/api/upload',
      { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form },
      env as unknown as Env,
    );
  }

  it('合法 PNG 可以上传并生成 R2 键', async () => {
    const user = await createUser({ username: 'pnguser' });
    // 1x1 PNG
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00,
      0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
      0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d,
      0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ]);
    const res = await upload(user.accessToken, png, 'image/png', 'avatar.png');
    expect(res.status).toBe(201);
    const body = (await res.json()) as { key: string; url: string };
    expect(body.key).toMatch(/^uploads\//);
  });

  it('可执行文件（ELF/Shell）即使声明为图片也被魔数校验拒绝', async () => {
    const user = await createUser({ username: 'elfuser' });
    // ELF magic + shell 脚本声明为 PNG
    const fake = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]);
    const res = await upload(user.accessToken, fake, 'image/png', 'shell.png');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('INVALID_FILE');

    const sh = new TextEncoder().encode('#!/bin/sh\nrm -rf /\n');
    const res2 = await upload(user.accessToken, sh, 'image/jpeg', 'evil.jpg');
    expect(res2.status).toBe(400);
  });

  it('HTML 文件伪装成图片被拒绝（存储型 XSS 防护）', async () => {
    const user = await createUser({ username: 'htmluser' });
    const html = new TextEncoder().encode('<script>alert("xss")</script>');
    const res = await upload(user.accessToken, html, 'image/png', 'xss.png');
    expect(res.status).toBe(400);
  });

  it('不允许的类型（application/pdf、exe 声明）被拒绝', async () => {
    const user = await createUser({ username: 'pdfuser' });
    const res = await upload(user.accessToken, new TextEncoder().encode('%PDF-1.4'), 'application/pdf', 'doc.pdf');
    expect(res.status).toBe(400);
    const res2 = await upload(user.accessToken, new Uint8Array([0x4d, 0x5a, 0x90, 0x00]), 'application/octet-stream', 'a.exe');
    expect(res2.status).toBe(400);
  });

  it('未登录不能上传', async () => {
    const res = await upload('invalid', new Uint8Array([0x89, 0x50]), 'image/png');
    expect(res.status).toBe(401);
  });
});

describe('暴力登录与限流', () => {
  it('登录失败超过阈值后被限流（429）', async () => {
    const target = await createUser({ username: 'bruteforce' });
    let lastStatus = 0;
    // login 限流：10 次 / 600 秒（按 CF-Connecting-IP 指纹）
    for (let i = 0; i < 12; i++) {
      const res = await req('/api/auth/login', {
        method: 'POST',
        headers: { 'cf-connecting-ip': '10.200.0.9' }, // 固定客户端 IP → 同一限流指纹
        body: { identifier: target.username, password: 'WrongPassword!' },
      });
      lastStatus = res.status;
      if (res.status === 429) break;
    }
    expect(lastStatus).toBe(429);
  });

  it('限流后正确请求也被拒绝（429 响应结构统一）', async () => {
    let lastStatus = 0;
    for (let i = 0; i < 12; i++) {
      const r = await req('/api/auth/login', {
        method: 'POST',
        headers: { 'cf-connecting-ip': '10.200.0.10' },
        body: { identifier: 'anyone', password: 'x' },
      });
      lastStatus = r.status;
      if (r.status === 429) break;
    }
    expect(lastStatus).toBe(429);
    const res = await req('/api/auth/login', {
      method: 'POST',
      headers: { 'cf-connecting-ip': '10.200.0.10' },
      body: { identifier: 'anyone', password: 'x' },
    });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
  });

  it('正常用户（不同客户端 IP 指纹）不受影响', async () => {
    const user = await createUser({ username: 'ratelimitclean' });
    const res = await login(user.username, user.password);
    expect(res.status).toBe(200);
  });
});

describe('SQL 注入', () => {
  it('所有注入尝试均被参数化拦截', async () => {
    await createUser({ username: 'sqliowner' });
    const payload = "sqli' OR '1'='1";
    // 用户搜索
    const search = await req(`/api/search?q=${encodeURIComponent(payload)}&type=user`);
    expect(search.status).toBe(200);
    // 登录
    const loginRes = await req('/api/auth/login', {
      method: 'POST',
      body: { identifier: payload, password: payload },
    });
    expect([200, 401, 400]).toContain(loginRes.status);
    // 帖子列表分类参数
    const list = await req(`/api/posts?category=${encodeURIComponent("' OR '1'='1")}`);
    expect(list.status).toBe(200);
  });

  it('DROP TABLE 尝试后数据库仍然可用', async () => {
    await req(`/api/search?q=${encodeURIComponent("'; DROP TABLE posts; --")}`);
    const list = await req('/api/posts');
    expect(list.status).toBe(200);
    const tables = await (env.DB as unknown as D1Database)
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='posts'")
      .all();
    expect(tables.results!.length).toBe(1);
  });
});

describe('XSS 防护（服务端配合）', () => {
  it('恶意 Markdown 原样存储（渲染由客户端白名单 sanitize，不执行）', async () => {
    const author = await createUser({ username: 'xssauthor' });
    const malicious = '正常文字 <script>alert(1)</script> [link](javascript:alert(1)) <img src=x onerror=alert(1)>';
    const { id } = (await createPost(author.accessToken, { content: malicious })).body;
    const detail = await req(`/api/posts/${id}`);
    // 内容保存为纯文本（不做 HTML 白名单过滤——由客户端 rehype-sanitize 渲染层保证安全）
    expect(detail.body.post.content).toContain('<script>');
  });

  it('错误格式返回统一 JSON，不泄露堆栈', async () => {
    const res = await req('/api/auth/register', { method: 'POST', body: { invalid: 'shape' } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(res.body)).not.toMatch(/at .*\(/); // 无堆栈
    expect(res.body.error.message).not.toContain('ZodError');
  });
});

describe('OAuth/OIDC 基础设施', () => {
  it('openid-configuration 元数据完整', async () => {
    const res = await req('/.well-known/openid-configuration');
    expect(res.status).toBe(200);
    expect(res.body.issuer).toBe('https://forum.test');
    expect(res.body.jwks_uri).toContain('/.well-known/jwks.json');
    expect(res.body.id_token_signing_alg_values_supported).toContain('RS256');
    expect(res.body.code_challenge_methods_supported).toContain('S256');
    expect(res.body.grant_types_supported).toContain('authorization_code');
  });

  it('OAuth 端点已预留（返回 501 而非 404）', async () => {
    expect((await req('/oauth/authorize')).status).toBe(501);
    expect((await req('/oauth/token', { method: 'POST' })).status).toBe(501);
    expect((await req('/oauth/revoke', { method: 'POST' })).status).toBe(501);
  });
});

describe('统一错误格式与 404', () => {
  it('未知 API 返回 JSON 404', async () => {
    const res = await req('/api/nonexistent');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('健康检查', async () => {
    const res = await req('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});
