/** 请求体校验辅助 */
import type { Context } from 'hono';
import { z } from 'zod';
import { errors } from './http';

/**
 * JSON 请求体硬上限。
 *
 * 背景（GHSA-mrhx-c7xc-m3w5，2026-11-21 实测）：zod v3 对超大集合会**先遍历完所有
 * 元素并累积 issue 再报错**——连 `.max(5)` 这种有界 array 都在 16M 元素时吃掉
 * 1.1GB 内存（2.7s）。schema 级约束防不住，必须在解析前按原始体量拦截。
 *
 * 512KB 覆盖全部现有接口的合理输入（最大的是 admin-services 的 values 记录，
 * 实际字段个位数；发帖正文另有 max 长度约束）。超过一律 PAYLOAD_TOO_LARGE。
 * 上传接口（multipart）不经过 parseJson，由自身 5MB 校验把关。
 */
export const MAX_JSON_BODY_BYTES = 512 * 1024;

export async function parseJson<S extends z.ZodTypeAny>(c: Context, schema: S): Promise<z.infer<S>> {
  const text = await c.req.text();
  if (text.length > MAX_JSON_BODY_BYTES) {
    throw errors.badRequest('请求体过大', 'PAYLOAD_TOO_LARGE');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
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
