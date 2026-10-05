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
    const name = match[1].toLowerCase();
    // 排除常见误伤（如邮箱片段）— 简化处理：前后是字母数字则跳过由调用方在入库前决定
    found.add(name);
    if (found.size >= limit) break;
  }
  return [...found];
}
