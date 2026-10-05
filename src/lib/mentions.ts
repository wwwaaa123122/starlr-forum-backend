/**
 * @ 提及解析。
 * 语法：@用户名（用户名为 3-24 位字母/数字/下划线/中文）。
 * 限制单条内容最多 N 个提及，防止滥用通知轰炸。
 */
const MENTION_RE = /@([\p{L}\p{N}_-]{2,24})/gu;
export const MAX_MENTIONS = 5;

export function extractMentions(content: string, limit = MAX_MENTIONS): string[] {
  const found = new Set<string>();
  for (const match of content.matchAll(MENTION_RE)) {
    // 保留原始大小写：昵称区分大小写匹配；用户名匹配时由调用方转小写
    found.add(match[1]);
    if (found.size >= limit) break;
  }
  return [...found];
}
