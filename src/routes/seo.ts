/**
 * SEO 爬虫层：
 *  - /robots.txt、/sitemap.xml、/feed.xml —— 所有域名可用，URL 只写主域
 *  - 爬虫 UA 的 HTML 导航 → 服务端渲染真实正文（与前端一致）；真人 → 转发 SPA 资源
 *
 * 注意：本路由挂在所有业务路由之前；被 wrangler.x.jsonc 的 run_worker_first
 * 覆盖到的 HTML 路径会先进本 Worker，非爬虫一律 ASSETS.fetch 透传。
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../types';
import { getSeoConfig, canonicalUrl, siteRoot, renderPage, isCrawler } from '../lib/seo';
import { renderMarkdown, plainText, escapeHtml } from '../lib/markdown';
import { newId } from '../lib/ids';

const app = new Hono<AppEnv>();

/**
 * 真人访问兜底：有 ASSETS（x / f Worker）→ 转发 SPA 资源；
 * 无 ASSETS（纯 API Worker forum-backend）→ 空 404（与 index.ts notFound 约定一致，
 * 不返回任何 JSON/版本/接口线索，避免被扫描与逆向）。
 */
async function spaFallback(c: Context<AppEnv>): Promise<Response> {
  if (c.env.ASSETS) return c.env.ASSETS.fetch(c.req.raw);
  return c.body(null, 404);
}

const SITE_NAME = 'Starlr Forum';
const SITE_TAGLINE = '一个把论坛装进时间线的社区';

// ---------------------------------------------------------------- robots.txt
app.get('/robots.txt', async (c) => {
  const cfg = await getSeoConfig(c.env);
  const host = c.req.header('host') ?? cfg.canonical_host;
  const isCanonical = host.replace(/:\d+$/, '') === cfg.canonical_host;
  const lines = [
    'User-agent: *',
    isCanonical ? 'Allow: /' : 'Allow: /$', // 非主域：只允许抓首页（canonical 归并）
    isCanonical ? '' : 'Disallow: /',
    `Disallow: /api/`,
    'Disallow: /admin',
    'Disallow: /settings',
    'Disallow: /notifications',
    'Disallow: /bookmarks',
    'Disallow: /login',
    'Disallow: /register',
    'Disallow: /compose',
    'Disallow: /auth/',
    `Sitemap: ${canonicalUrl(cfg, '/sitemap.xml')}`,
    '',
  ];
  c.header('Content-Type', 'text/plain; charset=utf-8');
  c.header('Cache-Control', 'public, max-age=3600');
  return c.body(lines.filter((l) => l !== undefined).join('\n'));
});

