/**
 * SEO 基础设施：canonical 主域、爬虫识别、服务端 HTML 模板（动态渲染）。
 *
 * 背景本站真实情况：
 *  - 前端是纯 SPA（React），百度等不支持 JS 渲染的爬虫抓不到任何正文；
 *  - x.182030.xyz 与 forum.182030.xyz 同内容（f.182030.xyz 为独立纯前端）→ 重复内容；
 *  - 因此由 Worker 对爬虫 UA 直接输出带正文的语义化 HTML（内容与真人所见一致），
 *    并统一 canonical 到主域。
 */
import type { Env } from '../types';
import { escapeHtml } from './markdown';

export interface SeoConfig {
  /** 唯一对外主域（不带协议）。抓取/canonical/sitemap 全部归并到这里 */
  canonical_host: string;
  baidu_verify?: string;
  google_verify?: string;
  bing_verify?: string;
  /** 百度站长平台主动推送 token（data.zz.baidu.com/urls） */
  baidu_push_token?: string;
}

/** 未在管理后台配置 canonical_host 时的兜底值；自部署者应在后台「SEO/服务配置」里填自己的域名 */
export const DEFAULT_CANONICAL_HOST = 'forum.182030.xyz';

function defaultHost(env: Env): string {
  if (env.SITE_URL) {
    try {
      return new URL(env.SITE_URL).host;
    } catch {
      /* SITE_URL 非法则继续用兜底 */
    }
  }
  return DEFAULT_CANONICAL_HOST;
}

export async function getSeoConfig(env: Env): Promise<SeoConfig> {
  try {
    const raw = await env.CACHE.get('config:seo');
    if (raw) {
      const cfg = JSON.parse(raw) as Partial<SeoConfig>;
      return { canonical_host: cfg.canonical_host || defaultHost(env), ...cfg } as SeoConfig;
    }
  } catch {
    /* KV 异常走默认 */
  }
  return { canonical_host: defaultHost(env) };
}

/** 站点根 URL（无尾斜杠）：用于拼接具体路径 */
export const siteRoot = (cfg: SeoConfig) => `https://${cfg.canonical_host}`;

export function canonicalUrl(cfg: SeoConfig, path: string): string {
  let p = path || '/';
  if (!p.startsWith('/')) p = `/${p}`;
  return p === '/' ? `${siteRoot(cfg)}/` : `${siteRoot(cfg)}${p.replace(/\/+$/, '')}`;
}

/** 主流搜索引擎 + 社交分享卡片爬虫（大小写不敏感的子串匹配即可） */
const BOT_PATTERNS = [
  'baiduspider', 'sogou', '360spider', 'yisouspider', 'sm.cn', 'bytespider',
  'googlebot', 'bingbot', 'yandexbot', 'duckduckbot', 'slurp', 'applebot',
  'facebookexternalhit', 'twitterbot', 'linkedinbot', 'whatsapp', 'telegrambot',
  'petalbot', 'semrushbot', 'ahrefsbot', 'gptbot', 'claudebot', 'perplexitybot',
];

export function isCrawler(c: { req: { header(name: string): string | undefined } }): boolean {
  const ua = (c.req.header('User-Agent') ?? '').toLowerCase();
  if (!ua) return false;
  if (!BOT_PATTERNS.some((p) => ua.includes(p))) return false;
  // 仅 HTML 导航需要预渲染；feed/API 拉取走各自端点
  const accept = c.req.header('Accept') ?? '';
  return accept.includes('text/html') || accept === '*/*';
}

export interface PageMeta {
  title: string;
  description: string;
  path: string;
  /** JSON-LD 结构化数据（可多个） */
  jsonLd?: Record<string, unknown>[];
  /** 额外 head 标签（原始 HTML） */
  extraHead?: string;
  /** 禁止收录（登录/设置等页） */
  noindex?: boolean;
}

