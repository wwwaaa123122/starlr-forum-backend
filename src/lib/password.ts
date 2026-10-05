/**
 * 密码哈希：PBKDF2-HMAC-SHA256（WebCrypto 原生实现，不自行发明密码学算法）。
 * 存储格式：pbkdf2$sha256$<iterations>$<salt_b64url>$<hash_b64url>
 */
import { base64UrlDecode, base64UrlEncode, timingSafeEqual } from './ids';

const KEY_LENGTH = 32; // 256 bit
const SALT_LENGTH = 16;

export async function hashPassword(password: string, iterations = 100_000): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const hash = await derive(password, salt, iterations);
  return `pbkdf2$sha256$${iterations}$${base64UrlEncode(salt)}$${base64UrlEncode(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 5 || parts[0] !== 'pbkdf2' || parts[1] !== 'sha256') return false;
  const iterations = Number.parseInt(parts[2], 10);
  if (!Number.isFinite(iterations) || iterations < 1000) return false;
  let salt: Uint8Array;
  try {
    salt = base64UrlDecode(parts[3]);
  } catch {
    return false;
  }
  const expected = parts[4];
  const actual = base64UrlEncode(await derive(password, salt, iterations));
  return timingSafeEqual(actual, expected);
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  return crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as unknown as BufferSource, iterations, hash: 'SHA-256' },
    key,
    KEY_LENGTH * 8,
  );
}

/** 密码强度基础校验（长度 + 字符多样性），避免弱口令 */
export function isStrongEnough(password: string): { ok: boolean; reason?: string } {
  if (password.length < 8) return { ok: false, reason: '密码长度至少 8 位' };
  if (password.length > 128) return { ok: false, reason: '密码长度不能超过 128 位' };
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (classes < 2) return { ok: false, reason: '密码需包含字母、数字或符号中的至少两类' };
  if (/^(?:password|12345678|qwerty|admin|letmein)/i.test(password)) {
    return { ok: false, reason: '密码过于常见，请更换' };
  }
  return { ok: true };
}
