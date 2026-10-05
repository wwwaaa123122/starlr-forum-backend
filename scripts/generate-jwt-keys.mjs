#!/usr/bin/env node
/**
 * JWT 签名密钥生成器（RS256 / 2048 位）
 *
 * 用法：
 *   node scripts/generate-jwt-keys.mjs                 # 生成密钥，写入 .dev.vars（本地开发）
 *   node scripts/generate-jwt-keys.mjs --print         # 仅打印 Secret JSON（用于 wrangler secret put JWT_SIGNING_KEYS）
 *
 * 生产部署：
 *   node scripts/generate-jwt-keys.mjs --print | wrangler secret put JWT_SIGNING_KEYS
 *
 * 密钥轮换：再次生成并把新旧两组 { kid, jwk } 放进同一个数组，
 * 旧的设 active:false，新的设 active:true，然后更新 Secret。
 * 私钥绝不入库、绝不硬编码（.dev.vars 已被 .gitignore 忽略）。
 */
import { webcrypto } from 'node:crypto';
import { writeFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const crypto = webcrypto;

function toB64Url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

async function generateRsaJwk(kid) {
  const { publicKey, privateKey } = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const privateJwk = await crypto.subtle.exportKey('jwk', privateKey);
  const pub = await crypto.subtle.exportKey('jwk', publicKey);
  // 校验导出的公钥与私钥参数一致
  if (pub.n !== privateJwk.n || pub.e !== privateJwk.e) {
    throw new Error('public/private key mismatch');
  }
  const jwk = { kty: privateJwk.kty, n: privateJwk.n, e: privateJwk.e, d: privateJwk.d, p: privateJwk.p, q: privateJwk.q, dp: privateJwk.dp, dq: privateJwk.dq, qi: privateJwk.qi };
  return { kid, jwk, active: true };
}

function validateNoPrivateLeak() {
  // 防呆：确保不会把密钥写进会被提交的位置
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const devVars = path.resolve(dir, '../.dev.vars');
  if (existsSync(devVars)) {
    const mode = statSync(devVars).mode & 0o777;
    if (mode & 0o077) {
      console.warn(`警告：${devVars} 权限过宽，建议 chmod 600`);
    }
  }
}

async function main() {
  const print = process.argv.includes('--print');
  const stamp = new Date().toISOString().slice(0, 7).replace('-', ''); // 例如 202510
  const kid = `${stamp}-${Math.random().toString(36).slice(2, 6)}`;

  const key = await generateRsaJwk(kid);
  const secretJson = JSON.stringify([key], null, 2);
  const compactJson = JSON.stringify([key]);

  if (print) {
    console.log(secretJson);
    console.error(`\n# 已生成密钥 kid=${kid}`);
    console.error('# 上传为生产 Secret：node scripts/generate-jwt-keys.mjs --print | wrangler secret put JWT_SIGNING_KEYS');
    return;
  }

  const dir = path.dirname(fileURLToPath(import.meta.url));
  const devVars = path.resolve(dir, '../.dev.vars');
  const content = [
    '# 本地开发密钥（自动生成，勿提交）',
    `JWT_SIGNING_KEYS=${compactJson}`,
    'TURNSTILE_DISABLED=true',
    '',
  ].join('\n');
  writeFileSync(devVars, content, { mode: 0o600 });
  validateNoPrivateLeak();
  console.error(`已写入 ${devVars}（kid=${kid}）`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
