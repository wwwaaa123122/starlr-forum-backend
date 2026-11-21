/**
 * lib/markdown 单测：服务端 SEO 预渲染的安全 HTML 输出。
 * 重点验证 XSS 防线（先整体转义再白名单替换）与链接白名单。
 */
import { describe, it, expect } from 'vitest';
import { renderMarkdown, plainText, escapeHtml } from '../src/lib/markdown';

describe('escapeHtml', () => {
  it('五类字符全转义', () => {
    expect(escapeHtml(`<a href="x">&'y'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;y&#39;&lt;/a&gt;');
  });
});

describe('XSS 防线（核心安全语义）', () => {
  it('原始 HTML 全部转义，不会被解析为标签', () => {
    const html = renderMarkdown('<script>alert(1)</script>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('img onerror 注入被转义（带空格的 URL 不满足图片语法 → 整体转义为文本）', () => {
    const html = renderMarkdown('![x"](https://e/a.png "onerror=alert(1)');
    // 带空格的 URL 不匹配图片正则 → 原文转义为纯文本；无论如何不得出现 <img ... onerror
    expect(html).not.toContain('<img');
    expect(html).toContain('&quot;'); // 双引号已转义
  });

  it('img alt 中的双引号被转义（防属性逃逸）', () => {
    const html = renderMarkdown('![x" onerror=alert(1)](https://e.com/a.png)');
    // alt 里的引号转义为 &quot;：字符串 onerror=alert(1) 只存在于 alt 文本中，
    // 且因为它前面是 &quot; 而非裸引号，无法闭合属性成为真正的 HTML 属性
    expect(html).toBe('<p><img src="https://e.com/a.png" alt="x&quot; onerror=alert(1)" loading="lazy" /></p>');
  });

  it('javascript: URL 被拒绝（链接原样保留为文本）', () => {
    const html = renderMarkdown('[点击](javascript:alert(1))');
    expect(html).not.toContain('<a href="javascript');
    expect(html).toContain('javascript:alert(1)'); // 作为纯文本展示
  });

  it('data: URL 被拒绝', () => {
    const html = renderMarkdown('[x](data:text/html;base64,PHNjcmlwdD4=)');
    expect(html).not.toContain('href="data:');
  });

  it('协议相对路径 // 被拒绝（防跳到外部域）', () => {
    const html = renderMarkdown('[x](//evil.com/a)');
    expect(html).not.toContain('href="//evil.com');
  });

  it('URL 中的 & 只转义一次（不出现 &amp;amp;）', () => {
    const html = renderMarkdown('[x](https://e.com/a?b=1&c=2)');
    expect(html).toContain('href="https://e.com/a?b=1&amp;c=2"');
    expect(html).not.toContain('&amp;amp;');
  });

  it('代码块内容整体转义（HTML 代码示例原样展示）', () => {
    const html = renderMarkdown('```\n<script>alert(1)</script>\n```');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('链接/图片白名单', () => {
  it('https 链接带 nofollow ugc', () => {
    expect(renderMarkdown('[官网](https://e.com)')).toContain('<a href="https://e.com" rel="nofollow ugc">官网</a>');
  });
  it('http 链接允许', () => {
    expect(renderMarkdown('[x](http://e.com)')).toContain('href="http://e.com"');
  });
  it('站内相对路径允许', () => {
    expect(renderMarkdown('[x](/api/files/abc)')).toContain('href="/api/files/abc"');
  });
  it('图片输出 loading=lazy', () => {
    expect(renderMarkdown('![alt](https://e.com/a.png)')).toContain('<img src="https://e.com/a.png" alt="alt" loading="lazy" />');
  });
  it('不安全 URL 的链接保留原文（不渲染为 a 标签）', () => {
    const html = renderMarkdown('[text](ftp://e.com/f)');
    expect(html).not.toContain('<a ');
    expect(html).toContain('[text](ftp://e.com/f)');
  });
});

describe('块级结构', () => {
  it('标题降一级（帖子内 h2 起）', () => {
    expect(renderMarkdown('# 一级')).toContain('<h2>一级</h2>');
    expect(renderMarkdown('### 三级')).toContain('<h4>三级</h4>');
    expect(renderMarkdown('###### 六级')).toContain('<h6>六级</h6>'); // cap
  });
  it('列表：ul/ol 各自成对、切换时闭合重开', () => {
    const html = renderMarkdown('- a\n- b\n1. c\n2. d');
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>a</li>');
    expect(html).toContain('</ul>');
    expect(html).toContain('<ol>');
    expect(html).toContain('<li>c</li>');
    expect(html).toContain('</ol>');
  });
  it('引用、分隔线、行内代码/粗体/斜体/删除线', () => {
    expect(renderMarkdown('> 引言')).toContain('<blockquote>引言</blockquote>');
    expect(renderMarkdown('---')).toContain('<hr />');
    expect(renderMarkdown('`code` **b** *i* ~~s~~')).toContain('<code>code</code>');
    expect(renderMarkdown('`code` **b** *i* ~~s~~')).toContain('<strong>b</strong>');
    expect(renderMarkdown('`code` **b** *i* ~~s~~')).toContain('<em>i</em>');
    expect(renderMarkdown('`code` **b** *i* ~~s~~')).toContain('<del>s</del>');
  });
  it('未闭合代码块：剩余内容仍以 pre 输出', () => {
    const html = renderMarkdown('前文\n```js\nconst x = 1;');
    expect(html).toContain('<pre><code>const x = 1;</code></pre>');
    expect(html).toContain('<p>前文</p>');
  });
  it('CRLF 归一化', () => {
    expect(renderMarkdown('a\r\n\r\nb')).toContain('<p>a</p>');
  });
});

describe('plainText 摘要', () => {
  it('代码块/图片剔除，链接留文本', () => {
    expect(plainText('看[这个](https://e.com)就够了\n```js\nsecret()\n```')).not.toContain('secret');
    expect(plainText('看[这个](https://e.com)就够了')).toContain('看这个就够了');
  });
  it('长文本截断加省略号', () => {
    const out = plainText('a'.repeat(200), 150);
    expect(out.length).toBeLessThanOrEqual(151);
    expect(out.endsWith('…')).toBe(true);
  });
  it('markdown 语法字符清除', () => {
    expect(plainText('# 标题 **粗**')).toBe('标题 粗');
  });
});
