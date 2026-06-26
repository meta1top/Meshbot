import { randomUUID } from "node:crypto";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import {
  AIMessageChunk,
  HumanMessage,
  RemoveMessage,
  SystemMessage,
} from "@langchain/core/messages";
import { generateSnowflakeId } from "@meshbot/common";
import { Inject, Injectable, Optional } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { AccountContextService } from "../account/account-context.service";
import { createSqliteCheckpointer } from "../checkpoint/sqlite-checkpointer";
import { MeshbotConfigService } from "../config/meshbot-config.service";
import { MEMORY_GUIDE } from "../memory/memory-guide";
import { MemoryService } from "../memory/memory.service";
import { PromptService } from "../prompt/prompt.service";
import { SkillService } from "../skills/skill.service";
import { ToolRegistry } from "../tools/tool-registry";
import type { GraphState } from "./graph.builder";
import { buildSupervisorGraph } from "./graph.builder";
import { ModelResolver } from "./model-resolver.service";
import {
  RUNTIME_CONTEXT_PORT,
  type RuntimeContextPort,
} from "./runtime-context.port";
import type {
  AgentConfig,
  Message,
  StreamChunk,
  ThreadId,
} from "./graph.types";

/** 从一条 AIMessageChunk 抽取 tool_call 参数增量（流式预览用）。 */
export function extractToolCallArgDeltas(
  msg: AIMessageChunk,
): { index: number; name?: string; delta: string }[] {
  const chunks = (
    msg as {
      tool_call_chunks?: Array<{
        index?: number;
        name?: string;
        args?: string;
      }>;
    }
  ).tool_call_chunks;
  if (!chunks || chunks.length === 0) return [];
  const out: { index: number; name?: string; delta: string }[] = [];
  for (const c of chunks) {
    const delta = typeof c.args === "string" ? c.args : "";
    if (!delta && !c.name) continue;
    out.push({
      index: typeof c.index === "number" ? c.index : 0,
      name: c.name,
      delta,
    });
  }
  return out;
}

/**
 * 从累积的 AIMessageChunk 按 index 取某个 tool_call 的稳定 id。
 *
 * tool_call 的 id 只在该工具的首个流式分片里出现，后续 args 分片不带 id。
 * LangChain 的 `AIMessageChunk.concat` 用 `_mergeLists` 按 index 合并 tool_call_chunks
 * 并保留首个非空 id，所以从累积器里按 index 查即可拿到每个分片都对得上的稳定 id。
 * 取不到（id 还没流到 / 该 provider 流里不带 id）返回 undefined。
 */
export function resolveToolCallId(
  acc: AIMessageChunk,
  index: number,
): string | undefined {
  const chunks = (
    acc as {
      tool_call_chunks?: Array<{ index?: number; id?: string }>;
    }
  ).tool_call_chunks;
  const hit = chunks?.find((c) => c.index === index);
  return typeof hit?.id === "string" && hit.id ? hit.id : undefined;
}

/**
 * 组装 `<skills>` 系统块内容：已装技能的「名字 + 完整描述」目录。
 *
 * 这是「目录常驻、内容按需」：让 agent 始终知道有哪些技能(否则要先 skill_list 才知道)，
 * 完整 SKILL.md 仍由 skill_load 渐进加载。描述不截断,完整呈现。
 * 无技能时给出搜索/安装引导,避免空块。
 */
export function buildSkillsBlock(
  entries: { name: string; description: string }[],
): string {
  if (entries.length === 0) {
    return [
      "<skills>",
      "当前未安装任何技能。需要某类能力时用 skill_search_market 搜索市场，再 skill_install 安装。",
      "</skills>",
    ].join("\n");
  }
  const lines = entries.map((e) =>
    e.description ? `- ${e.name}: ${e.description}` : `- ${e.name}`,
  );
  return [
    "<skills>",
    "已安装技能（按需用 skill_load <name> 加载完整说明后再执行；更多能力用 skill_search_market 搜索市场再 skill_install）:",
    ...lines,
    "</skills>",
  ].join("\n");
}