// ---------------------------------------------------------------- sitemap.xml
app.get('/sitemap.xml', async (c) => {
  const cfg = await getSeoConfig(c.env);
  const base = siteRoot(cfg);
  const db = c.env.DB;
  const urls: { loc: string; lastmod?: string; priority: string; freq: string }[] = [
    { loc: `${base}/`, freq: 'hourly', priority: '1.0' },
    { loc: `${base}/categories`, freq: 'daily', priority: '0.8' },
    { loc: `${base}/explore`, freq: 'daily', priority: '0.7' },
    { loc: `${base}/terms`, freq: 'yearly', priority: '0.2' },
    { loc: `${base}/privacy`, freq: 'yearly', priority: '0.2' },
  ];
  try {
    const { results: posts } = await db
      .prepare(`SELECT id, updated_at, last_reply_at, created_at FROM posts WHERE is_deleted = 0 ORDER BY created_at DESC LIMIT 5000`)
      .all<{ id: string; updated_at: string | null; last_reply_at: string | null; created_at: string }>();
    for (const p of posts) {
      urls.push({ loc: `${base}/post/${p.id}`, lastmod: (p.last_reply_at || p.updated_at || p.created_at).replace(' ', 'T') + 'Z', freq: p.last_reply_at ? 'hourly' : 'weekly', priority: '0.9' });
    }
    const { results: users } = await db
      .prepare(`SELECT username, updated_at FROM users WHERE status = 'active' LIMIT 2000`)
      .all<{ username: string; updated_at: string | null }>();
    for (const u of users) urls.push({ loc: `${base}/u/${encodeURIComponent(u.username)}`, freq: 'daily', priority: '0.5' });
    const { results: cats } = await db.prepare(`SELECT id, slug FROM categories`).all<{ id: string; slug: string }>();
    for (const cat of cats) urls.push({ loc: `${base}/explore?category=${encodeURIComponent(cat.slug || cat.id)}`, freq: 'hourly', priority: '0.7' });
  } catch {
    /* 表查询失败时至少输出静态页 */
  }
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
  .map(
    (u) =>
      `  <url>\n    <loc>${u.loc}</loc>\n${u.lastmod ? `    <lastmod>${u.lastmod}</lastmod>\n` : ''}    <changefreq>${u.freq}</changefreq>\n    <priority>${u.priority}</priority>\n  </url>`,
  )
  .join('\n')}
</urlset>`;
  c.header('Content-Type', 'application/xml; charset=utf-8');
  c.header('Cache-Control', 'public, max-age=1800');
  return c.body(xml);
});

// ---------------------------------------------------------------- RSS
app.get('/feed.xml', async (c) => {
  const cfg = await getSeoConfig(c.env);
  const base = siteRoot(cfg);
  const { results: posts } = await c.env.DB
    .prepare(`SELECT p.id, p.title, p.content, p.created_at, u.nickname, u.username_raw
              FROM posts p LEFT JOIN users u ON u.id = p.author_id
              WHERE p.is_deleted = 0 ORDER BY p.created_at DESC LIMIT 50`)
    .all<{ id: string; title: string; content: string; created_at: string; nickname: string | null; username_raw: string }>();
  const items = posts
    .map(
      (p) => `  <item>
    <title>${escapeHtml(p.title)}</title>
    <link>${base}/post/${p.id}</link>
    <guid isPermaLink="true">${base}/post/${p.id}</guid>
    <dc:creator>${escapeHtml(p.nickname || p.username_raw || '匿名')}</dc:creator>
    <pubDate>${new Date(p.created_at.replace(' ', 'T') + 'Z').toUTCString()}</pubDate>
    <description>${escapeHtml(plainText(p.content, 200))}</description>
  </item>`,
    )
    .join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel>
  <title>${SITE_NAME}</title>
  <link>${base}/</link>
  <description>${SITE_TAGLINE}</description>
  <language>zh-CN</language>
${items}
</channel>
</rss>`;
  c.header('Content-Type', 'application/rss+xml; charset=utf-8');
  c.header('Cache-Control', 'public, max-age=600');
  return c.body(xml);
});

// ---------------------------------------------------------------- 爬虫动态渲染
const esc = escapeHtml;

app.get('/', async (c) => {
  const ua = c.req.header('User-Agent') ?? '';
  if (!isCrawler(c)) return spaFallback(c); // 真人 → SPA
  const cfg = await getSeoConfig(c.env);
  const base = siteRoot(cfg);
  const { results: posts } = await c.env.DB
    .prepare(`SELECT p.id, p.title, p.content, p.reply_count, p.view_count, p.created_at, u.nickname, u.username_raw, cat.name AS cat_name
              FROM posts p LEFT JOIN users u ON u.id = p.author_id LEFT JOIN categories cat ON cat.id = p.category_id
              WHERE p.is_deleted = 0 ORDER BY p.is_pinned DESC, p.created_at DESC LIMIT 30`)
    .all<{ id: string; title: string; content: string; reply_count: number; view_count: number; created_at: string; nickname: string | null; username_raw: string; cat_name: string | null }>();
  const list = posts
    .map(
      (p) => `<li><a href="${base}/post/${p.id}">${esc(p.title)}</a>
  <span>${esc(p.nickname || p.username_raw || '')}</span> · ${esc(p.created_at)} · 回复 ${p.reply_count} · 浏览 ${p.view_count}
  <p>${esc(plainText(p.content, 120))}</p></li>`,
    )
    .join('\n');
  return c.html(
    renderPage({
      mode: 'bot',
      host: c.req.header('host') ?? cfg.canonical_host,
      cfg,
      meta: {
        title: 'Starlr Forum', // 与前端 SPA 首页标题一致
        description: `${SITE_NAME}（${cfg.canonical_host.replace(/^www\./, '')}）：${SITE_TAGLINE}。最新讨论：${posts.slice(0, 3).map((p) => p.title).join('、')}`,
        path: '/',
        jsonLd: [
          { '@context': 'https://schema.org', '@type': 'WebSite', name: SITE_NAME, url: `${base}/`, inLanguage: 'zh-CN', description: SITE_TAGLINE },
        ],
      },
      bodyHtml: `<h1>${SITE_NAME}</h1><p>${SITE_TAGLINE}</p><ul>${list}</ul><p><a href="${base}/categories">浏览全部板块</a></p>`,
    }),
  );
});

