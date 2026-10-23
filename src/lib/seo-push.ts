/**
 * 发帖/更新后把 URL 提交给搜索引擎（百度主动推送 + IndexNow/Bing）。
 * 均未配置时静默跳过；任何失败只记录日志，不影响主流程。
 */
import type { Env } from '../types';
import { baiduPush, indexNowPush, getSeoConfig, canonicalUrl } from './seo';

export async function pushPostUrl(env: Env, postId: string): Promise<void> {
  const cfg = await getSeoConfig(env);
  if (!cfg.baidu_push_token && !cfg.indexnow_key) return;
  const url = canonicalUrl(cfg, `/post/${postId}`);
  if (cfg.baidu_push_token) {
    const res = await baiduPush(env, [url]);
    if (!res.ok) console.warn('[seo] 百度推送失败:', res.message);
  }
  if (cfg.indexnow_key) {
    const res = await indexNowPush(env, [url]);
    if (!res.ok) console.warn('[seo] IndexNow 推送失败:', res.message);
  }
}
