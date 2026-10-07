/**
 * 邮件发送（Resend HTTP API）
 * - 生产：RESEND_API_KEY secret + MAIL_FROM 变量
 * - 测试/本地：MAIL_TRANSPORT=memory 时消息写入内存 outbox（供自动化测试断言）
 * - 未配置时静默降级（不阻塞主流程），所有失败仅记录日志
 */
import type { Env } from '../types';
import { sha256Hex } from './ids';

export interface SentEmail {
  to: string[];
  subject: string;
  html: string;
  text: string;
}

/** 测试用内存 outbox（仅 MAIL_TRANSPORT=memory 时使用） */
const outbox: SentEmail[] = [];

/** 仅测试使用：读取已发送邮件 */
export function __getMailOutbox(): SentEmail[] {
  return outbox;
}

/** 仅测试使用：清空 outbox */
export function __clearMailOutbox(): void {
  outbox.length = 0;
}

interface ResendError {
  message?: string;
  name?: string;
}

function textFromHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 邮件 HTML 外壳（简洁、移动端友好） */
export function emailShell(title: string, bodyHtml: string, siteUrl: string): string {
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:32px 16px;">
    <div style="background:#ffffff;border-radius:12px;padding:32px;border:1px solid #e4e4e7;">
      <h1 style="margin:0 0 16px;font-size:20px;color:#18181b;">${title}</h1>
      <div style="font-size:14px;line-height:1.7;color:#3f3f46;">${bodyHtml}</div>
      <hr style="border:none;border-top:1px solid #e4e4e7;margin:24px 0;" />
      <p style="margin:0;font-size:12px;color:#a1a1aa;">
        Starlr Forum · <a href="${siteUrl}" style="color:#4f46e5;">${siteUrl.replace(/^https?:\/\//, '')}</a><br/>
        如果这不是你的操作，请忽略此邮件。
      </p>
    </div>
  </div>
</body></html>`;
}

export async function sendEmail(env: Env, to: string | string[], subject: string, bodyHtml: string): Promise<boolean> {
  const recipients = (Array.isArray(to) ? to : [to]).map((x) => x.trim()).filter(Boolean);
  if (recipients.length === 0) return false;

  const html = emailShell(subject, bodyHtml, env.SITE_URL);
  const text = textFromHtml(html);

  if (env.MAIL_TRANSPORT === 'memory') {
    outbox.push({ to: recipients, subject, html, text });
    return true;
  }

  const result = await deliverViaResend(env, recipients, subject, html, text);
  if (!result.ok) console.error('[mail] 发送失败:', result.message);
  return result.ok;
}

export interface MailDeliveryResult {
  ok: boolean;
  message: string;
}

/** Resend 投递：KV config:mail 优先，env（RESEND_API_KEY / MAIL_FROM）兜底 */
export async function deliverViaResend(env: Env, recipients: string[], subject: string, html: string, text: string): Promise<MailDeliveryResult> {
  let apiKey = env.RESEND_API_KEY;
  let from = env.MAIL_FROM || 'Starlr Forum <no-reply@182030.xyz>';
  let source = 'env';
  try {
    const raw = await env.CACHE.get('config:mail');
    if (raw) {
      const cfg = JSON.parse(raw) as { api_key?: string; from?: string };
      if (cfg.api_key) {
        apiKey = cfg.api_key;
        source = 'kv';
      }
      if (cfg.from) from = cfg.from;
    }
  } catch {
    // KV 异常时用 env 兜底
  }

  if (!apiKey) {
    console.warn('[mail] Resend 未配置（KV 与 env 均无 API Key），跳过发送:', subject);
    return { ok: false, message: 'Resend 未配置：请在管理后台「服务配置 → 邮件」填写 API Key' };
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: recipients, subject, html, text }),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as ResendError;
      const msg = err.message ?? 'unknown';
      console.error(`[mail] Resend 发送失败 ${res.status}:`, msg);
      return { ok: false, message: `Resend HTTP ${res.status}: ${msg}` };
    }
    return { ok: true, message: `发送成功（配置来源：${source === 'kv' ? '管理后台' : '环境变量'}）` };
  } catch (e) {
    console.error('[mail] Resend 请求异常:', e instanceof Error ? e.message : e);
    return { ok: false, message: `请求异常：${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * 管理告警收件人：优先 UID 1（站长）的邮箱；
 * UID 1 不存在或邮箱无效时，回退到其他在职管理员邮箱。
 */
export async function adminRecipients(env: Env): Promise<string[]> {
  const emails = new Set<string>();
  try {
    const owner = await env.DB.prepare(
      `SELECT email FROM users WHERE uid = 1 AND status = 'active' AND email LIKE '%_@_%._%' LIMIT 1`,
    ).first<{ email: string }>();
    if (owner?.email) emails.add(owner.email.toLowerCase());

    if (emails.size === 0) {
      const { results } = await env.DB.prepare(
        `SELECT email FROM users WHERE role = 'admin' AND status = 'active' AND email LIKE '%_@_%._%' ORDER BY uid ASC LIMIT 3`,
      ).all<{ email: string }>();
      for (const r of results ?? []) emails.add(r.email.toLowerCase());
    }
  } catch {
    // 数据库异常时不阻塞告警
  }
  return [...emails];
}

/** 发送管理员告警（任一收件失败不影响其他收件人） */
export async function sendAdminAlert(env: Env, subject: string, bodyHtml: string): Promise<void> {
  const recipients = await adminRecipients(env);
  if (recipients.length === 0) return;
  await sendEmail(env, recipients, `[论坛管理] ${subject}`, bodyHtml);
}

/** 生成密码重置令牌并返回（明文只出现一次：邮件里） */
function escapeHtml(str: string): string {
  return str.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch);
}

/** 邮箱验证令牌（24 小时有效，一次性） */
export async function createEmailVerificationToken(env: Env, userId: string): Promise<string> {
  const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
  await env.CACHE.put(`emailverify:${await sha256Hex(token)}`, userId, { expirationTtl: 86_400 });
  return token;
}

export async function consumeEmailVerificationToken(env: Env, token: string): Promise<string | null> {
  const key = `emailverify:${await sha256Hex(token)}`;
  const userId = await env.CACHE.get(key);
  if (!userId) return null;
  await env.CACHE.delete(key);
  return userId;
}

/** 发送激活账号邮件（注册后 / 重新发送） */
export async function sendVerificationEmail(env: Env, to: string, nickname: string, token: string): Promise<boolean> {
  const link = `${env.SITE_URL}/verify-email?token=${token}`;
  return sendEmail(
    env,
    to,
    '激活你的 Starlr Forum 账号',
    `<p>你好，<strong>${escapeHtml(nickname)}</strong>！</p>
     <p>感谢注册 Starlr Forum。请点击下面的按钮激活账号（链接 24 小时内有效）：</p>
     <p style="margin:20px 0;">
       <a href="${link}" style="background:#4f46e5;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;display:inline-block;">激活账号</a>
     </p>
     <p style="font-size:12px;color:#78716c;">如果按钮无法点击，请复制以下链接到浏览器打开：<br/>${link}</p>
     <p style="font-size:12px;color:#78716c;">未验证邮箱的账号可以浏览，但无法发帖、回复或上传图片。</p>`,
  );
}

export async function createPasswordResetToken(env: Env, userId: string): Promise<string> {
  const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
  const tokenHash = await sha256Hex(token);
  await env.CACHE.put(`pwreset:${tokenHash}`, userId, { expirationTtl: 1800 }); // 30 分钟
  return token;
}

/** 校验并消费密码重置令牌，返回 user_id（一次性） */
export async function consumePasswordResetToken(env: Env, token: string): Promise<string | null> {
  const tokenHash = await sha256Hex(token);
  const userId = await env.CACHE.get(`pwreset:${tokenHash}`);
  if (!userId) return null;
  await env.CACHE.delete(`pwreset:${tokenHash}`);
  return userId;
}