app.get('/post/:id', async (c) => {
  const id = c.req.param('id');
  if (!isCrawler(c)) return spaFallback(c);
  const cfg = await getSeoConfig(c.env);
  const base = siteRoot(cfg);
  const row = await c.env.DB
    .prepare(`SELECT p.id, p.title, p.content, p.created_at, p.updated_at, p.reply_count, p.view_count, p.like_count,
                     u.nickname, u.username_raw, cat.name AS cat_name, cat.slug AS cat_slug
              FROM posts p LEFT JOIN users u ON u.id = p.author_id LEFT JOIN categories cat ON cat.id = p.category_id
              WHERE p.id = ? AND p.is_deleted = 0`)
    .bind(id)
    .first<{ id: string; title: string; content: string; created_at: string; updated_at: string | null; reply_count: number; view_count: number; like_count: number; nickname: string | null; username_raw: string; cat_name: string | null; cat_slug: string | null }>();
  if (!row) return spaFallback(c);

  const { results: replies } = await c.env.DB
    .prepare(`SELECT r.content, r.created_at, u.nickname, u.username_raw
              FROM replies r LEFT JOIN users u ON u.id = r.author_id
              WHERE r.post_id = ? AND r.is_deleted = 0 ORDER BY r.created_at ASC LIMIT 100`)
    .bind(id)
    .all<{ content: string; created_at: string; nickname: string | null; username_raw: string }>();

  const url = `${base}/post/${row.id}`;
  const desc = plainText(row.content, 150);
  const jsonLd = [
    {
      '@context': 'https://schema.org',
      '@type': 'DiscussionForumPosting',
      '@id': url,
      url,
      headline: row.title,
      description: desc,
      datePublished: row.created_at.replace(' ', 'T') + 'Z',
      dateModified: (row.updated_at || row.created_at).replace(' ', 'T') + 'Z',
      author: { '@type': 'Person', name: row.nickname || row.username_raw || '匿名', url: `${base}/u/${encodeURIComponent(row.username_raw || '')}` },
      interactionStatistic: [
        { '@type': 'InteractionCounter', interactionType: 'https://schema.org/CommentAction', userInteractionCount: row.reply_count },
        { '@type': 'InteractionCounter', interactionType: 'https://schema.org/ViewAction', userInteractionCount: row.view_count },
        { '@type': 'InteractionCounter', interactionType: 'https://schema.org/LikeAction', userInteractionCount: row.like_count },
      ],
      isPartOf: { '@type': 'WebSite', name: SITE_NAME, url: `${base}/` },
    },
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: SITE_NAME, item: `${base}/` },
        { '@type': 'ListItem', position: 2, name: row.cat_name ?? '讨论', item: row.cat_slug ? `${base}/c/${row.cat_slug}` : `${base}/categories` },
        { '@type': 'ListItem', position: 3, name: row.title },
      ],
    },
  ];
  const repliesHtml = replies.length
    ? `<h2>回复（${replies.length}）</h2><ol>${replies
        .map(
          (r) =>
            `<li><b>${esc(r.nickname || r.username_raw || '匿名')}</b> <time>${esc(r.created_at)}</time><div>${renderMarkdown(r.content)}</div></li>`,
        )
        .join('')}</ol>`
    : '<p>暂无回复</p>';
  return c.html(
    renderPage({
      mode: 'bot',
      host: c.req.header('host') ?? cfg.canonical_host,
      cfg,
      meta: {
        title: row.title, // 文章页标题就用文章标题（与前端 SPA 一致）
        description: desc,
        path: `/post/${row.id}`,
        jsonLd,
      },
      bodyHtml: `<nav><a href="${base}/">首页</a> › <a href="${base}/categories">${esc(row.cat_name ?? '板块')}</a></nav>
<article>
  <h1>${esc(row.title)}</h1>
  <p class="meta">${esc(row.nickname || row.username_raw || '匿名')} · ${esc(row.created_at)} · 浏览 ${row.view_count} · 回复 ${row.reply_count}</p>
  <div class="content">${renderMarkdown(row.content)}</div>
</article>
${repliesHtml}`,
    }),
  );
});

