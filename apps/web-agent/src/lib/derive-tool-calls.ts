/** 工具调用摘要(右区工具面板用)。 */
export interface ToolCallSummary {
  toolCallId: string;
  toolName: string;
}

/** 最小消息形状:只关心 toolCalls。 */
interface MsgLike {
  toolCalls?: { toolCallId: string; toolName: string }[];
}

/** 按消息顺序展平所有 toolCalls。空/缺省安全。 */
export function deriveToolCalls(messages: MsgLike[]): ToolCallSummary[] {
  const out: ToolCallSummary[] = [];
  for (const m of messages) {
    for (const tc of m.toolCalls ?? []) {
      out.push({ toolCallId: tc.toolCallId, toolName: tc.toolName });
    }
  }
  return out;
}
