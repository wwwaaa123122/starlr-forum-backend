/**
 * Worker 绑定与环境变量类型定义。
 */
export interface Env {
  // --- 绑定 ---
  DB: D1Database;
  CACHE: KVNamespace;
  UPLOADS: R2Bucket;
  /** 静态资源绑定：仅 x（SPA）与 f（纯前端）Worker 有；纯 API Worker（forum-backend）无 */
  ASSETS?: Fetcher;

  // --- 普通变量 ---
  SITE_URL: string;
  JWT_ISSUER: string;
  JWT_AUDIENCE: string;
  ACCESS_TOKEN_TTL: string;
  REFRESH_TOKEN_TTL: string;
  PASSWORD_ITERATIONS: string;
  ALLOWED_ORIGINS?: string;
  /** OAuth 登录成功后可回跳的前端源（逗号分隔）；留空则用 ALLOWED_ORIGINS + SITE_URL */
  OAUTH_REDIRECT_ORIGINS?: string;
  /** 允许发起「登录状态同步」的第三方站点源（逗号分隔） */
  SSO_ALLOWED_ORIGINS?: string;
  /**
   * Android 客户端浏览器登录桥接页（/app-auth）所在站点源，如 https://forum.example.com。
   * 留空则取 SITE_URL 的 origin。自部署无需改代码。
   */
  APP_AUTH_ORIGIN?: string;
  /** SEO 主域（canonical/sitemap 归并目标）；留空则取 SITE_URL 的 origin */
  CANONICAL_SITE_URL?: string;
  /** Turnstile 站点密钥（公开，可暴露给前端） */
  TURNSTILE_SITE_KEY?: string;
  /** 发件人（Resend），如：My Forum <no-reply@example.com> */
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
  /** 全站版主：不受版块限制（1 = 全站管辖） */
  siteWideModerator?: number;
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
