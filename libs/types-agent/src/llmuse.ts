/** `<llmuse>` 隐藏块的开/闭标签（前端组装/剥离 + 系统提示三处共用的单一来源）。 */
export const LLMUSE_OPEN = "<llmuse>";
export const LLMUSE_CLOSE = "</llmuse>";

const LLMUSE_BLOCK_RE = /<llmuse>[\s\S]*?<\/llmuse>\n*/g;

/**
 * 剥离消息文本里所有 `<llmuse>…</llmuse>` 块（及块后紧邻换行），返回用户可见正文。
 *
 * 用于前端渲染助手会话消息时隐藏该块。未闭合标签不匹配，原样保留，避免误伤正文。
 */
export function stripLlmuse(content: string): string {
  return content.replace(LLMUSE_BLOCK_RE, "").trimStart();
}
