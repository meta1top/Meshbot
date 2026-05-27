/**
 * 解析 LLM 输出为建议数组：按行切分，去掉行首序号/项目符号、首尾引号，
 * 去空行，最多取 max 条。
 */
export function parseSuggestions(raw: string, max = 3): string[] {
  return raw
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s*[-*•]\s*/, "")
        .replace(/^\s*\d+[.、)]\s*/, "")
        .replace(/^["'""]|["'""]$/g, "")
        .trim(),
    )
    .filter((line) => line.length > 0)
    .slice(0, max);
}
