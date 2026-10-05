/**
 * 认证中间件。
 * 服务端逐项验证：签名 / iss / aud / exp / iat（lib/jwt）+ 用户状态 + 权限。
 */
import type { MiddlewareHandler } from 'hono';
import type { AppEnv, AuthUser } from '../types';
import { verifyAccessToken } from '../lib/jwt';
import { errors } from '../lib/http';

export function getBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return m ? m[1] : null;
}

/** 尝试解析用户；Token 无效/过期时不抛错（公开接口匿名降级） */
export const optionalAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set('user', null);
  c.set('tokenJti', null);
  const token = getBearerToken(c.req.header('Authorization'));
  if (token) {
    const result = await verifyAccessToken(c.env, token);
    if (result.ok) {
      const sub = result.payload.sub;
      if (typeof sub === 'string') {
        const user = await c.env.DB.prepare(
          `SELECT id, uid, username, username_raw, nickname, email, role, status, avatar_url
           FROM users WHERE id = ?`,
        )
          .bind(sub)
          .first<AuthUser & { username: string }>();
        if (user && user.status === 'active') {
          c.set('user', user);
          c.set('tokenJti', typeof result.payload.jti === 'string' ? result.payload.jti : null);
        } else if (user && user.status === 'banned') {
          c.set('userBanned', true);
        }
      }
    }
  }
  await next();
};

/** 强制登录；banned 用户返回 403（账号封禁即时生效，不等 Token 过期） */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = c.get('user');
  if (!user) {
    // 区分「没带 Token」与「Token 无效」，便于前端刷新逻辑
    const token = getBearerToken(c.req.header('Authorization'));
    if (token) {
      const result = await verifyAccessToken(c.env, token);
      if (!result.ok) {
        if (result.reason === 'expired') throw errors.tokenExpired();
        throw errors.invalidToken();
      }
      // Token 有效但账号不可用：封禁 → 403；用户不存在 → 401
      if (c.get('userBanned')) throw errors.forbidden('账号已被封禁，如有疑问请联系管理员', 'ACCOUNT_BANNED');
      throw errors.invalidToken('账号不存在或登录状态已失效');
    }
    throw errors.unauthorized();
  }
  await next();
};

export const requireRole =
  (...roles: Array<AuthUser['role']>): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    const user = c.get('user');
    if (!user) throw errors.unauthorized();
    if (!roles.includes(user.role)) throw errors.forbidden();
    await next();
  };

/** 检查用户是否处于禁言状态（发帖/回复前调用） */
export async function assertNotMuted(c: { env: AppEnv['Bindings']; get: (k: 'user') => AuthUser | null }): Promise<void> {
  const user = c.get('user');
  if (!user) throw errors.unauthorized();
  const mute = await c.env.DB.prepare(
    `SELECT id, reason, expires_at FROM bans
     WHERE user_id = ? AND type = 'mute' AND lifted_at IS NULL
       AND (expires_at IS NULL OR expires_at > datetime('now'))
     ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(user.id)
    .first<{ reason: string; expires_at: string | null }>();
  if (mute) {
    throw errors.forbidden(
      mute.expires_at
        ? `您已被禁言至 ${mute.expires_at.replace('T', ' ').slice(0, 16)}（原因：${mute.reason}）`
        : `您已被永久禁言（原因：${mute.reason}）`,
    );
  }
}
