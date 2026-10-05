/** 生成随机 ID（CSPRNG，URL 安全，非密码学用途） */
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

export function newId(size = 16): string {
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  let out = '';
  for (let i = 0; i < size; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/** 高熵随机 Token（用于 Refresh Token / 授权码） */
export function randomToken(bytes = 32): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return base64UrlEncode(buf);
}

export function base64UrlEncode(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(input: string): Uint8Array {
  const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4));
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** SHA-256 → hex（用于 Refresh Token 哈希、指纹） */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 恒定时间字符串比较（防时序侧信道） */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function nowIso(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

export function isoFromNow(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString().replace('T', ' ').slice(0, 19);
}
