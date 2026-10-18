/**
 * OAuth 回跳白名单：自部署者只需配置 SITE_URL / OAUTH_REDIRECT_ORIGINS，
 * 且不能因为要支持 OAuth 回跳而放宽 API 的 CORS 白名单。
 */
import { describe, expect, it } from 'vitest';
import { redirectAllowlist } from '../src/routes/oauth-consumer';

const env = (vars: Record<string, string>) => vars as never as Parameters<typeof redirectAllowlist>[0];

describe('OAuth 回跳白名单', () => {
  it('默认包含站点自身 origin 与本地开发地址', () => {
    const list = redirectAllowlist(env({ SITE_URL: 'https://forum.example.com' }));
    expect(list.has('https://forum.example.com')).toBe(true);
    expect(list.has('http://localhost:5174')).toBe(true);
  });

  it('OAUTH_REDIRECT_ORIGINS 优先于 ALLOWED_ORIGINS', () => {
    const list = redirectAllowlist(
      env({
        SITE_URL: 'https://forum.example.com',
        ALLOWED_ORIGINS: 'https://cors-only.example',
        OAUTH_REDIRECT_ORIGINS: 'https://oauth-target.example',
      }),
    );
    expect(list.has('https://oauth-target.example')).toBe(true);
    // 专用变量存在时，CORS 白名单不会顺带成为回跳白名单
    expect(list.has('https://cors-only.example')).toBe(false);
  });

  it('未配置 OAUTH_REDIRECT_ORIGINS 时回退到 ALLOWED_ORIGINS', () => {
    const list = redirectAllowlist(env({ SITE_URL: 'https://forum.example.com', ALLOWED_ORIGINS: 'https://app.example' }));
    expect(list.has('https://app.example')).toBe(true);
  });

  it('未知 origin 不在白名单内（防开放重定向）', () => {
    const list = redirectAllowlist(env({ SITE_URL: 'https://forum.example.com' }));
    expect(list.has('https://evil.example')).toBe(false);
  });

  it('SITE_URL 非法时不影响已有项', () => {
    const list = redirectAllowlist(env({ SITE_URL: 'not-a-url', ALLOWED_ORIGINS: 'https://app.example' }));
    expect(list.has('https://app.example')).toBe(true);
  });
});
