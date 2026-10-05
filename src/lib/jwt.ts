/**
 * JWT 签名密钥管理。
 *
 * 私钥通过 Cloudflare Secret `JWT_SIGNING_KEYS` 注入，格式：
 *   [{ "kid": "2025-01", "jwk": { ...RS256 私钥 JWK... }, "active": true }]
 *
 * 支持多密钥并存（密钥轮换）：
 *   - 只有 active 的 key 用于签名新 Token
 *   - 所有 key 的公钥都通过 /.well-known/jwks.json 公布
 *   - 旧 Token 在旧公钥保留期内仍然可验证
 *
 * 本地/测试环境回退到 .dev.vars 中的同一 Secret 格式。
 */
import type { Env } from '../types';

export interface SigningKey {
  kid: string;
  jwk: JsonWebKey & { kty: 'RSA'; n: string; e: string };
  active?: boolean;
}

interface KeyCache {
  keys: SigningKey[];
  activeKey: SigningKey;
  privateCryptoKeys: Map<string, CryptoKey>;
  publicCryptoKeys: Map<string, CryptoKey>;
}

export class KeyConfigError extends Error {}

let cache: KeyCache | null = null;
let cachedRaw: string | null = null;

function parse(raw: string): SigningKey[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new KeyConfigError('JWT_SIGNING_KEYS 不是合法 JSON');
  }
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  const keys: SigningKey[] = [];
  for (const item of arr) {
    const jwk = (item as { jwk?: unknown }).jwk as SigningKey['jwk'] | undefined;
    const kid = (item as { kid?: unknown }).kid;
    if (!jwk || jwk.kty !== 'RSA' || typeof jwk.n !== 'string' || typeof jwk.e !== 'string' || typeof kid !== 'string') {
      throw new KeyConfigError('JWT_SIGNING_KEYS 中存在非法的 RS256 JWK 条目');
    }
    keys.push({ kid, jwk, active: Boolean((item as { active?: unknown }).active) });
  }
  if (keys.length === 0) throw new KeyConfigError('JWT_SIGNING_KEYS 为空');
  return keys;
}

function ensureCache(env: Env): KeyCache {
  if (cache && cachedRaw === env.JWT_SIGNING_KEYS) return cache;
  const keys = parse(env.JWT_SIGNING_KEYS as string);
  const activeKey = keys.find((k) => k.active) ?? keys[keys.length - 1];
  cache = { keys, activeKey, privateCryptoKeys: new Map(), publicCryptoKeys: new Map() };
  cachedRaw = env.JWT_SIGNING_KEYS as string;
  return cache;
}

async function importPrivate(c: KeyCache, k: SigningKey): Promise<CryptoKey> {
  const cached = c.privateCryptoKeys.get(k.kid);
  if (cached) return cached;
  const key = await crypto.subtle.importKey(
    'jwk',
    { ...k.jwk, alg: 'RS256', use: 'sig', key_ops: ['sign'] },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  c.privateCryptoKeys.set(k.kid, key);
  return key;
}

async function importPublic(c: KeyCache, k: SigningKey): Promise<CryptoKey> {
  const cached = c.publicCryptoKeys.get(k.kid);
  if (cached) return cached;
  // 只保留公开参数，绝不导出私钥部分
  const publicJwk: JsonWebKey = { kty: 'RSA', n: k.jwk.n, e: k.jwk.e, alg: 'RS256', use: 'sig' };
  const key = await crypto.subtle.importKey(
    'jwk',
    publicJwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  c.publicCryptoKeys.set(k.kid, key);
  return key;
}

export interface SignedJwtResult {
  token: string;
  kid: string;
}

export async function signAccessToken(
  env: Env,
  payload: Record<string, unknown>,
): Promise<SignedJwtResult> {
  const c = ensureCache(env);
  const active = c.activeKey;
  const privateKey = await importPrivate(c, active);

  const header = { alg: 'RS256', typ: 'JWT', kid: active.kid };
  const encoder = new TextEncoder();
  const signingInput = `${b64uJson(header)}.${b64uJson(payload)}`;
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    privateKey,
    encoder.encode(signingInput),
  );
  return { token: `${signingInput}.${base64Url(new Uint8Array(signature))}`, kid: active.kid };
}

export interface VerifyResult {
  ok: true;
  payload: Record<string, unknown>;
  kid: string;
}

export type VerifyFailure =
  | { ok: false; reason: 'malformed' | 'alg' | 'unknown_kid' | 'signature' | 'expired' | 'iss' | 'aud' | 'iat' | 'typ' };

/** 时钟容忍（秒）：验证 exp/iat 时允许少量偏差 */
const CLOCK_SKEW = 30;

export async function verifyAccessToken(
  env: Env,
  token: string,
  expectedTyp: 'access' | 'id_token' = 'access',
): Promise<VerifyResult | VerifyFailure> {
  let c: KeyCache;
  try {
    c = ensureCache(env);
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };

  let header: { alg?: string; kid?: string; typ?: string };
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(new TextDecoder().decode(fromB64Url(parts[0])));
    payload = JSON.parse(new TextDecoder().decode(fromB64Url(parts[1])));
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  // 严格固定算法：防止 "alg: none" 与算法混淆攻击（如 HS256 混淆）
  if (header.alg !== 'RS256' || header.typ !== 'JWT') return { ok: false, reason: 'alg' };
  if (typeof header.kid !== 'string') return { ok: false, reason: 'malformed' };
  const keyEntry = c.keys.find((k) => k.kid === header.kid);
  if (!keyEntry) return { ok: false, reason: 'unknown_kid' };

  const publicKey = await importPublic(c, keyEntry);
  let signatureBytes: Uint8Array;
  try {
    signatureBytes = fromB64Url(parts[2]);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    publicKey,
    signatureBytes as unknown as BufferSource,
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!valid) return { ok: false, reason: 'signature' };

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp + CLOCK_SKEW < now) {
    return { ok: false, reason: 'expired' };
  }
  if (typeof payload.iat !== 'number' || payload.iat - CLOCK_SKEW > now) {
    return { ok: false, reason: 'iat' };
  }
  if (payload.iss !== env.JWT_ISSUER) return { ok: false, reason: 'iss' };
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.JWT_AUDIENCE)) return { ok: false, reason: 'aud' };
  if (payload.typ !== expectedTyp) return { ok: false, reason: 'typ' };

  return { ok: true, payload, kid: header.kid };
}

/** 公钥集合（JWKS 端点输出） */
export function publicJwks(env: Env): { keys: Record<string, string>[] } {
  const c = ensureCache(env);
  return {
    keys: c.keys.map((k) => ({
      kty: 'RSA',
      use: 'sig',
      alg: 'RS256',
      kid: k.kid,
      n: k.jwk.n,
      e: k.jwk.e,
    })),
  };
}

function b64uJson(obj: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(obj)));
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64Url(input: string): Uint8Array {
  const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4));
  const binary = atob(input.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
