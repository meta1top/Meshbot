/** content 是否 @ 了自己（任一 handle 命中，大小写不敏感、词边界）。 */
export function mentionsSelf(content: string, selfHandles: string[]): boolean {
  for (const h of selfHandles) {
    if (!h) continue;
    const escaped = h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`@${escaped}(?![\\w-])`, "i");
    if (re.test(content)) return true;
  }
  return false;
}

/** 是否触发伴生 Agent 运行：开关开 + 非自己发 + (私信 | 频道@自己)。 */
export function shouldTriggerCompanion(input: {
  convType: "channel" | "dm";
  senderId: string;
  selfId: string;
  content: string;
  selfHandles: string[];
  agentEnabled: boolean;
}): boolean {
  if (!input.agentEnabled) return false;
  if (input.senderId === input.selfId) return false;
  if (input.convType === "dm") return true;
  return mentionsSelf(input.content, input.selfHandles);
}