@Injectable()
export class GraphService {
  /** 按账号缓存的 {graph, checkpointer}：checkpointer 指向该账号 accounts/<id>/agent.db。 */
  private readonly graphsByAccount = new Map<
    string,
    {
      graph: ReturnType<typeof buildSupervisorGraph>;
      checkpointer: ReturnType<typeof createSqliteCheckpointer>;
    }
  >();
  /** 模型生成的 AIMessage UUID -> 我方雪花。node 与 runGraphStream 共享，保证一致。 */
  private readonly msgIdMap = new Map<string, string>();

  /** 取/建某条 AIMessage 的雪花 id（get-or-create，幂等）。
   *  supervisor 节点（写 checkpointer）与 runGraphStream（发事件）解析同一雪花，
   *  使 checkpointer / session_messages / WS 事件三处 id 收口一致。 */
  private readonly resolveMessageId = (modelId: string): string => {
    let s = this.msgIdMap.get(modelId);
    if (!s) {
      s = generateSnowflakeId();
      this.msgIdMap.set(modelId, s);
    }
    return s;
  };

  constructor(
    private configService: MeshbotConfigService,
    private promptService: PromptService,
    private readonly toolRegistry: ToolRegistry,
    private readonly eventEmitter: EventEmitter2,
    private readonly account: AccountContextService,
    private readonly modelResolver: ModelResolver,
    @Optional()
    @Inject(RUNTIME_CONTEXT_PORT)
    private readonly runtimeContext?: RuntimeContextPort,
    @Optional() private readonly memory?: MemoryService,
    @Optional() private readonly skills?: SkillService,
  ) {}

  /**
   * 组装记忆段落，追加至系统提示末尾。
   *
   * 始终包含 MEMORY_GUIDE（工具使用规范）。
   * 若 core.md 非空，额外拼接 `<memory>...</memory>` 块（常驻精炼画像）。
   * 无 MemoryService 注入时返回空字符串（整段省略），不影响既有 harness。
   */
  private buildMemorySection(): string {
    const core = this.memory?.readCore() ?? "";
    if (!core) {
      return MEMORY_GUIDE;
    }
    return `${MEMORY_GUIDE}\n\n<memory>\n${core}\n</memory>`;
  }

  /** 组装运行时上下文消息（稳定 id system:ctx；每 run 刷新；不含易变 now）。 */
  private async buildContextMessage(
    threadId: ThreadId,
    kind?: string,
  ): Promise<SystemMessage> {
    const cloudUserId = this.account.getOrThrow();
    const ext = this.runtimeContext
      ? await this.runtimeContext.resolve()
      : null;
    const tz =
      ext?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    // 随手问（quick）会话：注入助手自己的名字（用户可改），让回复贴合用户设定的名字
    const isQuick = kind === "quick";
    const lines = [
      `cloudUserId: ${cloudUserId}`,
      `sessionId: ${threadId}`,
      ...(ext?.displayName ? [`user: ${ext.displayName}`] : []),
      ...(isQuick && ext?.quickAssistantName
        ? [`assistantName: ${ext.quickAssistantName}（你自己的名字）`]
        : []),
      `model: ${this.modelResolver.getMeta().model}`,
      ...(ext?.language ? [`language: ${ext.language}`] : []),
      `timezone: ${tz}`,
    ];
    return new SystemMessage({
      id: "system:ctx",
      content: `<context>\n${lines.join("\n")}\n</context>`,
    });
  }

  /**
   * 组装已装技能目录消息（稳定 id system:skills；每 run 刷新、reducer 按 id 原地更新）。
   * 目录常驻让 agent 始终知道有哪些技能；完整内容仍按需 skill_load 加载。
   */
  private buildSkillsMessage(): SystemMessage {
    const entries = this.skills?.list() ?? [];
    return new SystemMessage({
      id: "system:skills",
      content: buildSkillsBlock(entries),
    });
  }

