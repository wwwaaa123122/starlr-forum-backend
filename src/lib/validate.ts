/** 请求体校验辅助 */
import type { Context } from 'hono';
import { z } from 'zod';
import { errors } from './http';

export async function parseJson<S extends z.ZodTypeAny>(c: Context, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw errors.badRequest('请求体必须是合法 JSON');
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    const details = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw errors.badRequest('参数校验失败', 'VALIDATION_ERROR', details);
  }
  return result.data;
}

export function parseQuery<S extends z.ZodTypeAny>(c: Context, schema: S): z.infer<S> {
  const raw = Object.fromEntries(new URL(c.req.url).searchParams.entries());
  const result = schema.safeParse(raw);
  if (!result.success) {
    const details = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw errors.badRequest('查询参数校验失败', 'VALIDATION_ERROR', details);
  }
  return result.data;
}

/** 通用分页参数 */
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).max(500).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

export type Pagination = z.infer<typeof paginationSchema>;

export function paginationMeta(page: number, pageSize: number, total: number) {
  return {
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    hasMore: page * pageSize < total,
  };
}
