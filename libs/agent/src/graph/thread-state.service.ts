import { randomUUID } from "node:crypto";
import type { BaseMessage } from "@langchain/core/messages";
import { RemoveMessage, SystemMessage } from "@langchain/core/messages";
import { Injectable } from "@nestjs/common";
import { AccountGraphProvider } from "./account-graph.provider.js";
import type { GraphState } from "./graph.builder.js";
import type { Message, ThreadId } from "./graph.types.js";

/**
 * 封装 checkpointer 状态的读写与修复操作。
 *
 * 包含：clearThread / sanitizeOrphanToolCalls / cutMessagesAfter /
 * getMessagesSnapshot / getHistory / applyCompaction，以及私有辅助 roleOf。
 * 这些方法全部依赖 AccountGraphProvider 提供的同账号 graph/checkpointer，
 * 不新开 sqlite 连接，复用已有的 better-sqlite3 连接。
 */
@Injectable()
export class ThreadStateService {
  constructor(private readonly accountGraphProvider: AccountGraphProvider) {}

  /**
   * 删除某 thread（=sessionId）在当前账号 checkpoint 库的全部 checkpoints/writes。
   * 走 checkpoint-sqlite 1.x 官方 `deleteThread`（同一 better-sqlite3 连接，不再
   * 直接拼 SQL 删表——0.x 时代无官方 API 的权宜已废）。
   * 幂等：表未懒建（官方实现不做 setup，实测抛 no such table）与无匹配行均不报错；
   * 其余错误（连接 / IO 等真实故障）照抛。须在账号上下文内调用。
   */
  async clearThread(threadId: string): Promise<void> {
    try {
      await this.accountGraphProvider
        .accountGraph()
        .checkpointer.deleteThread(threadId);
    } catch (err) {
      if (!(err instanceof Error && /no such table/i.test(err.message))) {
        throw err;
      }
    }
  }

  /**
   * 剪掉 checkpointer 里 trailing 的孤儿 tool_calls —— 即末尾 AIMessage 带
   * `tool_calls` 但后面没有对应数量的 ToolMessage。
   *
   * 触发场景：上一次 run 在 supervisor emit tool_calls 之后、tools 节点完成之前
   * 中断（abort / 进程崩 / 我们自己的 bug）。下次 resume 时 LLM 会校验
   * 「tool_calls 必须有 ToolMessage 跟随」直接 400，会话彻底卡死。剪掉脏 tail
   * 让 LLM 看到「user 消息后没有 pending 工具调用」自然重新决策。
   *
   * 用 RemoveMessage + updateState：reducer 识别 RemoveMessage 后从 state 里删
   * 对应 id（messages.reducer 已扩展过）。
   */
  async sanitizeOrphanToolCalls(threadId: ThreadId): Promise<void> {
    const snapshot = await this.accountGraphProvider
      .accountGraph()
      .graph.getState({
        configurable: { thread_id: threadId },
      });
    const msgs = (snapshot.values as GraphState | undefined)?.messages;
    if (!Array.isArray(msgs) || msgs.length === 0) return;
    const toRemove: string[] = [];
    // 从末尾向前找：连续的「带 tool_calls 但没有对应 ToolMessage 收尾」AIMessage
    // 都剪掉，直到遇到一个干净的（非 AIMessage 或 tool_calls 已被 ToolMessage 满足）。
    let i = msgs.length - 1;
    while (i >= 0) {
      const m = msgs[i] as BaseMessage & { tool_calls?: unknown[] };
      const toolCalls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
      if (m._getType() !== "ai" || toolCalls.length === 0) break;
      // 这条 AI 带 tool_calls；看它后面的 ToolMessage 是否覆盖所有 tool_call_id
      const expectedIds = new Set(
        toolCalls
          .map((c) => (c as { id?: string }).id)
          .filter((id): id is string => typeof id === "string"),
      );
      for (let j = i + 1; j < msgs.length; j++) {
        const after = msgs[j] as BaseMessage & { tool_call_id?: string };
        if (after._getType() === "tool" && after.tool_call_id) {
          expectedIds.delete(after.tool_call_id);
        }
      }
      if (expectedIds.size === 0) break; // 已全覆盖，干净
      if (m.id) toRemove.push(m.id);
      i--;
    }
    if (toRemove.length === 0) return;
    console.warn(
      `[graph] sanitizeOrphanToolCalls thread=${threadId} 剪掉 ${toRemove.length} 条孤儿 tool_calls AI 消息：${toRemove.join(", ")}`,
    );
    await this.accountGraphProvider
      .accountGraph()
      .graph.updateState(
        { configurable: { thread_id: threadId } },
        { messages: toRemove.map((id) => new RemoveMessage({ id })) },
      );
  }