  /**
   * 解析当前账号的 graph+checkpointer（首次建、之后缓存）。须在账号上下文内调用。
   *
   * 缓存常驻进程生命周期、不主动关闭——与改造前「单例 checkpointer 从不关闭」一致：
   * 同账号登出再登录复用同一连接（无重登双连接、无连接泄漏、无 use-after-close）；
   * 本地轨账号数有限，每账号一条常驻 SqliteSaver 连接的开销可接受。
   */
  private accountGraph(): {
    graph: ReturnType<typeof buildSupervisorGraph>;
    checkpointer: ReturnType<typeof createSqliteCheckpointer>;
  } {
    const acct = this.account.getOrThrow();
    let entry = this.graphsByAccount.get(acct);
    if (!entry) {
      const checkpointer = createSqliteCheckpointer(
        this.configService.getAccountCheckpointDbPath(),
      );
      const graph = buildSupervisorGraph(
        checkpointer,
        this.modelResolver.provider(),
        this.toolRegistry,
        this.eventEmitter,
        this.resolveMessageId,
      );
      entry = { graph, checkpointer };
      this.graphsByAccount.set(acct, entry);
    }
    return entry;
  }

  /**
   * 删除某 thread（=sessionId）在当前账号 checkpoint 库的 checkpoints/writes 行。
   * 复用该账号 checkpointer 的同一 better-sqlite3 连接（不另开连接，避免与
   * checkpointer 争锁）。同步执行；幂等：表未懒建或无匹配行均不报错。
   * 须在账号上下文内调用。
   */
  clearThread(threadId: string): void {
    const db = this.accountGraph().checkpointer.db;
    for (const table of ["checkpoints", "writes"]) {
      try {
        db.prepare(`DELETE FROM ${table} WHERE thread_id = ?`).run(threadId);
      } catch (err) {
        // 表尚未由 SqliteSaver.setup 建出 → 无可删，正常跳过；
        // 其余错误（连接 / IO 等真实故障）抛出，不静默掩盖。
        if (!(err instanceof Error && /no such table/i.test(err.message))) {
          throw err;
        }
      }
    }
  }

  /** 委派给 ModelResolver。 */
  private async resolveModel(): Promise<BaseChatModel> {
    return this.modelResolver.resolveModel();
  }

  /**
   * 给 SessionTitleService 用的标题模型：委派给 ModelResolver。
   */
  async getTitleModel(): Promise<BaseChatModel> {
    return this.modelResolver.getTitleModel();
  }

  /**
   * 创建会话，返回 thread id。
   *
   * 仅生成 UUID；system prompt 在每次 streamMessage 时按需前置，
   * 不在此处写入 checkpointer（checkpointer.put 直写 API 易出错）。
   * config 当前完全未使用（含 systemPrompt —— 系统提示统一由 PromptService 提供）；
   * 保留入参便于后续接入 temperature / model。
   */
  async startSession(_config: AgentConfig): Promise<ThreadId> {
    const threadId = randomUUID();
    return threadId;
  }

  /**
   * 向会话发送一批消息并逐 token 流式产出 assistant 回复。
   *
   * 每条入参构造一条带显式 id 的 HumanMessage（id = 调用方的 PendingMessage.id），
   * 让 checkpointer 里的 user 消息与 pending 表可对齐去重。
   * system prompt 仅在首轮注入（无历史时），避免在 checkpointer 状态里重复累加。
   * 透传 signal 支持中断。
   *
   * @param inputs 至少一条 —— 调用方保证非空批次。
   */
  async *streamMessage(
    threadId: ThreadId,
    inputs: { id: string; content: string }[],
    signal?: AbortSignal,
    kind?: string,
  ): AsyncGenerator<StreamChunk> {
    yield* this.streamMessageImpl(threadId, inputs, signal, kind);
  }

