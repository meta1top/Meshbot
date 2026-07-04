import { LLMUSE_CLOSE, LLMUSE_OPEN } from "@meshbot/types-agent";

/** `<llmuse>` 块里描述的当前会话上下文（频道/私聊）。 */
export interface LlmuseConversation {
  id: string;
  type: "channel" | "dm";
  name: string;
  unread: number;
}

/** 路由 → 人类可读页面名。未知路径回退原始 pathname。 */
export function describeRoute(pathname: string): string {
  if (pathname.startsWith("/assistant")) return "助手会话";
  if (pathname.startsWith("/messages")) return "消息";
  if (pathname.startsWith("/skills")) return "技能";
  if (pathname.startsWith("/drive")) return "文件";
  if (pathname.startsWith("/flows")) return "流程";
  if (pathname.startsWith("/more") || pathname.startsWith("/schedule"))
    return "设置";
  return pathname;
}

/** 组装隐藏 `<llmuse>` 块：页面行 + 可选会话行。末尾不带换行（拼接方负责）。 */
export function formatLlmuseBlock(ctx: {
  pageLabel: string;
  conversation: LlmuseConversation | null;
}): string {
  const lines = [`页面: ${ctx.pageLabel}`];
  if (ctx.conversation) {
    const c = ctx.conversation;
    lines.push(`会话: ${c.name} (${c.type}, id=${c.id}), 未读 ${c.unread}`);
  }
  return `${LLMUSE_OPEN}\n${lines.join("\n")}\n${LLMUSE_CLOSE}`;
}