  /**
   * 从 checkpointer state 里剪掉 cutoff message 之后的所有消息（含 assistant
   * / tool / 后续轮 user）。cutoff 本身保留。供「重生成」流程用。
   *
   * 用 RemoveMessage + updateState（messages reducer 已支持 RemoveMessage）。
   * 找不到 cutoff message 时静默 no-op，让上层决定怎么处理。
   */
  async cutMessagesAfter(
    threadId: ThreadId,
    cutoffMessageId: string,
  ): Promise<void> {
    const snapshot = await this.accountGraphProvider
      .accountGraph()
      .graph.getState({
        configurable: { thread_id: threadId },
      });
    const msgs = (snapshot.values as GraphState | undefined)?.messages ?? [];
    const idx = msgs.findIndex((m) => m.id === cutoffMessageId);
    if (idx < 0) return;
    const toRemove = msgs
      .slice(idx + 1)
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string");
    if (toRemove.length === 0) return;
    console.warn(
      `[graph] cutMessagesAfter thread=${threadId} cutoff=${cutoffMessageId} 剪掉 ${toRemove.length} 条后续消息：${toRemove.join(", ")}`,
    );
    await this.accountGraphProvider
      .accountGraph()
      .graph.updateState(
        { configurable: { thread_id: threadId } },
        { messages: toRemove.map((id) => new RemoveMessage({ id })) },
      );
  }

  /**
   * 拿出 checkpointer 里当前 thread 的 messages 数组快照。
   *
   * 给 ContextCompactor 用于切分计算。返回空数组表示线程没历史。
   */
  async getMessagesSnapshot(threadId: ThreadId): Promise<BaseMessage[]> {
    const snapshot = await this.accountGraphProvider
      .accountGraph()
      .graph.getState({
        configurable: { thread_id: threadId },
      });
    const msgs = (snapshot.values as GraphState | undefined)?.messages;
    return Array.isArray(msgs) ? msgs : [];
  }

  /**
   * 取会话已处理消息历史（来自 checkpointer）。
   *
   * 过滤掉无可显示文本的消息（例如 tool_call-only 的 AIMessage、
   * 中断/失败留下的空 AIMessage），避免前端渲染空气泡。
   * 缺 id 的也跳过（不再用 randomUUID 兜底，因为每次刷新会变 → 前端按 id 去重失效）。
   */
  async getHistory(threadId: ThreadId): Promise<Message[]> {
    const snapshot = await this.accountGraphProvider
      .accountGraph()
      .graph.getState({
        configurable: { thread_id: threadId },
      });
    const values = snapshot.values as GraphState;
    if (!values?.messages) return [];
    const result: Message[] = [];
    for (const m of values.messages) {
      if (!m.id) continue;
      const content = typeof m.content === "string" ? m.content : "";
      if (!content) continue;
      const reasoning =
        typeof m.additional_kwargs?.reasoning_content === "string"
          ? m.additional_kwargs.reasoning_content
          : undefined;
      result.push({
        id: m.id,
        role: this.roleOf(m),
        content,
        ...(reasoning ? { reasoning } : {}),
      });
    }
    return result;
  }

  /**
   * 一次性 updateState 重排压缩结果，让 LLM 看到的顺序是：
   *   [原系统提示词（若有，无 id 不会被删，自动留在最前）] [新摘要 system] [保留区 messages]
   *
   * 实现：reducer 是 `kept.concat(appended)`，只能 append、不能插中间。所以：
   * - removeIds 传入「所有带 id 的消息」（摘要区 + 保留区），把它们从 state 删掉；
   * - 系统提示词由 `new SystemMessage(prompt)` 创建时无 id，reducer 的 `!m.id`
   *   分支让它无条件保留在原位（首条），不需要也无法 remove；
   * - 然后按 [摘要, ...保留区原对象] 顺序 append。保留区消息复用原对象（id 不变），
   *   被删后又重新加回 → 等效"移动到摘要之后"。
   *
   * 最终 state = [system(留), summary, ...keep]，摘要位于保留区之前，时序正确，
   * 且 system 仍在最前（跨 provider 友好）。
   */
  async applyCompaction(
    threadId: ThreadId,
    params: {
      removeIds: string[];
      summaryText: string;
      keep: BaseMessage[];
    },
  ): Promise<void> {
    const ops: BaseMessage[] = params.removeIds.map(
      (id) => new RemoveMessage({ id }),
    );
    ops.push(
      new SystemMessage({
        content: `[Earlier conversation summary]\n${params.summaryText}`,
        id: `compaction-summary-${randomUUID()}`,
      }),
    );
    ops.push(...params.keep);
    await this.accountGraphProvider
      .accountGraph()
      .graph.updateState(
        { configurable: { thread_id: threadId } },
        { messages: ops },
      );
  }

  private roleOf(m: BaseMessage): "user" | "assistant" | "system" {
    const t = m._getType();
    if (t === "human") return "user";
    if (t === "system") return "system";
    return "assistant";
  }
}
