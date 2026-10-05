/**
 * KV 限流（固定窗口计数器）。
 * 不同 API 使用不同 bucket 与阈值；键中不保存原始 IP（只保存 SHA-256 前缀指纹）。
 */
import type { Env } from '../types';
import { sha256Hex } from './ids';

export interface RateLimitRule {
  /** KV key 前缀，如 "login" */
  bucket: string;
  /** 窗口内允许次数 */
  limit: number;
  /** 窗口长度（秒） */
  window: number;
}

export const RATE_LIMITS = {
  register: { bucket: 'register', limit: 5, window: 3600 },
  login: { bucket: 'login', limit: 10, window: 600 },
  refresh: { bucket: 'refresh', limit: 60, window: 600 },
  createPost: { bucket: 'post', limit: 10, window: 3600 },
  createReply: { bucket: 'reply', limit: 30, window: 3600 },
  search: { bucket: 'search', limit: 30, window: 60 },
  upload: { bucket: 'upload', limit: 20, window: 3600 },
  report: { bucket: 'report', limit: 10, window: 3600 },
  notify: { bucket: 'notify', limit: 10, window: 3600 },
  like: { bucket: 'like', limit: 60, window: 60 },
  notification: { bucket: 'notif', limit: 120, window: 60 },
} satisfies Record<string, RateLimitRule>;

/** 客户端指纹：优先 CF-Connecting-IP，回退 UA 哈希 */
interface FingerprintSource {
  req: { header: (name: string) => string | undefined };
}

export async function clientFingerprint(c: FingerprintSource): Promise<string> {
  const ip = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? '';
  const ua = c.req.header('user-agent') ?? '';
  const hash = await sha256Hex(`${ip}|${ua}`);
  return hash.slice(0, 24);
}

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  resetSeconds: number;
}

/**
 * 消耗一次限流额度。KV 原子性有限（最终一致），此实现用于基础防护，
 * 配合 Cloudflare WAF 原生 Rate Limiting 规则使用。
 */
export async function consumeRateLimit(
  env: Env,
  rule: RateLimitRule,
  identifier: string,
): Promise<RateLimitResult> {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(now / rule.window) * rule.window;
  const windowEnd = windowStart + rule.window;
  const key = `rl:${rule.bucket}:${identifier}:${windowStart}`;

  const current = await env.CACHE.get(key);
  const count = current ? Number.parseInt(current, 10) || 0 : 0;

  if (count >= rule.limit) {
    return { ok: false, remaining: 0, resetSeconds: windowEnd - now };
  }

  // TTL 稍长于窗口，保证窗口内可累计
  await env.CACHE.put(key, String(count + 1), { expirationTtl: rule.window + 60 });
  return { ok: true, remaining: rule.limit - count - 1, resetSeconds: windowEnd - now };
}