app.get('/categories', async (c) => {
  if (!isCrawler(c)) return spaFallback(c);
  const cfg = await getSeoConfig(c.env);
  const base = siteRoot(cfg);
  const { results: cats } = await c.env.DB
    .prepare(`SELECT cat.id, cat.slug, cat.name, cat.description,
              (SELECT COUNT(*) FROM posts p WHERE p.category_id = cat.id AND p.is_deleted = 0) AS post_count
              FROM categories cat ORDER BY cat.position, cat.id`)
    .all<{ id: string; slug: string; name: string; description: string | null; post_count: number }>();
  return c.html(
    renderPage({
      mode: 'bot',
      host: c.req.header('host') ?? cfg.canonical_host,
      cfg,
      meta: {
        title: `全部板块 - ${SITE_NAME}`,
        description: `${SITE_NAME}板块列表：${cats.map((x) => `${x.name}(${x.post_count}帖)`).join('、')}`,
        path: '/categories',
      },
      bodyHtml: `<h1>全部板块</h1><ul>${cats
        .map(
          (cat) =>
            `<li><a href="${base}/explore?category=${encodeURIComponent(cat.slug || cat.id)}">${esc(cat.name)}</a>（${cat.post_count} 帖）— ${esc(cat.description ?? '')}</li>`,
        )
        .join('')}</ul>`,
    }),
  );
});

// 板块页真人 URL 是 /explore?category=<slug>；爬虫 301 归并到同一 URL，保证收录地址与真人一致
app.get('/c/:slug', async (c) => {
  const slug = c.req.param('slug');
  if (!isCrawler(c)) return spaFallback(c);
  const cfg = await getSeoConfig(c.env);
  return c.redirect(`${siteRoot(cfg)}/explore?category=${encodeURIComponent(slug)}`, 301);
});

app.get('/u/:username', async (c) => {
  const username = decodeURIComponent(c.req.param('username'));
  if (!isCrawler(c)) return spaFallback(c);
  const cfg = await getSeoConfig(c.env);
  const base = siteRoot(cfg);
  const u = await c.env.DB
    .prepare(`SELECT username_raw, nickname, bio, avatar_url, created_at FROM users WHERE (username = ? OR username_raw = ?) AND status = 'active'`)
    .bind(username.toLowerCase(), username)
    .first<{ username_raw: string; nickname: string | null; bio: string | null; avatar_url: string | null; created_at: string }>();
  if (!u) return spaFallback(c);
  const { results: posts } = await c.env.DB
    .prepare(`SELECT id, title, content, created_at FROM posts WHERE author_id = (SELECT id FROM users WHERE username_raw = ?) AND is_deleted = 0 ORDER BY created_at DESC LIMIT 30`)
    .bind(u.username_raw)
    .all<{ id: string; title: string; content: string; created_at: string }>();
  const name = u.nickname || u.username_raw;
  return c.html(
    renderPage({
      mode: 'bot',
      host: c.req.header('host') ?? cfg.canonical_host,
      cfg,
      meta: {
        title: `${name} (@${u.username_raw}) - ${SITE_NAME}`,
        description: `${name} 的主页：${u.bio ? plainText(u.bio, 100) : `共发布 ${posts.length} 个帖子`}`,
        path: `/u/${encodeURIComponent(u.username_raw)}`,
        jsonLd: [{ '@context': 'https://schema.org', '@type': 'ProfilePage', mainEntity: { '@type': 'Person', name, alternateName: `@${u.username_raw}`, description: u.bio ?? undefined, url: `${base}/u/${encodeURIComponent(u.username_raw)}` } }],
      },
      bodyHtml: `<h1>${esc(name)} <small>@${esc(u.username_raw)}</small></h1><p>${esc(u.bio ?? '')}</p><p>加入于 ${esc(u.created_at)}</p><h2>帖子（${posts.length}）</h2><ul>${posts
        .map((p) => `<li><a href="${base}/post/${p.id}">${esc(p.title)}</a> · ${esc(p.created_at)}</li>`)
        .join('')}</ul>`,
    }),
  );
});

