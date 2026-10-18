/** 测试辅助工具：请求封装、用户注册/登录、JWT 伪造（用于安全用例） */
import { env } from 'cloudflare:test';
import app from '../src/index';
import type { Env } from '../src/types';

export interface ApiResponse<T = any> {
  status: number;
  body: T;
}

let requestCounter = 0;

/**
 * 每次请求使用不同 UA + 不同客户端 IP。
 * 限流键 = SHA-256(CF-Connecting-IP)：轮换 IP 才能避免测试之间触发同一限流指纹；
 * 显式传入 headers 的 cf-connecting-ip 可固定指纹（如爆破限流用例）。
 */
export async function req<T = any>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    token?: string;
    headers?: Record<string, string>;
    /** 模拟 Cloudflare 请求地理数据（request.cf） */
    cf?: Record<string, unknown>;
  } = {},
): Promise<ApiResponse<T>> {
  const seq = requestCounter++;
  const headers: Record<string, string> = {
    'user-agent': `vitest-agent-${seq}`,
    'cf-connecting-ip': `10.64.${Math.floor(seq / 250) % 250}.${(seq % 250) + 1}`,
    ...options.headers,
  };
  // FormData（multipart 上传）不能序列化，也不应手动设置 Content-Type（需保留边界）
  const isForm = options.body instanceof FormData;
  if (options.body !== undefined && !isForm) headers['Content-Type'] = 'application/json';
  if (options.token) headers['Authorization'] = `Bearer ${options.token}`;

  const res = await app.request(
    path,
    {
      method: options.method ?? 'GET',
      headers,
      body: isForm
        ? (options.body as FormData)
        : options.body !== undefined
          ? JSON.stringify(options.body)
          : undefined,
      ...(options.cf ? { cf: options.cf } : {}),
    },
    env as unknown as Env,
  );
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed as T };
}

export interface TestUser {
  id: string;
  uid: number;
  username: string;
  email: string;
  password: string;
  accessToken: string;
  refreshToken: string;
}

let userSeq = 0;

export async function createUser(
  overrides: Partial<{ username: string; email: string; password: string; nickname: string; role: string }> = {},
): Promise<TestUser> {
  userSeq++;
  const username = overrides.username ?? `user${userSeq}_${Math.random().toString(36).slice(2, 6)}`;
  const email = overrides.email ?? `${username}@test.local`;
  const password = overrides.password ?? 'TestPass2026!';

  const res = await req('/api/auth/register', {
    method: 'POST',
    body: { username, email, password, ...(overrides.nickname ? { nickname: overrides.nickname } : {}) },
  });
  if (res.status !== 201) throw new Error(`注册失败: ${res.status} ${JSON.stringify(res.body)}`);
  // 默认视为已验证邮箱（新注册默认未验证，需验证的用例单独覆盖）；
  // 同时把角色重置为普通用户——全新数据库的首个注册者会被自动提升为管理员（站点初始化特性），
  // 测试里需要确定性角色，管理员用例自行 UPDATE 提权。
  await (env as unknown as { DB: { prepare: (q: string) => { bind: (...v: unknown[]) => { run: () => Promise<unknown> } } } })
    .DB.prepare(`UPDATE users SET email_verified = 1, role = ? WHERE username = LOWER(?)`)
    .bind(overrides.role ?? 'user', username)
    .run();
  return {
    id: res.body.user.id,
    uid: res.body.user.uid,
    username,
    email,
    password,
    accessToken: res.body.accessToken,
    refreshToken: res.body.refreshToken,
  };
}

export async function login(identifier: string, password: string) {
  return req('/api/auth/login', { method: 'POST', body: { identifier, password } });
}

export async function createPost(token: string, overrides: Partial<{ title: string; content: string; categoryId: string; tags: string[] }> = {}) {
  const categories = await req<{ categories: { id: string; slug: string }[] }>('/api/categories');
  const categoryId = overrides.categoryId ?? categories.body.categories.find((c) => c.slug === 'tech')!.id;
  const res = await req<{ id: string }>('/api/posts', {
    method: 'POST',
    token,
    body: {
      title: overrides.title ?? '测试帖子标题',
      content: overrides.content ?? '这是测试正文内容，包含 **Markdown**。',
      categoryId,
      tags: overrides.tags ?? ['test'],
    },
  });
  return res;
}

/** 使用测试签名密钥自行签发任意声明的 JWT（用于验证 iss/aud/exp/alg 校验） */
export async function forgeToken(
  claims: Record<string, unknown>,
  options: { alg?: string; kid?: string; tamperSignature?: boolean } = {},
): Promise<string> {
  const keys = JSON.parse((env as unknown as Env).JWT_SIGNING_KEYS ?? '[]') as { kid: string; jwk: JsonWebKey }[];
  const key = keys[0];
  const b64u = (input: string | Uint8Array) => {
    const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
    let bin = '';
    bytes.forEach((b) => (bin += String.fromCharCode(b)));
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };

  const alg = options.alg ?? 'RS256';
  const header = { alg, typ: 'JWT', kid: options.kid ?? key.kid };
  const signingInput = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(claims))}`;

  if (alg === 'none') return `${signingInput}.`;

  const cryptoKey = await crypto.subtle.importKey(
    'jwk',
    { ...key.jwk, alg: 'RS256', use: 'sig', key_ops: ['sign'] },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(signingInput)));
  if (options.tamperSignature && signature.length > 0) signature[10] ^= 0xff;
  return `${signingInput}.${b64u(signature)}`;
}

export function baseClaims(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: 'https://forum.test',
    sub: 'someone',
    aud: 'api',
    iat: now,
    exp: now + 3600,
    jti: 'test-jti',
    typ: 'access',
    ...overrides,
  };
}
