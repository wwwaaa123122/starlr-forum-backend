/** 管理与关键操作审计日志（异步，不阻塞响应） */
import type { Context } from 'hono';
import type { AppEnv } from '../types';
import { newId, nowIso } from './ids';

export interface AuditEntry {
  action: string;
  actorId: string;
  targetType?: string;
  targetId?: string;
  detail?: string;
}

export async function writeAuditLog(
  c: Context<AppEnv> | { env: AppEnv['Bindings']; req: { header: (n: string) => string | undefined } },
  entry: AuditEntry,
): Promise<void> {
  try {
    const ip = c.req.header('cf-connecting-ip') ?? '';
    await c.env.DB.prepare(
      `INSERT INTO audit_logs (id, actor_id, action, target_type, target_id, detail, ip, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        newId(16),
        entry.actorId,
        entry.action,
        entry.targetType ?? null,
        entry.targetId ?? null,
        (entry.detail ?? '').slice(0, 2000),
        ip,
        nowIso(),
      )
      .run();
  } catch (e) {
    // 审计失败不影响主流程，但要在日志中可见
    console.error('audit log failed', entry.action, e);
  }
}
