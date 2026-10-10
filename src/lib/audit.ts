/** 管理与关键操作审计日志（异步，不阻塞响应） */
import type { Context } from 'hono';
import type { AppEnv } from '../types';
import { newId, nowIso } from './ids';

export interface AuditEntry {
  action: string;
  /** 操作发起者（audit_logs.actor_id NOT NULL；系统动作记为目标用户本人） */
  actorId: string;
  targetType?: string;
  targetId?: string;
  detail?: string;
  /** 覆盖 IP：服务器对服务器调用（如 SSO 兑换）时透传终端用户真实 IP */
  ip?: string;
}

export async function writeAuditLog(
  c: Context<AppEnv> | { env: AppEnv['Bindings']; req: { header: (n: string) => string | undefined } },
  entry: AuditEntry,
): Promise<void> {
  try {
    const ip = entry.ip ?? c.req.header('cf-connecting-ip') ?? '';
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
