/**
 * OAuth 结果页 XSS 回归：/oauth/start/:provider 与 /oauth/callback/:provider
 * 的路径参数、GitHub 返回的 error_description 都会拼进同源 HTML，
 * 必须转义（同源 XSS 可读取 localStorage 里的 refresh token）。
 */
import { describe, it, expect } from 'vitest';
import { req } from './helpers';

const payload = '<img src=x onerror=alert(1)>';

describe('OAuth 结果页：动态内容必须 HTML 转义', () => {
  it('start/:provider 不原样回显路径参数', async () => {
    const res = await req(`/oauth/start/${encodeURIComponent(payload)}`);
    expect(res.status).toBe(404);
    const html = String(res.body);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('onerror');
  });

  it('callback/:provider 不原样回显路径参数', async () => {
    const res = await req(`/oauth/callback/${encodeURIComponent(payload)}`);
    expect(res.status).toBe(404);
    const html = String(res.body);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('onerror');
  });

  it('格式不合法的 provider 完全不出现在页面里', async () => {
    const res = await req(`/oauth/start/${encodeURIComponent('Bad_Provider')}`);
    expect(res.status).toBe(404);
    expect(String(res.body)).not.toContain('Bad_Provider');
  });
});
