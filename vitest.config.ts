import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';
import path from 'node:path';
import { webcrypto } from 'node:crypto';

/**
 * 测试环境临时生成 RS256 密钥（不落盘、不入库，符合“私钥不提交”原则）。
 */
async function generateTestKeys(): Promise<string> {
  const { privateKey } = await webcrypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const jwk = await webcrypto.subtle.exportKey('jwk', privateKey);
  return JSON.stringify([{ kid: 'test-key-1', jwk, active: true }]);
}

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'));
  const signingKeys = await generateTestKeys();

  return {
    test: {
      setupFiles: ['./test/setup.ts'],
      include: ['test/**/*.test.ts'],
      testTimeout: 20_000,
      poolOptions: {
        workers: {
          singleWorker: true,
          wrangler: { configPath: './wrangler.jsonc' },
          miniflare: {
            bindings: {
              TEST_MIGRATIONS: migrations,
              JWT_SIGNING_KEYS: signingKeys,
              TURNSTILE_DISABLED: 'true',
              MAIL_TRANSPORT: 'memory',
              ADMIN_EMAIL: 'admin-alert@test.local',
              MAIL_FROM: '星辰旅人论坛测试 <no-reply@test.local>',
              PASSWORD_ITERATIONS: '1000',
              JWT_ISSUER: 'https://forum.test',
              JWT_AUDIENCE: 'api',
              SITE_URL: 'https://forum.test',
              ACCESS_TOKEN_TTL: '86400',
              REFRESH_TOKEN_TTL: '2592000',
            },
          },
        },
      },
    },
  };
});
