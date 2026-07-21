import type { HistoryMessage, HistoryToolCall } from "@meshbot/types-agent";
import { computeToolCallStatus } from "./session-history-status";

/**
 * 装配所需的 `session_messages` 行最小形状。
 *
 * 刻意不引用 TypeORM 实体：本模块是纯函数，既被 REST（`SessionController.history`）
 * 也被跨设备查询（`RemoteQueryInboundService` 的 history 分支）复用，还要能脱离
 * ORM 直接单测。
 */
export interface HistoryAssemblyRow {
  id: string;
  role: string;
  content: string;
  reasoning?: string | null;
  /**
   * assistant 行：LangChain 原始形态 tool_calls 的 JSON 字符串（`[{id,name,args}]`），
   * **不含执行结果**——结果落在独立的 `role="tool"` 行上，靠 `toolCallId` 关联。
   */
  toolCalls?: string | null;
  /** `role="tool"` 行专用：本行是哪次 tool_call 的执行结果。 */
  toolCallId?: string | null;
  /** 原始 metadata JSON 列：压缩占位行携带 kind="compaction"、tool 行携带 ok。 */
  metadata?: string | null;
}

/** {@link assembleHistoryMessages} 入参。 */
export interface HistoryAssemblyInput {
  /** listPage 返回的原始行（含 role="tool" 结果行），按 seq 升序。 */
  rows: readonly HistoryAssemblyRow[];
  /**
   * 是否还有更早的**行**可翻页（`SessionMessageService.listPage` 原样透传）。
   *
   * 注意口径：它统计的是原始行、而非过滤掉 tool 行后的**可见消息**条数，因此
   * `messages.length` 通常远小于请求的 limit，调用方**不得**据 `messages.length`
   * 反推 hasMore（那会在「本页可见消息很少但还有更早历史」时误判为没有更多，
   * 上拉加载直接断掉）。本函数原样透传即为此。
   */
  hasMore: boolean;
  /**
   * dispatch_subagent 嵌套卡认领：`parentToolCallId` → 子会话 id。
   * 缺省视为空（无子会话可认领）。
   */
  childByToolCallId?: ReadonlyMap<string, string>;
}

/** {@link assembleHistoryMessages} 出参（`HistoryResponse` 的 messages/hasMore 两项）。 */
export interface HistoryAssemblyResult {
  messages: HistoryMessage[];
  hasMore: boolean;
}

/**
 * 把 `session_messages` 原始行装配成对外的 `HistoryMessage[]`。
 *
 * 本仓消息存储把「一次工具调用」拆成两行：assistant 行的 `tool_calls` JSON
 * （只有 id/name/args）+ 独立的 `role="tool"` 结果行（`langgraph_id === toolCallId`，
 * `metadata.ok` 记成败）。前端需要的是合并后的单个视图对象，合并只此一处：
 *
 * - 按 `toolCallId` 建 tool 行索引，逐个 langchain call 产出
 *   `{toolCallId,name,args,status,result,subSessionId?}`；
 * - `status` 由 {@link computeToolCallStatus} 算（无 tool 行→running、
 *   `metadata.ok===false`→error、其余→ok）；
 * - `result` 取 tool 行的 `content`（无则空串）；
 * - `role="tool"` 行本身被过滤掉——它是执行结果的落库行，不是可展示消息。
 *
 * 抽成纯函数的原因：远程（跨设备）history 此前直出裸 ORM 行、完全绕开本逻辑，
 * 前端只能防御式补救（status 硬编码 "ok" → 失败工具显示成成功、result 永远空、
 * subSessionId 丢失）。现在两条路径共用这一份，杜绝语义漂移。
 */
export function assembleHistoryMessages(
  input: HistoryAssemblyInput,
): HistoryAssemblyResult {
  const { rows, hasMore, childByToolCallId } = input;

  const toolByCallId = new Map<string, HistoryAssemblyRow>();
  for (const r of rows) {
    if (r.role === "tool" && r.toolCallId) {
      toolByCallId.set(r.toolCallId, r);
    }
  }

  const messages = rows
    .filter((r) => r.role !== "tool")
    .map((r): HistoryMessage => {
      const meta = r.metadata
        ? (JSON.parse(r.metadata) as Record<string, unknown>)
        : null;
      const fb =
        meta && (meta.feedback === "up" || meta.feedback === "down")
          ? (meta.feedback as "up" | "down")
          : null;
      const base = {
        id: r.id,
        role: r.role as "user" | "assistant" | "system",
        content: r.content,
        ...(r.reasoning ? { reasoning: r.reasoning } : {}),
        metadata:
          meta && meta.kind === "compaction"
            ? (meta as unknown as {
                kind: "compaction";
                removedCount: number;
                fromMessageId: string;
                toMessageId: string;
              })
            : null,
        feedback: fb,
      };
      if (r.role !== "assistant" || !r.toolCalls) return base;
      try {
        const calls = JSON.parse(r.toolCalls) as Array<{
          id: string;
          name: string;
          args: unknown;
        }>;
        const toolCalls: HistoryToolCall[] = calls.map((c) => {
          const tr = toolByCallId.get(c.id);
          const status = computeToolCallStatus(tr);
          const subSessionId = childByToolCallId?.get(c.id);
          return {
            toolCallId: c.id,
            name: c.name,
            args: c.args,
            status,
            result: tr?.content ?? "",
            ...(subSessionId ? { subSessionId } : {}),
          };
        });
        return { ...base, toolCalls };
      } catch {
        return base;
      }
    });

  return { messages, hasMore };
}
