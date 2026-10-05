/**
 * Worker 绑定与环境变量类型定义。
 */
export interface Env {
  // --- 绑定 ---
  DB: D1Database;
  CACHE: KVNamespace;
  UPLOADS: R2Bucket;
  ASSETS: Fetcher;

  // --- 普通变量 ---
  SITE_URL: string;
  JWT_ISSUER: string;
  JWT_AUDIENCE: string;
  ACCESS_TOKEN_TTL: string;
  REFRESH_TOKEN_TTL: string;
  PASSWORD_ITERATIONS: string;
  ALLOWED_ORIGINS?: string;
  /** Turnstile 站点密钥（公开，可暴露给前端） */
  TURNSTILE_SITE_KEY?: string;
  /** 发件人（Resend），如：Starlr Forum <no-reply@182030.xyz> */
  MAIL_FROM?: string;
  /** 'memory'：邮件写入内存 outbox（测试/本地），未设置则走 Resend */
  MAIL_TRANSPORT?: string;

  // --- Secrets（不写入代码库）---
  /** JSON: [{ "kid": "...", "jwk": {RS256 private JWK}, "active": true }] */
  JWT_SIGNING_KEYS?: string;
  TURNSTILE_SECRET_KEY?: string;
  /** Resend API Key（re_...） */
  RESEND_API_KEY?: string;
  /** 允许在测试/本地环境跳过 Turnstile（生产不得设置为 true） */
  TURNSTILE_DISABLED?: string;
}

/** 认证后的请求上下文用户 */
export interface AuthUser {
  id: string;
  uid: number | null;
  username: string;
  nickname: string;
  email: string;
  role: 'user' | 'moderator' | 'admin';
  status: 'active' | 'banned';
  email_verified?: number;
  avatar_url: string | null;
}

export type AppBindings = { Bindings: Env };

export interface AppVariables {
  user: AuthUser | null;
  tokenJti: string | null;
  /** 当前会话（刷新令牌链当前行）ID，来自 access token 的 sid 声明 */
  tokenSid: string | null;
  requestId: string;
  /** Token 有效但账号被封禁（requireAuth 用于精确错误码） */
  userBanned?: boolean;
}

export type AppEnv = { Bindings: Env; Variables: AppVariables };

export interface JwtPayload {
  iss: string;
  sub: string;
  aud: string;
  iat: number;
  exp: number;
  jti: string;
  role?: string;
  typ?: 'access' | 'id_token';
}
