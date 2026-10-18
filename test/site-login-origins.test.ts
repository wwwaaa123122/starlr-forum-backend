import { describe, expect, it } from 'vitest';
import { appAuthBridgeOrigin, getSsoAccessConfig } from '../src/routes/site-login';

const BRIDGE = appAuthBridgeOrigin({ SITE_URL: 'https://forum.test' } as never);

/** getSsoAccessConfig 的来源合并逻辑：自有桥接源（Android app-auth）必须永远在白名单里 */
describe('SSO 白名单与桥接源', () => {
  it('env 来源不含桥接源时自动追加', async () => {
    const env = {
      CACHE: { get: async () => null },
      SSO_ALLOWED_ORIGINS: 'https://third-party.example',
      SITE_URL: 'https://forum.test',
    } as never as Parameters<typeof getSsoAccessConfig>[0];
    const cfg = await getSsoAccessConfig(env);
    expect(cfg.source).toBe('env');
    expect(cfg.origins).toContain('https://third-party.example');
    expect(cfg.origins).toContain(BRIDGE);
  });

  it('KV 配置同样追加桥接源且不影响其余来源', async () => {
    const env = {
      CACHE: { get: async () => JSON.stringify({ origins: ['https://a.example'] }) },
      SITE_URL: 'https://forum.test',
    } as never as Parameters<typeof getSsoAccessConfig>[0];
    const cfg = await getSsoAccessConfig(env);
    expect(cfg.source).toBe('kv');
    expect(cfg.origins).toContain('https://a.example');
    expect(cfg.origins).toContain(BRIDGE);
  });

  it('桥接源已在列表中时不重复', async () => {
    const env = {
      CACHE: { get: async () => JSON.stringify({ origins: [BRIDGE, 'https://a.example'] }) },
      SITE_URL: 'https://forum.test',
    } as never as Parameters<typeof getSsoAccessConfig>[0];
    const cfg = await getSsoAccessConfig(env);
    expect(cfg.origins.filter((o) => o === BRIDGE)).toHaveLength(1);
  });
});
