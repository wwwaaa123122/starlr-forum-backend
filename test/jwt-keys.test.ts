/**
 * lib/jwt 多密钥配置单元测试：解析校验、active 选择、缓存失效、JWKS 输出。
 * 失败路径（alg/kid/签名/过期等）已由 test/security.test.ts 覆盖，此处不重复。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { signAccessToken, verifyAccessToken, publicJwks, KeyConfigError } from '../src/lib/jwt';
import type { Env } from '../src/types';

/** 生成一对 RSA JWK（私钥含 d 等参数，公钥仅 n/e） */
async function generateJwkPair(): Promise<{ privateJwk: JsonWebKey; publicJwk: JsonWebKey }> {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const privateJwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey;
  const publicJwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
  return { privateJwk, publicJwk };
}

function makeEnv(keys: string): Env {
  return {
    JWT_SIGNING_KEYS: keys,
    JWT_ISSUER: 'https://forum.test',
    JWT_AUDIENCE: 'api',
  } as unknown as Env;
}

const pairP = generateJwkPair();

describe('JWT_SIGNING_KEYS 解析校验（KeyConfigError）', () => {
  it('非法 JSON：signAccessToken 抛 KeyConfigError', async () => {
    const env = makeEnv('not-json');
    await expect(signAccessToken(env, { sub: 'x' })).rejects.toThrow(KeyConfigError);
  });

  it('JWK 缺 RSA 参数：抛 KeyConfigError', async () => {
    const { publicJwk } = await pairP;
    const env = makeEnv(JSON.stringify([{ kid: 'k1', jwk: { kty: 'oct' } }, { kid: 'k2', jwk: publicJwk }]));
    await expect(signAccessToken(env, { sub: 'x' })).rejects.toThrow(KeyConfigError);
  });

  it('kid 缺失：抛 KeyConfigError', async () => {
    const { privateJwk } = await pairP;
    const env = makeEnv(JSON.stringify([{ jwk: privateJwk }]));
    await expect(signAccessToken(env, { sub: 'x' })).rejects.toThrow(KeyConfigError);
  });

  it('空数组：抛 KeyConfigError', async () => {
    const env = makeEnv('[]');
    await expect(signAccessToken(env, { sub: 'x' })).rejects.toThrow(KeyConfigError);
  });
});

describe('多密钥轮换', () => {
  it('active 标记选择签名密钥；旧密钥仍可验证（轮换过渡期）', async () => {
    const { privateJwk: p1 } = await pairP;
    const { privateJwk: p2 } = await pairP;
    const keys = JSON.stringify([
      { kid: 'old-key', jwk: p1, active: false },
      { kid: 'new-key', jwk: p2, active: true },
    ]);
    const env = makeEnv(keys);

    const signed = await signAccessToken(env, { sub: 'user1', typ: 'access', iss: 'https://forum.test', aud: 'api', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 });
    expect(signed.kid).toBe('new-key'); // 用 active 密钥签

    // 新密钥验证通过
    const v1 = await verifyAccessToken(env, signed.token);
    expect(v1.ok).toBe(true);

    // 旧密钥签的 token（模拟轮换过渡期存量会话）仍可验证
    const oldSigned = await signAccessToken({ ...env, JWT_SIGNING_KEYS: JSON.stringify([{ kid: 'old-key', jwk: p1, active: true }]) } as Env, { sub: 'user1', typ: 'access', iss: 'https://forum.test', aud: 'api', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 });
    const v2 = await verifyAccessToken(env, oldSigned.token);
    expect(v2.ok).toBe(true);
    expect(v2.ok && v2.kid).toBe('old-key');
  });

  it('无 active 标记时取最后一个密钥（追加即生效的配置习惯）', async () => {
    const { privateJwk: p1 } = await pairP;
    const { privateJwk: p2 } = await pairP;
    const env = makeEnv(JSON.stringify([
      { kid: 'first', jwk: p1 },
      { kid: 'second', jwk: p2 },
    ]));
    const signed = await signAccessToken(env, { sub: 'x' });
    expect(signed.kid).toBe('second');
  });

  it('配置变更后缓存失效（同进程内换密钥立即生效）', async () => {
    const { privateJwk: p1 } = await pairP;
    const { privateJwk: p2 } = await pairP;
    const env = makeEnv(JSON.stringify([{ kid: 'k1', jwk: p1, active: true }]));
    const s1 = await signAccessToken(env, { sub: 'x' });
    expect(s1.kid).toBe('k1');

    // 模拟换配置（同一 env 对象，只换 JWT_SIGNING_KEYS）
    (env as unknown as { JWT_SIGNING_KEYS: string }).JWT_SIGNING_KEYS = JSON.stringify([{ kid: 'k2', jwk: p2, active: true }]);
    const s2 = await signAccessToken(env, { sub: 'x' });
    expect(s2.kid).toBe('k2'); // 缓存按 raw 字符串失效

    // 旧 token 用旧密钥仍可验证？——旧密钥已从配置移除，应 unknown_kid
    const v = await verifyAccessToken(env, s1.token);
    expect(v.ok).toBe(false);
    expect(!v.ok && v.reason).toBe('unknown_kid');
  });
});

describe('publicJwks', () => {
  it('多密钥全量输出，且不含私钥参数（d/p/q/dp/dq/qi）', async () => {
    const { privateJwk: p1 } = await pairP;
    const { privateJwk: p2 } = await pairP;
    const env = makeEnv(JSON.stringify([
      { kid: 'k1', jwk: p1, active: true },
      { kid: 'k2', jwk: p2, active: false },
    ]));
    const jwks = publicJwks(env);
    expect(jwks.keys.length).toBe(2);
    expect(jwks.keys.map((k) => k.kid)).toEqual(['k1', 'k2']);
    const raw = JSON.stringify(jwks);
    for (const secretField of ['"d"', '"p"', '"q"', '"dp"', '"dq"', '"qi"']) {
      expect(raw).not.toContain(`"${secretField.slice(1, -1)}":`);
    }
    for (const k of jwks.keys) {
      expect(k.kty).toBe('RSA');
      expect(k.alg).toBe('RS256');
      expect(k.use).toBe('sig');
      expect(typeof k.n).toBe('string');
      expect(typeof k.e).toBe('string');
    }
  });
});