function verifyMetas(cfg: SeoConfig, host: string): string {
  if (host !== cfg.canonical_host) return '';
  const tags: string[] = [];
  if (cfg.baidu_verify) tags.push(`<meta name="baidu-site-verification" content="${cfg.baidu_verify}" />`);
  if (cfg.google_verify) tags.push(`<meta name="google-site-verification" content="${cfg.google_verify}" />`);
  if (cfg.bing_verify) tags.push(`<meta name="msvalidate.01" content="${cfg.bing_verify}" />`);
  return tags.join('\n  ');
}

/** 服务端整页 HTML（爬虫渲染 + 真人 SPA 壳共用模板） */
export function renderPage(opts: {
  meta: PageMeta;
  cfg: SeoConfig;
  /** 当前请求的 host（决定验证 meta 是否输出） */
  host: string;
  bodyHtml: string;
  /** 真人访问：输出 SPA 壳（脚本），爬虫：输出静态正文 */
  mode: 'bot' | 'spa';
  spaScript?: string;
}): string {
  const { meta, cfg, host, bodyHtml, mode } = opts;
  // meta.title / meta.description 常含用户可控内容（帖子标题、摘要、用户 bio/昵称等，见 routes/seo.ts 各调用点，
  // 调用方均传原文、未自行转义），在此统一做一次 HTML 转义，防止爬虫渲染页（含 og:title/og:description）的存储型 XSS。
  const safeTitle = escapeHtml(meta.title);
  const safeDescription = escapeHtml(meta.description);
  const canonical = canonicalUrl(cfg, meta.path);
  const jsonLd = (meta.jsonLd ?? []).map((o) => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, '\\u003c')}</script>`).join('\n  ');
  const robots = meta.noindex ? '<meta name="robots" content="noindex, follow" />' : `<meta name="robots" content="index, follow, max-image-preview:large" />`;
  const ogType = meta.jsonLd?.[0]?.['@type'] === 'DiscussionForumPosting' ? 'article' : 'website';

  const spaHead = mode === 'spa' ? (opts.spaScript ?? '') : '';
  const botBody = mode === 'bot'
    ? bodyHtml
    : `<div id="root"></div>${spaHead}`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
<title>${safeTitle}</title>
<meta name="description" content="${safeDescription}" />
${robots}
<link rel="canonical" href="${canonical}" />
<meta property="og:site_name" content="Starlr Forum" />
<meta property="og:type" content="${ogType}" />
<meta property="og:title" content="${safeTitle}" />
<meta property="og:description" content="${safeDescription}" />
<meta property="og:url" content="${canonical}" />
<meta property="og:locale" content="zh_CN" />
<meta name="twitter:card" content="summary" />
${verifyMetas(cfg, host)}
<link rel="alternate" type="application/rss+xml" title="Starlr Forum" href="${canonicalUrl(cfg, '/feed.xml')}" />
${jsonLd}
</head>
<body>
${botBody}
</body>
</html>`;
}

/** 百度主动推送（实时提交，收录加速）；失败静默（只返回错误信息供日志） */
export async function baiduPush(env: Env, urls: string[]): Promise<{ ok: boolean; message: string }> {
  const cfg = await getSeoConfig(env);
  if (!cfg.baidu_push_token) return { ok: false, message: '未配置 baidu_push_token' };
  try {
    const res = await fetch(`http://data.zz.baidu.com/urls?site=${cfg.canonical_host}&token=${cfg.baidu_push_token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: urls.join('\n'),
    });
    const data = (await res.json().catch(() => ({}))) as { success?: number; remain?: number; message?: string };
    if (res.ok && data.success !== undefined) {
      return { ok: true, message: `推送成功 ${data.success} 条，剩余配额 ${data.remain ?? '?'}` };
    }
    return { ok: false, message: `推送失败 HTTP ${res.status}: ${data.message ?? ''}` };
  } catch (e) {
    return { ok: false, message: `推送异常：${e instanceof Error ? e.message : String(e)}` };
  }
}
