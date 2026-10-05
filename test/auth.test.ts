/**
 * 用户与认证测试：注册 / 登录 / JWT 结构 / Refresh Rotation / Logout
 */
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createUser, login, req, forgeToken, baseClaims } from './helpers';

describe('注册', () => {
  it('成功注册并返回用户与 Token', async () => {
    const res = await createUser({ username: 'alice' });
    expect(res.username).toBe('alice');
    expect(res.accessToken.split('.').length).toBe(3);
  });

  it('用户名唯一（重复注册 409，统一提示防枚举）', async () => {
    await createUser({ username: 'dupuser' });
    const res = await req('/api/auth/register', {
      method: 'POST',
      body: { username: 'dupuser', email: 'other@test.local', password: 'TestPass2026!' },
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('USER_EXISTS');
    // 统一提示：不区分是用户名还是邮箱冲突
    expect(res.body.error.message).toBe('用户名或邮箱已被使用');
  });

  it('邮箱唯一', async () => {
    await createUser({ username: 'mailone', email: 'same@test.local' });
    const res = await req('/api/auth/register', {
      method: 'POST',
      body: { username: 'mailtwo', email: 'same@test.local', password: 'TestPass2026!' },
    });
    expect(res.status).toBe(409);
  });

  it('弱密码被拒绝', async () => {
    const res = await req('/api/auth/register', {
      method: 'POST',
      body: { username: 'weakpw', email: 'weak@test.local', password: 'password' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('WEAK_PASSWORD');
  });

  it('非法用户名被拒绝', async () => {
    const res = await req('/api/auth/register', {
      method: 'POST',
      body: { username: 'bad name!@#', email: 'bad@test.local', password: 'TestPass2026!' },
    });
    expect(res.status).toBe(400);
  });

  it('密码哈希不落明文（PBKDF2 格式）', async () => {
    const user = await createUser({ username: 'hashcheck' });
    const { results } = await (env.DB as unknown as D1Database)
      .prepare('SELECT password_hash FROM users WHERE id = ?')
      .bind(user.id)
      .all<{ password_hash: string }>();
    expect(results![0].password_hash).toMatch(/^pbkdf2\$sha256\$\d+\$/);
  });
});

describe('登录', () => {
  it('支持用户名与邮箱登录', async () => {
    const user = await createUser({ username: 'loginuser' });
    const byName = await login('loginuser', user.password);
    expect(byName.status).toBe(200);
    expect(byName.body.user.username).toBe('loginuser');

    const byEmail = await login(user.email, user.password);
    expect(byEmail.status).toBe(200);
  });

  it('错误密码返回统一 401（防用户名枚举）', async () => {
    const user = await createUser({ username: 'wrongpw' });
    const bad = await login(user.username, 'WrongPass999!');
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe('INVALID_CREDENTIALS');

    const ghost = await login('never-exists', 'whatever123');
    expect(ghost.status).toBe(401);
    expect(ghost.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(ghost.body.error.message).toBe(bad.body.error.message);
  });
});

describe('JWT Access Token（24h）', () => {
  it('claims 完整：iss/sub(稳定ID)/aud/iat/exp/jti，sub 不是用户名', async () => {
    const user = await createUser({ username: 'claimsuser' });
    const payload = JSON.parse(atob(user.accessToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    expect(payload.iss).toBe('https://forum.test');
    expect(payload.aud).toBe('api');
    expect(payload.sub).toBe(user.id);
    expect(payload.sub).not.toBe('claimsuser');
    expect(payload.jti).toBeTruthy();
    expect(payload.exp - payload.iat).toBe(86400); // 24 小时
    expect(typeof payload.jti).toBe('string');
  });

  it('JWT Header 带 kid 且算法固定 RS256', async () => {
    const user = await createUser({ username: 'headeruser' });
    const header = JSON.parse(atob(user.accessToken.split('.')[0].replace(/-/g, '+').replace(/_/g, '/')));
    expect(header.alg).toBe('RS256');
    expect(header.kid).toBe('test-key-1');
    expect(header.typ).toBe('JWT');
  });

  it('JWKS 公开公钥且不泄露私钥参数', async () => {
    const res = await req('/.well-known/jwks.json');
    expect(res.status).toBe(200);
    const key = res.body.keys[0];
    expect(key.kty).toBe('RSA');
    expect(key.alg).toBe('RS256');
    expect(key.kid).toBe('test-key-1');
    expect(key.n).toBeTruthy();
    expect(key.e).toBeTruthy();
    expect(key.d).toBeUndefined(); // 私钥参数绝不公开
    expect(key.p).toBeUndefined();
  });
});

describe('Refresh Token Rotation', () => {
  it('刷新成功返回全新 Token 对，旧 Token 立即失效', async () => {
    const user = await createUser({ username: 'rotuser' });

    const r1 = await req('/api/auth/refresh', { method: 'POST', body: { refreshToken: user.refreshToken } });
    expect(r1.status).toBe(200);
    expect(r1.body.refreshToken).not.toBe(user.refreshToken);
    expect(r1.body.accessToken).not.toBe(user.accessToken);

    // 旧 Refresh Token 已轮换：再次使用属于 Replay
    const replay = await req('/api/auth/refresh', { method: 'POST', body: { refreshToken: user.refreshToken } });
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('TOKEN_REPLAY');
  });

  it('检测到 Replay 时撤销整条链（孙 Token 也失效）', async () => {
    const user = await createUser({ username: 'chainuser' });

    // 链：T0 → T1 → T2
    const r1 = await req('/api/auth/refresh', { method: 'POST', body: { refreshToken: user.refreshToken } });
    const t1 = r1.body.refreshToken;
    const r2 = await req('/api/auth/refresh', { method: 'POST', body: { refreshToken: t1 } });
    const t2 = r2.body.refreshToken;
    expect(t2).not.toBe(t1);

    // 用 T0 重放 → 整链撤销
    const replay = await req('/api/auth/refresh', { method: 'POST', body: { refreshToken: user.refreshToken } });
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('TOKEN_REPLAY');

    // T2 已属于被撤销的链
    const after = await req('/api/auth/refresh', { method: 'POST', body: { refreshToken: t2 } });
    expect(after.status).toBe(401);
  });

  it('数据库只保存 Token 哈希', async () => {
    const user = await createUser({ username: 'hashonly' });
    const { results } = await (env.DB as unknown as D1Database)
      .prepare('SELECT token_hash FROM refresh_tokens WHERE user_id = ?')
      .bind(user.id)
      .all<{ token_hash: string }>();
    expect(results!.length).toBe(1);
    // 64 位 hex = SHA-256
    expect(results![0].token_hash).toMatch(/^[a-f0-9]{64}$/);
    // 明文不出现
    expect(results![0].token_hash).not.toContain(user.refreshToken);
  });

  it('登出后链被撤销，刷新失败', async () => {
    const user = await createUser({ username: 'logoutuser' });
    const out = await req('/api/auth/logout', { method: 'POST', body: { refreshToken: user.refreshToken } });
    expect(out.status).toBe(200);

    const refreshed = await req('/api/auth/refresh', { method: 'POST', body: { refreshToken: user.refreshToken } });
    expect(refreshed.status).toBe(401);
  });

  it('登出所有设备（logout-all）', async () => {
    const user = await createUser({ username: 'logoutall' });
    const out = await req('/api/auth/logout-all', { method: 'POST', token: user.accessToken });
    expect(out.status).toBe(200);
    const refreshed = await req('/api/auth/refresh', { method: 'POST', body: { refreshToken: user.refreshToken } });
    expect(refreshed.status).toBe(401);
  });
});

describe('用户资料', () => {
  it('GET /api/me 返回当前用户', async () => {
    const user = await createUser({ username: 'meuser' });
    const res = await req('/api/me', { token: user.accessToken });
    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe('meuser');
  });

  it('未登录访问 /api/me 返回 401', async () => {
    const res = await req('/api/me');
    expect(res.status).toBe(401);
  });

  it('PATCH /api/me 更新昵称与签名', async () => {
    const user = await createUser({ username: 'profileuser' });
    const res = await req('/api/me', {
      method: 'PATCH',
      token: user.accessToken,
      body: { nickname: '新昵称', bio: '这是**签名**' },
    });
    expect(res.status).toBe(200);
    const me = await req('/api/me', { token: user.accessToken });
    expect(me.body.user.nickname).toBe('新昵称');
    expect(me.body.user.bio).toBe('这是**签名**');
  });

  it('用户主页公开', async () => {
    const user = await createUser({ username: 'homepage' });
    const res = await req(`/api/users/${user.username}`);
    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe('homepage');
    expect(res.body.user.email).toBeUndefined(); // 邮箱不公开
  });

  it('伪造 Token 无法访问（签名验证）', async () => {
    const token = await forgeToken(baseClaims(), { tamperSignature: true });
    const res = await req('/api/me', { token });
    expect(res.status).toBe(401);
  });

  it('不存在的用户 ID 的合法签名 Token 也被拒（sub 必须真实存在）', async () => {
    const token = await forgeToken(baseClaims({ sub: 'ghostuser000000' }));
    const res = await req('/api/me', { token });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_TOKEN');
  });
});
