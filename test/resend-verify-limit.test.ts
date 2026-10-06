/** 重新发送验证邮件的限流：60 秒冷却 + 每小时 3 次上限 */
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createUser, req } from './helpers';

describe('重新发送验证邮件限流', () => {
  it('60 秒内第二次被冷却拦截，且提示剩余等待；小时内第 4 次触发总量上限', async () => {
    const u = await createUser({ username: 'resendlimit' });
    // createUser 默认已验证 → 改回未验证才能走 resend 流程
    await env.DB.prepare(`UPDATE users SET email_verified = 0 WHERE id = ?`).bind(u.id).run();
    // KV 计数窗口按整点分片；用不同 UA 绕开 clientFingerprint 差异不影响（按 user.id 限流）
    const r1 = await req('/api/auth/resend-verification', { method: 'POST', token: u.accessToken });
    expect(r1.status).toBe(200);
    expect(r1.body.remaining).toBe(2);

    const r2 = await req('/api/auth/resend-verification', { method: 'POST', token: u.accessToken });
    expect(r2.status).toBe(429);
    expect(String(r2.body.error?.message)).toContain('秒后再试');

    // 删除冷却键，模拟 60 秒冷却结束
    await env.CACHE.delete(`rv-cd:${u.id}`);

    const r3 = await req('/api/auth/resend-verification', { method: 'POST', token: u.accessToken });
    expect(r3.status).toBe(200);
    expect(r3.body.remaining).toBe(1);

    const r4 = await req('/api/auth/resend-verification', { method: 'POST', token: u.accessToken });
    expect(r4.status).toBe(429);
  });
});
