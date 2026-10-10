/**
 * 极简 Markdown → 安全 HTML（仅服务端 SEO 预渲染用，与前端 RichText 保持一致的语义）
 * 原则：先整体转义 HTML，再做白名单语法替换；链接/图片仅允许 http(s) 与站内相对路径。
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 反转义 HTML 实体（safeUrl 的输入来自整体转义后的正文，先还原再做白名单校验） */
function unescapeHtml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    // &amp; 必须最后还原，避免 &amp;lt; 这类原文被二次解开
    .replace(/&amp;/g, '&');
}

/** 链接/图片地址白名单：http(s):// 或 / 开头。
 *  输入是整体 escapeHtml 后的文本：先还原再校验、只转义一次，避免 URL 中的 & 被渲染成 &amp;amp; */
function safeUrl(url: string): string | null {
  const u = unescapeHtml(url.trim());
  if (/^https?:\/\//i.test(u)) return escapeHtml(u);
  if (u.startsWith('/') && !u.startsWith('//')) return escapeHtml(u);
  return null;
}

function inline(text: string): string {
  let out = escapeHtml(text);
  // 行内代码
  out = out.replace(/`([^`]+)`/g, (_m, code) => `<code>${code}</code>`);
  // 图片 ![alt](url)
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, url) => {
    const safe = safeUrl(url);
    return safe ? `<img src="${safe}" alt="${alt}" loading="lazy" />` : m;
  });
  // 链接 [text](url)
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
    const safe = safeUrl(url);
    return safe ? `<a href="${safe}" rel="nofollow ugc">${label}</a>` : m;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return out;
}

/** 渲染 Markdown 为 HTML 片段（正文用 article 包裹） */
export function renderMarkdown(md: string): string {
  const lines = (md ?? '').replace(/\r\n?/g, '\n').split('\n');
  const html: string[] = [];
  let listType: 'ul' | 'ol' | null = null;
  let inCode = false;
  let codeBuf: string[] = [];
  let para: string[] = [];

  const flushPara = () => {
    if (para.length) {
      html.push(`<p>${para.map(inline).join('<br />')}</p>`);
      para = [];
    }
  };
  const closeList = () => {
    if (listType) {
      html.push(`</${listType}>`);
      listType = null;
    }
  };

  for (const line of lines) {
    if (/^```/.test(line.trim())) {
      if (inCode) {
        html.push(`<pre><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`);
        codeBuf = [];
        inCode = false;
      } else {
        flushPara();
        closeList();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      continue;
    }
    const t = line.trim();
    if (!t) {
      flushPara();
      closeList();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(t);
    if (heading) {
      flushPara();
      closeList();
      const level = Math.min(6, heading[1].length + 1); // 帖子内标题降一级（页面已有 h1）
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(t)) {
      flushPara();
      closeList();
      html.push('<hr />');
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(t);
    if (quote) {
      flushPara();
      closeList();
      html.push(`<blockquote>${inline(quote[1])}</blockquote>`);
      continue;
    }
    const ul = /^[-*+]\s+(.*)$/.exec(t);
    const ol = /^\d+[.)]\s+(.*)$/.exec(t);
    if (ul || ol) {
      flushPara();
      const want: 'ul' | 'ol' = ul ? 'ul' : 'ol';
      if (listType !== want) {
        closeList();
        html.push(`<${want}>`);
        listType = want;
      }
      html.push(`<li>${inline((ul ?? ol)![1])}</li>`);
      continue;
    }
    para.push(t);
  }
  if (inCode && codeBuf.length) html.push(`<pre><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`);
  flushPara();
  closeList();
  return html.join('\n');
}

/** 纯文本摘要（meta description / JSON-LD 用） */
export function plainText(md: string, max = 150): string {
  const text = (md ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}…`;
}

export { escapeHtml };
