/** /api/reports — 举报（帖子/回复/用户），处理在 /api/admin/reports */
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types';
import { errors, ok } from '../lib/http';
import { parseJson } from '../lib/validate';
import { requireAuth } from '../middleware/auth';
import { RATE_LIMITS, consumeRateLimit } from '../lib/rate-limit';
import { newId, nowIso } from '../lib/ids';
import { sendAdminAlert } from '../lib/mail';

const app = new Hono<AppEnv>();

const reportSchema = z.object({
  targetType: z.enum(['post', 'reply', 'user']),
  targetId: z.string().min(1).max(32),
  reason: z.enum(['spam', 'abuse', 'porn', 'illegal', 'other']),
  detail: z.string().trim().max(1000).default(''),
});

app.post('/', requireAuth, async (c) => {
  const user = c.get('user')!;
  const rl = await consumeRateLimit(c.env, RATE_LIMITS.report, user.id);
  if (!rl.ok) throw errors.tooMany('举报过于频繁');

  const body = await parseJson(c, reportSchema);

  // 目标必须存在（防伪造举报刷数据）
  let exists = false;
  if (body.targetType === 'post') {
    exists = Boolean(
      await c.env.DB.prepare(`SELECT 1 FROM posts WHERE id = ?`).bind(body.targetId).first(),
    );
  } else if (body.targetType === 'reply') {
    exists = Boolean(
      await c.env.DB.prepare(`SELECT 1 FROM replies WHERE id = ?`).bind(body.targetId).first(),
    );
  } else {
    exists = Boolean(
      await c.env.DB.prepare(`SELECT 1 FROM users WHERE id = ?`).bind(body.targetId).first(),
    );
  }
  if (!exists) throw errors.notFound('举报目标不存在');

  const reportId = newId(16);
  await c.env.DB.prepare(
    `INSERT INTO reports (id, reporter_id, target_type, target_id, reason, detail, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
  )
    .bind(reportId, user.id, body.targetType, body.targetId, body.reason, body.detail, nowIso())
    .run();

  // 通知管理员（最多 5 名）
  const { results: admins } = await c.env.DB.prepare(
    `SELECT id FROM users WHERE role IN ('admin', 'moderator') AND status = 'active' LIMIT 5`,
  ).all<{ id: string }>();
  if (admins && admins.length > 0) {
    const stmt = c.env.DB.prepare(
      `INSERT INTO notifications (id, user_id, actor_id, type, content, is_read, created_at)
       VALUES (?, ?, ?, 'moderation', ?, 0, ?)`,
    );
    await c.env.DB.batch(
      admins.map((a) =>
        stmt.bind(newId(16), a.id, user.id, `收到新的举报（${body.targetType}）：${body.reason}`, nowIso()),
      ),
    );
  }

  // 邮件告警管理员（失败不影响举报提交）
  await sendAdminAlert(
    c.env,
    `新的举报（${body.targetType}）`,
    `<p><strong>${user.nickname}</strong>（UID ${user.uid ?? '-'}，@${user.username}）提交了举报。</p>
     <ul>
       <li>目标类型：${body.targetType}</li>
       <li>目标 ID：${body.targetId}</li>
       <li>原因：${body.reason}</li>
       <li>详情：${body.detail || '（无）'}</li>
     </ul>
     <p><a href="${c.env.SITE_URL}/admin">前往管理后台处理 →</a></p>`,
  );

  return ok(c, { id: reportId }, { status: 201 });
});

export default app;
