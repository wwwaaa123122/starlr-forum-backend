/** 统一 JSON 响应与错误格式。错误结构：{ error: { code, message } }，绝不回传堆栈。 */
import type { Context } from 'hono';

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const errors = {
  badRequest: (msg = '请求参数错误', code = 'BAD_REQUEST', details?: unknown) =>
    new ApiError(400, code, msg, details),
  unauthorized: (msg = '未登录或登录已过期', code = 'UNAUTHORIZED') => new ApiError(401, code, msg),
  invalidToken: (msg = '令牌无效', code = 'INVALID_TOKEN') => new ApiError(401, code, msg),
  tokenExpired: (msg = '登录已过期，请重新登录', code = 'TOKEN_EXPIRED') => new ApiError(401, code, msg),
  forbidden: (msg = '没有权限执行此操作', code = 'FORBIDDEN') => new ApiError(403, code, msg),
  notFound: (msg = '资源不存在', code = 'NOT_FOUND') => new ApiError(404, code, msg),
  conflict: (msg = '资源冲突', code = 'CONFLICT') => new ApiError(409, code, msg),
  tooMany: (msg = '请求过于频繁，请稍后再试', code = 'RATE_LIMITED') => new ApiError(429, code, msg),
  internal: (msg = '服务器内部错误', code = 'INTERNAL_ERROR') => new ApiError(500, code, msg),
};

export function jsonError(c: Context, err: ApiError): Response {
  const body: ApiErrorBody = { error: { code: err.code, message: err.message } };
  if (err.details !== undefined) body.error.details = err.details;
  if (err.status === 429) {
    // 简单提示，可结合限流器返回精确 Retry-After
    c.header('Retry-After', '60');
  }
  return c.json(body, err.status as 400);
}

export function ok<T>(c: Context, data: T, init?: { status?: number; headers?: Record<string, string> }): Response {
  return c.json(data as unknown as Record<string, unknown>, (init?.status ?? 200) as 200, init?.headers);
}
