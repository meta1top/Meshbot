import type { BaseMessage } from "@langchain/core/messages";

/**
 * 估算单条 message 的 token 占用。
 *
 * 启发式：把 content 主体 + tool_calls 序列化后的字符长度 / 4 向上取整。
 * GPT 系英文约 4 char/token；中文实际 1-2 char/token（偏低估，对预算有利）。
 *
 * **不引入 tiktoken**：各 provider 分词不同，没有统一 JS 库。切分预算估算
 * 偏低对我们有利（实际保留区 token 比预算更少，留有缓冲）。
 */
export function estimateTokens(m: BaseMessage): number {
  const content = m.content;
  const text =
    typeof content === "string" ? content : JSON.stringify(content ?? "");
  const toolCalls = (m as BaseMessage & { tool_calls?: unknown[] }).tool_calls;
  const toolCallsLen = Array.isArray(toolCalls)
    ? JSON.stringify(toolCalls).length
    : 0;
  return Math.ceil((text.length + toolCallsLen) / 4);
}

/**
 * 从尾部往前累加 token，找切分点。
 *
 * 返回的 idx 满足：messages[idx..] 总 token ≤ budget < messages[(idx-1)..]
 * 即 [idx, length) 是「保留区」，[0, idx) 是「待压缩区」。
 * 全部都在预算内时返 0（不压缩任何消息）。
 */
export function findSplitIndex(
  messages: BaseMessage[],
  budget: number,
): number {
  let acc = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    acc += estimateTokens(messages[i]);
    if (acc > budget) {
      // 若这是最后一条（尾部第一条扫描到的），已超预算时仍保留它，
      // 避免 keep 区完全为空。否则正常返回 i+1。
      return i === messages.length - 1 ? i : i + 1;
    }
  }
  return 0;
}

/**
 * 扩展 splitIdx 到 tool 对的左边界（不切断 tool_call/tool_result pair）。
 *
 * 若 messages[splitIdx] 是孤儿 ToolMessage（其 owner AIMessage 在
 * summarize 区），把 splitIdx 移到 owner 之前，使整对一起进 summarize 区。
 * 循环直到 messages[splitIdx] 不再是孤儿 ToolMessage。
 *
 * 关键性约束：LLM 看到 tool_calls 没对应 ToolMessage（或反过来）会 400。
 * 同款逻辑在 graph.service.sanitizeOrphanToolCalls 验证过。
 */
export function expandToToolBoundary(
  messages: BaseMessage[],
  splitIdx: number,
): number {
  // 限循环次数，防异常数据导致死循环
  for (let safety = 0; safety < messages.length + 1; safety++) {
    if (splitIdx >= messages.length) return splitIdx;
    const right = messages[splitIdx];
    if (right._getType() !== "tool") return splitIdx;
    const toolCallId = (right as BaseMessage & { tool_call_id?: string })
      .tool_call_id;
    if (!toolCallId) return splitIdx;
    const ownerIdx = findToolCallOwner(messages, toolCallId, splitIdx);
    // owner 不在 summarize 区（已在 keep 区或找不到），无需调整
    if (ownerIdx < 0 || ownerIdx >= splitIdx) return splitIdx;
    // owner 在 summarize 区：把 owner 的所有 tool result 都推入 summarize 区。
    // 扫描 owner.tool_calls，找其所有 ToolMessage，取最大 index+1 作为新 splitIdx。
    const ownerMsg = messages[ownerIdx] as BaseMessage & {
      tool_calls?: { id?: string }[];
    };
    const ownerCallIds = new Set(
      (ownerMsg.tool_calls ?? []).map((c) => c.id).filter(Boolean),
    );
    let newSplit = splitIdx + 1;
    while (newSplit < messages.length) {
      const next = messages[newSplit];
      if (next._getType() !== "tool") break;
      const nextCallId = (next as BaseMessage & { tool_call_id?: string })
        .tool_call_id;
      if (!nextCallId || !ownerCallIds.has(nextCallId)) break;
      newSplit++;
    }
    splitIdx = newSplit;
  }
  return splitIdx;
}

function findToolCallOwner(
  messages: BaseMessage[],
  toolCallId: string,
  upTo: number,
): number {
  for (let i = upTo - 1; i >= 0; i--) {
    const m = messages[i] as BaseMessage & { tool_calls?: { id?: string }[] };
    if (m._getType() !== "ai" || !Array.isArray(m.tool_calls)) continue;
    if (m.tool_calls.some((c) => c.id === toolCallId)) return i;
  }
  return -1;
}

const TOOL_RESULT_MAX_CHARS = 500;

/**
 * 把 messages 拍扁成单段文本，喂给摘要 LLM。
 *
 * 规则：
 * - HumanMessage / AIMessage 按 [user] / [assistant] 前缀加 content
 * - AIMessage 带 tool_calls 时追加一行 `  -> tool <name>(args)`
 * - ToolMessage 渲染为 `[tool <call_id>] result: <content>`；content 超过
 *   TOOL_RESULT_MAX_CHARS 时尾部截断为 "... [truncated N chars]"，防止
 *   截图 base64 等大对象递归喂回摘要 LLM 自己的 input
 */
export function serializeForSummary(messages: BaseMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    const t = m._getType();
    const content =
      typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    if (t === "human") {
      lines.push(`[user] ${content}`);
    } else if (t === "ai") {
      const ai = m as BaseMessage & {
        tool_calls?: { name?: string; args?: unknown }[];
      };
      if (content) lines.push(`[assistant] ${content}`);
      if (Array.isArray(ai.tool_calls) && ai.tool_calls.length > 0) {
        for (const call of ai.tool_calls) {
          lines.push(
            `  -> tool ${call.name ?? "?"}(${JSON.stringify(call.args ?? {})})`,
          );
        }
      }
    } else if (t === "tool") {
      const tm = m as BaseMessage & { tool_call_id?: string };
      const truncated =
        content.length > TOOL_RESULT_MAX_CHARS
          ? `${content.slice(0, TOOL_RESULT_MAX_CHARS)}... [truncated ${
              content.length - TOOL_RESULT_MAX_CHARS
            } chars]`
          : content;
      lines.push(`[tool ${tm.tool_call_id ?? "?"}] result: ${truncated}`);
    } else if (t === "system") {
      lines.push(`[system] ${content}`);
    }
  }
  return lines.join("\n");
}

/**
 * 识别 LLM 返回的 `context_length_exceeded` 类错误。
 *
 * 不同 provider 的错误形态不同；匹配不到一律返 false，让上层走非 ctx 错误路径。
 */
export function isContextLengthError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as Record<string, unknown>;
  // OpenAI / DeepSeek / OpenAI-compatible
  const errCode = (e.error as { code?: string } | undefined)?.code;
  if (errCode === "context_length_exceeded") return true;
  // HTTP 400 + message 含 context 字样
  if (
    e.status === 400 &&
    typeof e.message === "string" &&
    /context/i.test(e.message)
  ) {
    return true;
  }
  // Anthropic
  const errType = (e.error as { type?: string } | undefined)?.type;
  if (
    errType === "invalid_request_error" &&
    typeof e.message === "string" &&
    /prompt is too long/i.test(e.message)
  ) {
    return true;
  }
  // Gemini
  if (typeof e.message === "string" && /exceeds the maximum/i.test(e.message)) {
    return true;
  }
  return false;
}
