import { describe, expect, it } from 'vitest';
import { APP_AUTH_BRIDGE_ORIGIN, getSsoAccessConfig } from '../src/routes/site-login';

/** getSsoAccessConfig 的来源合并逻辑：自有桥接源（Android app-auth）必须永远在白名单里 */
describe('SSO 白名单与桥接源', () => {
  it('env 来源不含桥接源时自动追加', async () => {
    const env = {
      CACHE: { get: async () => null },
      SSO_ALLOWED_ORIGINS: 'https://zako.mom',
    } as never as Parameters<typeof getSsoAccessConfig>[0];
    const cfg = await getSsoAccessConfig(env);
    expect(cfg.source).toBe('env');
    expect(cfg.origins).toContain('https://zako.mom');
    expect(cfg.origins).toContain(APP_AUTH_BRIDGE_ORIGIN);
  });

  it('KV 配置同样追加桥接源且不影响其余来源', async () => {
    const env = {
      CACHE: { get: async () => JSON.stringify({ origins: ['https://a.example'] }) },
    } as never as Parameters<typeof getSsoAccessConfig>[0];
    const cfg = await getSsoAccessConfig(env);
    expect(cfg.source).toBe('kv');
    expect(cfg.origins).toContain('https://a.example');
    expect(cfg.origins).toContain(APP_AUTH_BRIDGE_ORIGIN);
  });

  it('桥接源已在列表中时不重复', async () => {
    const env = {
      CACHE: { get: async () => JSON.stringify({ origins: [APP_AUTH_BRIDGE_ORIGIN, 'https://a.example'] }) },
    } as never as Parameters<typeof getSsoAccessConfig>[0];
    const cfg = await getSsoAccessConfig(env);
    expect(cfg.origins.filter((o) => o === APP_AUTH_BRIDGE_ORIGIN)).toHaveLength(1);
  });
});