app.get('/explore', async (c) => {
  if (!isCrawler(c)) return spaFallback(c);
  const cfg = await getSeoConfig(c.env);
  const base = siteRoot(cfg);
  const category = c.req.query('category');
  const cat = category
    ? await c.env.DB.prepare(`SELECT id, slug, name, description FROM categories WHERE slug = ? OR id = ?`).bind(category, category)
        .first<{ id: string; slug: string; name: string; description: string | null }>()
    : null;
  const { results: posts } = cat
    ? await c.env.DB
        .prepare(`SELECT p.id, p.title, p.content, p.view_count, p.reply_count FROM posts p WHERE p.category_id = ? AND p.is_deleted = 0 ORDER BY p.is_pinned DESC, p.created_at DESC LIMIT 30`)
        .bind(cat.id)
        .all<{ id: string; title: string; content: string; view_count: number; reply_count: number }>()
    : await c.env.DB
        .prepare(`SELECT p.id, p.title, p.content, p.view_count, p.reply_count FROM posts p WHERE p.is_deleted = 0 ORDER BY (p.view_count + p.reply_count * 5) DESC LIMIT 30`)
        .all<{ id: string; title: string; content: string; view_count: number; reply_count: number }>();
  const title = cat ? `${cat.name} - ${SITE_NAME}` : `热门探索 - ${SITE_NAME}`;
  const path = cat ? `/explore?category=${encodeURIComponent(cat.slug || cat.id)}` : '/explore';
  return c.html(
    renderPage({
      mode: 'bot',
      host: c.req.header('host') ?? cfg.canonical_host,
      cfg,
      meta: {
        title,
        description: cat ? cat.description || `${SITE_NAME}「${cat.name}」板块讨论` : `${SITE_NAME}热门内容：${posts.slice(0, 3).map((p) => p.title).join('、')}`,
        path,
      },
      bodyHtml: `<h1>${esc(cat ? cat.name : '热门探索')}</h1>${cat ? `<p>${esc(cat.description ?? '')}</p>` : ''}<ul>${posts.map((p) => `<li><a href="${base}/post/${p.id}">${esc(p.title)}</a> · 浏览 ${p.view_count} · 回复 ${p.reply_count}<p>${esc(plainText(p.content, 100))}</p></li>`).join('')}</ul>`,
    }),
  );
});

/** 爬虫渲染兜底：由 index.ts 的 notFound 调用（显式页面路由未匹配时） */
export async function seoFallback(c: Context<AppEnv>): Promise<Response | undefined> {
  if (!isCrawler(c)) return undefined;
  const cfg = await getSeoConfig(c.env);
  return c.html(
    renderPage({
      mode: 'bot',
      host: c.req.header('host') ?? cfg.canonical_host,
      cfg,
      meta: { title: `页面不存在 - ${SITE_NAME}`, description: SITE_TAGLINE, path: new URL(c.req.raw.url).pathname, noindex: true },
      bodyHtml: `<h1>404</h1><p><a href="${canonicalUrl(cfg, '/')}">返回${SITE_NAME}首页</a></p>`,
    }),
  );
}

// 防止未使用 import 警告（newId 供未来 URL 短链用）
void newId;

export default app;
