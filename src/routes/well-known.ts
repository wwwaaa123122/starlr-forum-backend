/**
 * /.well-known/jwks.json     — 当前 JWT 验证公钥（RS256，带 kid）
 * /.well-known/openid-configuration — 未来 OIDC IdP 元数据（结构已预留）
 */
import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { publicJwks } from '../lib/jwt';

const app = new Hono<AppEnv>();

app.get('/jwks.json', (c) => {
  const jwks = publicJwks(c.env);
  c.header('Cache-Control', 'public, max-age=3600');
  return c.json(jwks);
});

app.get('/openid-configuration', (c) => {
  const issuer = c.env.JWT_ISSUER;
  return c.json({
    issuer,
    jwks_uri: `${issuer}/.well-known/jwks.json`,
    // 以下端点在 OAuth/OIDC 阶段启用（当前返回 501，基础设施已预留）
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    userinfo_endpoint: `${issuer}/oauth/userinfo`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    scopes_supported: ['openid', 'profile', 'email'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
    claims_supported: ['sub', 'iss', 'aud', 'iat', 'exp', 'jti', 'nickname', 'preferred_username', 'picture'],
  });
});

export default app;
