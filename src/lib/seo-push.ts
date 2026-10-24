/**
 * 搜索引擎推送层：百度主动推送 + IndexNow（Bing/Yandex）。
 * - 每次推送写 seo_push_log（后台「推送记录」页数据源）
 * - 失败自动重试（最多 3 次，间隔 2s/8s）
 * - 同一 (post, channel, event) 1 小时内去重，避免编辑抖动刷日志
 * - 删除后向 IndexNow 通知移除 URL（百度无删除接口，只记日志）
 * 均为尽力而为：失败只记日志，不影响主流程。
 */
import type { Env } from '../types';
import { baiduPush, indexNowPush, getSeoConfig, canonicalUrl } from './seo';

export type PushEvent = 'create' | 'edit' | 'delete' | 'retry' | 'cron';

const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [2_000, 8_000];
const DEDUP_WINDOW_S = 3_600;
const LOG_RETENTION_DAYS = 90;

async function logPush(
  env: Env,
  row: { postId: string; url: string; channel: string; event: PushEvent; status: 'ok' | 'failed'; httpCode?: number | null; attempts: number; message?: string },
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO seo_push_log (id, post_id, url, channel, event, status, http_code, attempts, message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        crypto.randomUUID().replace(/-/g, '').slice(0, 20),
        row.postId,
        row.url,
        row.channel,
        row.event,
        row.status,
        row.httpCode ?? null,
        row.attempts,
        (row.message ?? '').slice(0, 400),
      )
      .run();
    // 顺带清理过期日志（低频写入时 5% 概率顺路做，不做定时任务）
    if (Math.random() < 0.05) {
      await env.DB.prepare(`DELETE FROM seo_push_log WHERE created_at < datetime('now', '-${LOG_RETENTION_DAYS} days')`).run();
    }
  } catch (e) {
    // 日志表可能尚未迁移：不阻塞推送主流程
    console.warn('[seo] 写推送日志失败:', e instanceof Error ? e.message : e);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 带 1 小时窗口去重的单渠道推送 + 重试，返回是否成功 */
async function pushChannel(
  env: Env,
  channel: 'baidu' | 'indexnow',
  postId: string,
  url: string,
  event: PushEvent,
  fn: () => Promise<{ ok: boolean; message: string }>,
): Promise<boolean> {
  // 去重：同 (post, channel, event) 1 小时内已有成功记录则跳过
  try {
    const dup = await env.DB.prepare(
      `SELECT 1 FROM seo_push_log
       WHERE post_id = ? AND channel = ? AND event = ? AND status = 'ok'
         AND created_at >= datetime('now', '-${DEDUP_WINDOW_S / 60} minutes') LIMIT 1`,
    )
      .bind(postId, channel, event)
      .first();
    if (dup) return true;
  } catch {
    /* 日志表不可用时不去重，照常推送 */
  }

  let last: { ok: boolean; message: string; httpCode?: number } = { ok: false, message: '未执行' };
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    last = await fn();
    if (last.ok) {
      await logPush(env, { postId, url, channel, event, status: 'ok', httpCode: last.httpCode, attempts: attempt, message: last.message });
      return true;
    }
    // 429 = 被限流，重试只会加重；直接记录失败（保留最后一次 http 状态码）
    if (last.httpCode === 429) break;
    if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAYS_MS[attempt - 1]);
  }
  await logPush(env, { postId, url, channel, event, status: 'failed', httpCode: last.httpCode, attempts: MAX_ATTEMPTS, message: last.message });
  return false;
}

/** 发帖：百度 + IndexNow 双渠道 */
export async function pushPostUrl(env: Env, postId: string): Promise<void> {
  const cfg = await getSeoConfig(env);
  const url = canonicalUrl(cfg, `/post/${postId}`);
  if (cfg.baidu_push_token) {
    await pushChannel(env, 'baidu', postId, url, 'create', () => baiduPush(env, [url]));
  }
  if (cfg.indexnow_key) {
    await pushChannel(env, 'indexnow', postId, url, 'create', () => indexNowPush(env, [url]));
  }
}

