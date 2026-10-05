/**
 * Token 服务：Access Token（JWT/RS256, 24h）+ Refresh Token（高熵随机值, 只存哈希）。
 *
 * Refresh 流程（Rotation）：
 *   校验 → 撤销旧 Token（标记 rotated）→ 签发新 Refresh Token → 签发新 Access Token
 *
 * Replay 检测：
 *   已轮换（rotated_at 非空）的 Token 再次出现 → 撤销整条 Token 链（root_id）
 */
import type { Env, AuthUser } from '../types';
import { newId, randomToken, sha256Hex, nowIso, isoFromNow } from './ids';
import { signAccessToken } from './jwt';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  accessExpiresIn: number;
  refreshTokenId: string;
}

function accessTtl(env: Env): number {
  // 默认 30 分钟：会话吊销后旧 Access Token 至多存活 30 分钟（应用有静默续期，无感知）
  const n = Number.parseInt(env.ACCESS_TOKEN_TTL ?? '1800', 10);
  return Number.isFinite(n) && n > 0 ? n : 1800;
}

function refreshTtl(env: Env): number {
  const n = Number.parseInt(env.REFRESH_TOKEN_TTL ?? '2592000', 10);
  return Number.isFinite(n) && n > 0 ? n : 2592000;
}

/** 签发新的 Access + Refresh Token 对（refreshToken 可指定父级实现链式轮换） */
export async function issueTokens(
  env: Env,
  user: Pick<AuthUser, 'id' | 'role'>,
  deviceInfo: string,
  parent?: { id: string; rootId: string | null },
): Promise<TokenPair> {
  const now = Math.floor(Date.now() / 1000);
  const ttl = accessTtl(env);
  const jti = newId(24);
  const refreshToken = randomToken(32);
  const refreshTokenId = newId(16);
  const tokenHash = await sha256Hex(refreshToken);
  // Token 链根：首发的 Token 以自身为根；子 Token 继承父级的根
  const rootId = parent ? (parent.rootId ?? parent.id) : null;

  const { token } = await signAccessToken(env, {
    iss: env.JWT_ISSUER,
    sub: user.id,
    aud: env.JWT_AUDIENCE,
    iat: now,
    exp: now + ttl,
    jti,
    typ: 'access',
    role: user.role,
    // sid = 本次会话（刷新令牌链）当前行 ID，用于「会话管理」标记当前设备
    sid: refreshTokenId,
  });

  await env.DB.prepare(
    `INSERT INTO refresh_tokens (id, user_id, token_hash, parent_id, root_id, device_info, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(refreshTokenId, user.id, tokenHash, parent?.id ?? null, rootId, deviceInfo.slice(0, 500), nowIso(), isoFromNow(refreshTtl(env)))
    .run();

  return { accessToken: token, refreshToken, accessExpiresIn: ttl, refreshTokenId };
}

/** 撤销单个 Refresh Token */
export async function revokeToken(env: Env, tokenId: string, reason: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE refresh_tokens SET revoked_at = ?, revoked_reason = ? WHERE id = ? AND revoked_at IS NULL`,
  )
    .bind(nowIso(), reason, tokenId)
    .run();
}

/** 撤销整条 Token 链（Replay 响应 / 用户登出全部设备 / 密码修改） */
export async function revokeTokenChain(env: Env, rootId: string, reason: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE refresh_tokens SET revoked_at = ?, revoked_reason = ? WHERE (root_id = ? OR id = ?) AND revoked_at IS NULL`,
  )
    .bind(nowIso(), reason, rootId, rootId)
    .run();
}

/** 撤销某用户全部 Refresh Token（如密码泄露响应） */
export async function revokeAllUserTokens(env: Env, userId: string, reason: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE refresh_tokens SET revoked_at = ?, revoked_reason = ? WHERE user_id = ? AND revoked_at IS NULL`,
  )
    .bind(nowIso(), reason, userId)
    .run();
}

export type RefreshOutcome =
  | { ok: true; userId: string; newTokens: TokenPair; tokenId: string }
  | { ok: false; reason: 'invalid' | 'expired' | 'revoked' | 'replay' };

/**
 * Refresh Token 轮换。
 * 检测到 Replay（使用已被轮换的 Token）时撤销整条链。
 */
export async function rotateRefreshToken(
  env: Env,
  presentedToken: string,
  deviceInfo: string,
): Promise<RefreshOutcome> {
  const tokenHash = await sha256Hex(presentedToken);
  const row = await env.DB.prepare(
    `SELECT id, user_id, root_id, expires_at, rotated_at, revoked_at FROM refresh_tokens WHERE token_hash = ?`,
  )
    .bind(tokenHash)
    .first<{ id: string; user_id: string; root_id: string | null; expires_at: string; rotated_at: string | null; revoked_at: string | null }>();

  if (!row) return { ok: false, reason: 'invalid' };

  if (row.revoked_at) return { ok: false, reason: 'revoked' };

  if (row.rotated_at) {
    // Replay：此 Token 已被轮换过。整链撤销。
    const rootId = row.root_id ?? row.id;
    await revokeTokenChain(env, rootId, 'refresh_token_replay');
    return { ok: false, reason: 'replay' };
  }

  const expired = new Date(row.expires_at.replace(' ', 'T') + 'Z').getTime() < Date.now();
  if (expired) {
    await revokeToken(env, row.id, 'expired');
    return { ok: false, reason: 'expired' };
  }

  const user = await env.DB.prepare(`SELECT id, role, status FROM users WHERE id = ?`)
    .bind(row.user_id)
    .first<{ id: string; role: string; status: string }>();
  if (!user || user.status !== 'active') return { ok: false, reason: 'invalid' };

  const newTokens = await issueTokens(
    env,
    { id: user.id, role: user.role as AuthUser['role'] },
    deviceInfo,
    { id: row.id, rootId: row.root_id },
  );

  await env.DB.prepare(
    `UPDATE refresh_tokens SET rotated_at = ?, replaced_by_id = ?, last_used_at = ? WHERE id = ?`,
  )
    .bind(nowIso(), newTokens.refreshTokenId, nowIso(), row.id)
    .run();

  return { ok: true, userId: user.id, newTokens, tokenId: row.id };
}
