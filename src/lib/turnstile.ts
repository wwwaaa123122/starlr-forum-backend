/**
 * Cloudflare Turnstile 服务端校验。
 * - 未配置 TURNSTILE_SECRET_KEY 或显式 TURNSTILE_DISABLED=true 时跳过（仅限开发/测试）
 * - 生产环境必须配置，否则注册/登录被拒绝
 */
import type { Env } from '../types';

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export interface TurnstileResult {
  enforced: boolean;
  success: boolean;
  reason?: string;
}

export async function verifyTurnstile(
  env: Env,
  token: string | undefined,
  remoteIp?: string,
): Promise<TurnstileResult> {
  if (env.TURNSTILE_DISABLED === 'true' || !env.TURNSTILE_SECRET_KEY) {
    return { enforced: false, success: true };
  }
  if (!token) {
    return { enforced: true, success: false, reason: 'missing_turnstile_token' };
  }
  try {
    const body = new URLSearchParams({
      secret: env.TURNSTILE_SECRET_KEY,
      response: token,
    });
    if (remoteIp) body.set('remoteip', remoteIp);
    const res = await fetch(VERIFY_URL, { method: 'POST', body });
    const data = (await res.json()) as { success: boolean; 'error-codes'?: string[] };
    if (data.success) return { enforced: true, success: true };
    return { enforced: true, success: false, reason: data['error-codes']?.join(',') ?? 'turnstile_failed' };
  } catch {
    // 校验服务不可达时宁可拒绝，也不能放行
    return { enforced: true, success: false, reason: 'turnstile_unavailable' };
  }
}