/** 编辑后重新推送（IndexNow 支持内容更新重提；百度同 URL 重推即刷新） */
export async function repushPostUrl(env: Env, postId: string): Promise<void> {
  const cfg = await getSeoConfig(env);
  const url = canonicalUrl(cfg, `/post/${postId}`);
  if (cfg.baidu_push_token) {
    await pushChannel(env, 'baidu', postId, url, 'edit', () => baiduPush(env, [url]));
  }
  if (cfg.indexnow_key) {
    await pushChannel(env, 'indexnow', postId, url, 'edit', () => indexNowPush(env, [url]));
  }
}

/** 删除后通知引擎移除（IndexNow 删除列表；百度无删除接口，记日志供人工在站长平台处理） */
export async function removePostUrl(env: Env, postId: string): Promise<void> {
  const cfg = await getSeoConfig(env);
  const url = canonicalUrl(cfg, `/post/${postId}`);
  if (cfg.indexnow_key) {
    try {
      const res = await fetch(
        `https://api.indexnow.org/indexnow?url=${encodeURIComponent(url)}&key=${encodeURIComponent(cfg.indexnow_key)}&urlList=${encodeURIComponent(url)}`,
        { method: 'GET', headers: { 'User-Agent': 'StarlrForum/1.0' } },
      );
      const ok = res.status === 200 || res.status === 202;
      await logPush(env, {
        postId, url, channel: 'indexnow', event: 'delete', status: ok ? 'ok' : 'failed',
        httpCode: res.status, attempts: 1, message: ok ? '已通知删除' : `删除通知失败 HTTP ${res.status}`,
      });
    } catch (e) {
      await logPush(env, {
        postId, url, channel: 'indexnow', event: 'delete', status: 'failed', attempts: 1,
        message: `删除通知异常：${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }
  if (cfg.baidu_push_token) {
    await logPush(env, {
      postId, url, channel: 'baidu', event: 'delete', status: 'failed', attempts: 0,
      message: '百度无删除接口，请到百度站长平台手动提交死链',
    });
  }
}

/** 定期全量校验（cron 触发）：把 30 天内未成功推送过的帖子重新提交 */
export async function pushAllPosts(env: Env, limit = 500): Promise<number> {
  const cfg = await getSeoConfig(env);
  if (!cfg.indexnow_key && !cfg.baidu_push_token) return 0;
  const { results } = await env.DB.prepare(
    `SELECT p.id FROM posts p
     WHERE p.is_deleted = 0
       AND NOT EXISTS (
         SELECT 1 FROM seo_push_log l
         WHERE l.post_id = p.id AND l.status = 'ok' AND l.created_at >= datetime('now', '-30 days')
       )
     ORDER BY p.created_at DESC LIMIT ?`,
  )
    .bind(limit)
    .all<{ id: string }>();
  const ids = (results ?? []).map((r) => r.id);
  if (ids.length === 0) return 0;
  // 百度：批量一次提交（协议支持 \n 分隔多 URL）
  if (cfg.baidu_push_token) {
    const urls = ids.map((id) => canonicalUrl(cfg, `/post/${id}`));
    const r = await baiduPush(env, urls);
    for (const id of ids) {
      await logPush(env, {
        postId: id, url: canonicalUrl(cfg, `/post/${id}`), channel: 'baidu', event: 'cron',
        status: r.ok ? 'ok' : 'failed', httpCode: r.httpCode, attempts: 1, message: r.message,
      });
    }
  }
  // IndexNow：一次批量请求（urlList），避免逐帖请求触发 429 限流
  if (cfg.indexnow_key) {
    const urls = ids.map((id) => canonicalUrl(cfg, `/post/${id}`));
    const r = await indexNowPush(env, urls);
    // 每条帖子都记一行日志（成功/失败一致），便于后台按帖查看
    for (const id of ids) {
      await logPush(env, {
        postId: id, url: canonicalUrl(cfg, `/post/${id}`), channel: 'indexnow', event: 'cron',
        status: r.ok ? 'ok' : 'failed', httpCode: r.httpCode, attempts: 1, message: r.message,
      });
    }
  }
  return ids.length;
}
