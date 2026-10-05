/**
 * /oauth/* — OAuth 2.0 / OIDC 预留端点（第一阶段返回 501）
 *
 * 架构已为未来 IdP 做好准备：
 *   - oauth_clients / oauth_authorization_codes / oauth_consents 表已建
 *   - RS256 + kid + JWKS 已就绪（id_token 可直接复用 access token 的签名设施）
 *   - 授权码使用高熵随机值，仅存哈希；PKCE(S256)；redirect_uri 严格匹配
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../types';

const app = new Hono<AppEnv>();

function notImplemented(c: Context<AppEnv>, endpoint: string) {
  return c.json(
    {
      error: {
        code: 'OAUTH_NOT_IMPLEMENTED',
        message: `OAuth 端点 ${endpoint} 尚未启用。基础设施已预留，将作为独立阶段上线。`,
        issuer: c.env.JWT_ISSUER,
      },
    },
    501,
  );
}

app.get('/authorize', (c) => notImplemented(c, '/oauth/authorize'));
app.post('/token', (c) => notImplemented(c, '/oauth/token'));
app.post('/revoke', (c) => notImplemented(c, '/oauth/revoke'));
app.get('/userinfo', (c) => notImplemented(c, '/oauth/userinfo'));

export default app;
