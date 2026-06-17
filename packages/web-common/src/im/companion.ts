/** 伴生 Agent 侧栏用的最小消息结构（与 web-agent 的 TimelineMessage 结构兼容）。 */
export interface CandidateMessage {
  role: "user" | "assistant" | "system";
  content: string;
  streaming?: boolean;
  loading?: boolean;
  failed?: boolean;
}

/**
 * 选「最新可发的候选回复文本」：从尾部往前找第一条已定稿的 assistant 消息
 * （非流式、非 loading 占位、非失败、内容非空白）的 content；没有则 null。
 * 供侧栏「发送到会话」取候选。
 */
export function latestAssistantCandidate(
  messages: CandidateMessage[],
): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (
      m.role === "assistant" &&
      !m.streaming &&
      !m.loading &&
      !m.failed &&
      m.content.trim() !== ""
    ) {
      return m.content;
    }
  }
  return null;
}