  private async *streamMessageImpl(
    threadId: ThreadId,
    inputs: { id: string; content: string }[],
    signal?: AbortSignal,
    kind?: string,
  ): AsyncGenerator<StreamChunk> {
    this.promptService.reloadIfChanged();
    const systemPrompt = [
      this.promptService.getPrompt("system"),
      this.buildMemorySection(),
    ]
      .filter(Boolean)
      .join("\n\n");
    await this.sanitizeOrphanToolCalls(threadId);
    const state = await this.accountGraph().graph.getState({
      configurable: { thread_id: threadId },
    });
    const hasHistory =
      Array.isArray((state.values as GraphState)?.messages) &&
      (state.values as GraphState).messages.length > 0;
    const inputMessages: BaseMessage[] = [];
    if (systemPrompt && !hasHistory) {
      inputMessages.push(new SystemMessage(systemPrompt));
    }
    // system:ctx / system:skills 用稳定 id 每轮重发；reducer 按 id 原地更新
    //（位置不变、不累积），无需先 RemoveMessage 再 Add。
    inputMessages.push(await this.buildContextMessage(threadId, kind));
    if (this.skills) {
      inputMessages.push(this.buildSkillsMessage());
    }
    for (const input of inputs) {
      inputMessages.push(
        new HumanMessage({ content: input.content, id: input.id }),
      );
    }
    // 先把本批次 user 消息以 human 事件 yield 出去，runner 据此 emit run.human，
    // 让 frontend 在 chunk 到达之前把 user 气泡从 pending 区迁到聊天区末尾，
    // 保证 user → assistant 视觉顺序与 checkpointer 状态一致。
    for (const input of inputs) {
      yield { kind: "human", messageId: input.id };
    }
    yield* this.runGraphStream(threadId, { messages: inputMessages }, signal);
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
  private async sanitizeOrphanToolCalls(threadId: ThreadId): Promise<void> {
    const snapshot = await this.accountGraph().graph.getState({
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
    await this.accountGraph().graph.updateState(
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
    const snapshot = await this.accountGraph().graph.getState({
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
    await this.accountGraph().graph.updateState(
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
    const snapshot = await this.accountGraph().graph.getState({
      configurable: { thread_id: threadId },
    });
    const msgs = (snapshot.values as GraphState | undefined)?.messages;
    return Array.isArray(msgs) ? msgs : [];
  }

  /**
   * 调摘要 LLM。serialized 已经是拍扁的对话文本（含 [user]/[assistant]/[tool]
   * 前缀、tool result 截断等），由调用方负责。这里只关心把 system prompt +
   * 用户串组合后丢给 enabled model invoke，并截 maxTokens。
   *
   * 用 AbortController 实现 timeoutMs；超时直接抛 Error("Summarize timeout")。
   */
  /** 委派给 ModelResolver。 */
  async summarize(
    serialized: string,
    opts: { systemPrompt: string; timeoutMs: number; maxTokens: number },
  ): Promise<string> {
    return this.modelResolver.summarize(serialized, opts);
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
    await this.accountGraph().graph.updateState(
      { configurable: { thread_id: threadId } },
      { messages: ops },
    );
  }

  /**
   * 不加新消息，从 checkpointer 现有状态恢复并流式产出 assistant 回复。
   *
   * 用于重试 —— failed 消息的 HumanMessage 已在会话里（最后一条），
   * 重试只让 graph 基于现有状态重跑产出回复。
   *
   * 传 `{ messages: [] }` 而非 `null`：已完成的图没有 pending task，
   * `stream(null)` 会原地返回不重跑；给一个空 messages 输入（concat reducer
   * 对空数组无副作用，不新增 user 消息）才会触发 START → supervisor 重新跑一轮。
   */
  async *resumeStream(
    threadId: ThreadId,
    signal?: AbortSignal,
    kind?: string,
  ): AsyncGenerator<StreamChunk> {
    await this.sanitizeOrphanToolCalls(threadId);
    yield* this.runGraphStream(
      threadId,
      {
        messages: [
          new RemoveMessage({ id: "system:ctx" }),
          await this.buildContextMessage(threadId, kind),
        ],
      },
      signal,
    );
  }

  /**
   * 执行 graph.stream 并把 AIMessageChunk 逐个 yield 成 StreamChunk；末尾 yield
   * usage 事件。
   *
   * 控制台打四个时间锚点（设 `MESHBOT_GRAPH_TIMING=0` 关闭）便于拆解延迟：
   *  - stream-init：graph.stream() 同步开销（图构建 / 凭证加载）
   *  - first-chunk：首个 AIMessageChunk 到达 = LLM TTFT（time-to-first-token）
   *  - last-chunk：末个 chunk 到达 = LLM 总产出时间
   *  - stream-close：异步迭代器关闭 = 流读取额外延迟
   */
  private async *runGraphStream(
    threadId: ThreadId,
    input: { messages: BaseMessage[] },
    signal?: AbortSignal,
  ): AsyncGenerator<StreamChunk> {
    const timing = process.env.MESHBOT_GRAPH_TIMING !== "0";
    const startedAt = Date.now();
    const stream = await this.accountGraph().graph.stream(input, {
      configurable: { thread_id: threadId },
      streamMode: ["messages", "updates"] as const,
      signal,
      // LangGraph 默认 recursionLimit=25，长会话 + 频繁 tool 调用容易撞墙
      // （报 GraphRecursionError）。可通过 MESHBOT_GRAPH_RECURSION_LIMIT 调整。
      recursionLimit: resolveRecursionLimit(),
    });
    const initMs = Date.now() - startedAt;
    if (timing) {
      console.log(`[graph timing] thread=${threadId} stream-init=${initMs}ms`);
    }
    // 每轮 LLM 单独累加：同一轮 chunk 共享 msg.id；msg.id 变化即轮次切换 → flush 上一轮。
    // 这样 ReAct 多轮里每轮独立 emit assistant_done + usage，runner 按轮写
    // session_messages，避免不同轮 reasoning 被合并到同一条 assistant。
    let currentId: string | null = null;
    // 本轮事件对外用的雪花 id（= resolveMessageId(currentId)）。currentId 仅用于
    // 判轮切换；所有 yield 的 messageId 用 currentSid，与 checkpointer 写入的 id 收口一致。
    let currentSid: string | null = null;
    // 本 run 见过的模型 UUID，run 结束时从 msgIdMap 清理，避免长进程累积。
    const seenModelIds = new Set<string>();
    let currentAcc: AIMessageChunk | undefined;
    let currentRoundStartedAt = startedAt;
    let firstChunkAt = 0;
    let firstReasoningAt = 0;
    let lastChunkAt = 0;
    let chunkCount = 0;
    let reasoningCount = 0;
    // 本轮是否已 yield reasoning_done —— 见首个非空 tool_calls 即 yield 一次，
    // 然后置 true 避免后续 chunk 重复发；轮切换/flush 时重置回 false。
    let reasoningDoneYielded = false;
    const flushRound = function* (this: GraphService): Generator<StreamChunk> {
      if (currentId === null || currentSid === null || currentAcc === undefined)
        return;
      const content =
        typeof currentAcc.content === "string" ? currentAcc.content : "";
      const reasoning =
        typeof currentAcc.additional_kwargs?.reasoning_content === "string"
          ? currentAcc.additional_kwargs.reasoning_content
          : "";
      const toolCalls = currentAcc.tool_calls ?? [];
      if (toolCalls.length > 0) {
        yield {
          kind: "tool_calls",
          messageId: currentSid,
          toolCalls,
        };
      }
      yield {
        kind: "assistant_done",
        messageId: currentSid,
        content,
        reasoning,
        toolCalls: toolCalls.length > 0 ? toolCalls : null,
      };
      const extracted = extractUsage(currentAcc);
      if (extracted) {
        yield {
          kind: "usage",
          messageId: currentSid,
          providerType: this.modelResolver.getMeta().providerType,
          model: this.modelResolver.getMeta().model,
          inputTokens: extracted.inputTokens,
          outputTokens: extracted.outputTokens,
          totalTokens: extracted.totalTokens,
          cacheReadTokens: extracted.cacheReadTokens,
          cacheCreationTokens: extracted.cacheCreationTokens,
          reasoningTokens: extracted.reasoningTokens,
          durationMs: Date.now() - currentRoundStartedAt,
        };
      } else {
        console.warn(
          `LLM provider ${this.modelResolver.getMeta().providerType} (${this.modelResolver.getMeta().model}) 未上报 usage（usage_metadata / response_metadata.usage / additional_kwargs.usage 均缺失）, thread=${threadId} msg=${currentId}`,
        );
      }
    }.bind(this);

    for await (const part of stream) {
      // 多 mode 流：每个 yield 是 [mode, payload]
      // mode === "messages" → payload = [BaseMessage, metadata]
      // mode === "updates" → payload = { nodeName: stateUpdate }
      if (!Array.isArray(part) || part.length !== 2) {
        console.warn(
          `[graph stream] unexpected yield shape, len=${Array.isArray(part) ? part.length : "n/a"}; type=${typeof part}`,
        );
        continue; // 防御：未知 yield 形状
      }
      const [mode, payload] = part as [string, unknown];

      if (mode === "updates") {
        // supervisor 节点 return → 立即 flush 这一轮 assistant，避免等到 tools
        // 跑完 ToolMessage 进 stream 才 flush（慢 tool 几十秒空窗，刷新页面看不到）。
        const updates = payload as Record<string, unknown> | null;
        if (updates && "supervisor" in updates) {
          if (currentId !== null && currentAcc !== undefined) {
            yield* flushRound();
            currentAcc = undefined;
            currentId = null;
            currentRoundStartedAt = Date.now();
            reasoningDoneYielded = false;
          }
        }
        continue;
      }

      if (mode !== "messages") continue;

      // messages 模式：payload = [BaseMessage, metadata]
      const messagePart = payload as unknown[];
      const msg = Array.isArray(messagePart) ? messagePart[0] : messagePart;
      if (!(msg instanceof AIMessageChunk)) {
        // 非 AIMessageChunk（ToolMessage 等）：上面 updates 路径已经把 supervisor 出口
        // flush 过了；这里保留为 backup 兜底，防 updates 事件意外缺失。
        if (currentId !== null && currentAcc !== undefined) {
          yield* flushRound();
          currentAcc = undefined;
          currentId = null;
          currentSid = null;
          currentRoundStartedAt = Date.now();
          reasoningDoneYielded = false;
        }
        continue;
      }
      const messageId = msg.id ?? randomUUID();
      // 轮次切换：flush 上一轮，重置累加（ToolMessage 路径已 flush 过、currentId=null；
      // 此分支兜底 supervisor 终答→END 不经 tools 直接连下一轮的罕见情况）
      if (currentId !== null && currentId !== messageId) {
        yield* flushRound();
        currentAcc = undefined;
        currentRoundStartedAt = Date.now();
        reasoningDoneYielded = false;
      }
      currentId = messageId;
      // 模型 UUID 解析为我方雪花：本轮所有事件 messageId 用 sid，与 supervisor 节点
      // 写入 checkpointer 的 id 同源（get-or-create 命中缓存）。
      seenModelIds.add(messageId);
      const sid = this.resolveMessageId(messageId);
      currentSid = sid;
      // 本轮首次见到非空 tool_calls：yield reasoning_done。比较 concat 前后的
      // 长度——若之前为 0、之后 > 0，说明这条 chunk 是 reasoning→tool_calls 的
      // 切换点。运行频率：每轮最多 1 次。
      const prevToolCallsLen = currentAcc?.tool_calls?.length ?? 0;
      currentAcc = currentAcc === undefined ? msg : currentAcc.concat(msg);
      const nextToolCallsLen = currentAcc.tool_calls?.length ?? 0;
      if (
        !reasoningDoneYielded &&
        prevToolCallsLen === 0 &&
        nextToolCallsLen > 0
      ) {
        reasoningDoneYielded = true;
        yield { kind: "reasoning_done", messageId: sid };
      }
      for (const d of extractToolCallArgDeltas(msg)) {
        yield {
          kind: "tool_call_args",
          messageId: sid,
          // 从累积器按 index 取稳定 toolCallId（与随后 tool_call_start 同源）。
          // currentAcc 此处刚 concat 过 msg，必然已含本 chunk 的 tool_call_chunks。
          toolCallId: resolveToolCallId(currentAcc, d.index),
          index: d.index,
          name: d.name,
          delta: d.delta,
        };
      }
      const reasoningDelta =
        typeof msg.additional_kwargs?.reasoning_content === "string"
          ? msg.additional_kwargs.reasoning_content
          : "";
      if (reasoningDelta) {
        if (firstReasoningAt === 0) {
          firstReasoningAt = Date.now();
          if (timing) {
            console.log(
              `[graph timing] thread=${threadId} first-reasoning=${firstReasoningAt - startedAt}ms`,
            );
          }
        }
        reasoningCount += 1;
        yield { kind: "reasoning", messageId: sid, delta: reasoningDelta };
      }
      const delta = typeof msg.content === "string" ? msg.content : "";
      if (!delta) continue;
      if (firstChunkAt === 0) {
        firstChunkAt = Date.now();
        if (timing) {
          console.log(
            `[graph timing] thread=${threadId} first-chunk=${firstChunkAt - startedAt}ms (TTFT after stream-init: ${firstChunkAt - startedAt - initMs}ms)`,
          );
        }
      }
      lastChunkAt = Date.now();
      chunkCount += 1;
      yield { kind: "chunk", messageId: sid, delta };
    }
    // 流结束：flush 最后一轮
    yield* flushRound();
    // 清理本 run 见过的模型 UUID 映射，避免长进程累积。
    for (const id of seenModelIds) this.msgIdMap.delete(id);
    const streamClosedAt = Date.now();
    if (timing) {
      const lastChunkOffset = lastChunkAt ? lastChunkAt - startedAt : -1;
      const closeAfterLastChunk = lastChunkAt
        ? streamClosedAt - lastChunkAt
        : -1;
      console.log(
        `[graph timing] thread=${threadId} reasoning=${reasoningCount} chunks=${chunkCount} last-chunk=${lastChunkOffset}ms stream-close=${streamClosedAt - startedAt}ms (after-last-chunk=${closeAfterLastChunk}ms)`,
      );
    }
  }

  /**
   * 取会话已处理消息历史（来自 checkpointer）。
   *
   * 过滤掉无可显示文本的消息（例如 tool_call-only 的 AIMessage、
   * 中断/失败留下的空 AIMessage），避免前端渲染空气泡。
   * 缺 id 的也跳过（不再用 randomUUID 兜底，因为每次刷新会变 → 前端按 id 去重失效）。
   */
  async getHistory(threadId: ThreadId): Promise<Message[]> {
    const snapshot = await this.accountGraph().graph.getState({
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

  private roleOf(m: BaseMessage): "user" | "assistant" | "system" {
    const t = m._getType();
    if (t === "human") return "user";
    if (t === "system") return "system";
    return "assistant";
  }
}

/** 从累计 AIMessageChunk 提取规范化 token 用量。 */
interface ExtractedUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
}

/**
 * 从累计 AIMessageChunk 兜底提取 token 用量。
 *
 * 取数优先级：
 * 1. `usage_metadata` —— LangChain 0.3 跨厂商标准字段（@langchain/openai 0.6+ 等）
 * 2. `response_metadata.usage` —— OpenAI 兼容路径原始字段（deepseek、第三方代理常用）
 * 3. `response_metadata.tokenUsage` —— LangChain 旧版 camelCase 字段
 * 4. `additional_kwargs.usage` —— 个别集成包的位置
 *
 * 全部缺失返回 null。
 */
function extractUsage(msg: AIMessageChunk | undefined): ExtractedUsage | null {
  if (!msg) return null;

  // 1) LangChain 标准 usage_metadata
  const meta = msg.usage_metadata;
  if (meta && (meta.input_tokens || meta.output_tokens || meta.total_tokens)) {
    return {
      inputTokens: meta.input_tokens ?? 0,
      outputTokens: meta.output_tokens ?? 0,
      totalTokens: meta.total_tokens ?? 0,
      cacheReadTokens: meta.input_token_details?.cache_read ?? 0,
      cacheCreationTokens: meta.input_token_details?.cache_creation ?? 0,
      reasoningTokens: meta.output_token_details?.reasoning ?? 0,
    };
  }

  const rawMsg = msg as unknown as {
    response_metadata?: Record<string, unknown>;
    additional_kwargs?: Record<string, unknown>;
  };

  // 2) response_metadata.usage —— OpenAI 兼容字段（snake_case）
  const respUsage = rawMsg.response_metadata?.usage as
    | {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
        completion_tokens_details?: { reasoning_tokens?: number };
        // deepseek 私有扩展
        prompt_cache_hit_tokens?: number;
      }
    | undefined;
  if (
    respUsage &&
    (respUsage.prompt_tokens ||
      respUsage.completion_tokens ||
      respUsage.total_tokens)
  ) {
    const inputTokens = respUsage.prompt_tokens ?? 0;
    const outputTokens = respUsage.completion_tokens ?? 0;
    return {
      inputTokens,
      outputTokens,
      totalTokens: respUsage.total_tokens ?? inputTokens + outputTokens,
      cacheReadTokens:
        respUsage.prompt_tokens_details?.cached_tokens ??
        respUsage.prompt_cache_hit_tokens ??
        0,
      cacheCreationTokens: 0,
      reasoningTokens:
        respUsage.completion_tokens_details?.reasoning_tokens ?? 0,
    };
  }

  // 3) response_metadata.tokenUsage —— LangChain 旧式 camelCase
  const tokenUsage = rawMsg.response_metadata?.tokenUsage as
    | {
        promptTokens?: number;
        completionTokens?: number;
        totalTokens?: number;
      }
    | undefined;
  if (tokenUsage && (tokenUsage.promptTokens || tokenUsage.completionTokens)) {
    const inputTokens = tokenUsage.promptTokens ?? 0;
    const outputTokens = tokenUsage.completionTokens ?? 0;
    return {
      inputTokens,
      outputTokens,
      totalTokens: tokenUsage.totalTokens ?? inputTokens + outputTokens,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
    };
  }

  // 4) additional_kwargs.usage
  const altUsage = rawMsg.additional_kwargs?.usage as
    | {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      }
    | undefined;
  if (altUsage && (altUsage.prompt_tokens || altUsage.completion_tokens)) {
    const inputTokens = altUsage.prompt_tokens ?? 0;
    const outputTokens = altUsage.completion_tokens ?? 0;
    return {
      inputTokens,
      outputTokens,
      totalTokens: altUsage.total_tokens ?? inputTokens + outputTokens,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
    };
  }

  return null;
}

/**
 * 从环境变量解析 LangGraph recursion 上限。默认 100（够应付绝大多数 ReAct
 * 长链 + 多 tool 串调）。非法值（NaN / <=0）回落默认值。
 *
 * 一次 supervisor↔tools 往返算 2 个 super-step；25 默认上限只能撑 ~12 轮
 * tool 调用，长会话很容易撞 GraphRecursionError。
 */
function resolveRecursionLimit(): number {
  const raw = process.env.MESHBOT_GRAPH_RECURSION_LIMIT;
  if (!raw) return 100;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 100;
  return n;
}
