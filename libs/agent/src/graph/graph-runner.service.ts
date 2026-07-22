import { randomUUID } from "node:crypto";
import type {
  AIMessageChunk,
  BaseMessage,
  BaseMessageChunk,
} from "@langchain/core/messages";
import {
  HumanMessage,
  isAIMessageChunk,
  RemoveMessage,
} from "@langchain/core/messages";
import { Injectable } from "@nestjs/common";
import { AccountGraphProvider } from "./account-graph.provider";
import { ContextBuilder } from "./context-builder";
import { ModelResolver } from "./model-resolver.service";
import { extractUsage } from "./usage";
import { ThreadStateService } from "./thread-state.service";
import type { AgentConfig, StreamChunk, ThreadId } from "./graph.types";

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

/**
 * 流核心：封装 startSession / streamMessage / resumeStream / runGraphStream。
 * GraphService 通过注入此 singleton 委派所有流式操作。
 */
@Injectable()
export class GraphRunner {
  constructor(
    private readonly accountGraphProvider: AccountGraphProvider,
    private readonly modelResolver: ModelResolver,
    private readonly contextBuilder: ContextBuilder,
    private readonly threadState: ThreadStateService,
  ) {}

  /**
   * 创建会话，返回 thread id。
   *
   * 仅生成 UUID；人格 / 上下文消息在每次 streamMessage 时按需前置，
   * 不在此处写入 checkpointer（checkpointer.put 直写 API 易出错）。
   * config 当前完全未使用（含 systemPrompt —— 人格统一由 ContextBuilder.buildPersonaMessage
   * 从当前 Agent 的 systemPrompt 组装，每轮刷新）；保留入参便于后续接入 temperature / model。
   */
  async startSession(_config: AgentConfig): Promise<ThreadId> {
    const threadId = randomUUID();
    return threadId;
  }

  /**
   * 按 opts.subAgent 标志选取图：子会话用子图，普通会话用主图。
   */
  private pickGraph(opts?: { subAgent?: boolean }) {
    return opts?.subAgent
      ? this.accountGraphProvider.subAgentGraph().graph
      : this.accountGraphProvider.accountGraph().graph;
  }

  /**
   * 向会话发送一批消息并逐 token 流式产出 assistant 回复。
   *
   * 每条入参构造一条带显式 id 的 HumanMessage（id = 调用方的 PendingMessage.id），
   * 让 checkpointer 里的 user 消息与 pending 表可对齐去重。
   * system:persona / system:ctx / system:skills 均以稳定 id **每轮**刷新推送，
   * reducer 按 id 原地替换、不累积（详见 graph.builder.ts 的 mergeMessages）。
   * 透传 signal 支持中断。
   *
   * @param inputs 至少一条 —— 调用方保证非空批次。
   * @param opts.subAgent 为 true 时用子图（排除 dispatch 工具）。
   */
  async *streamMessage(
    threadId: ThreadId,
    inputs: { id: string; content: string }[],
    signal?: AbortSignal,
    opts?: { subAgent?: boolean },
  ): AsyncGenerator<StreamChunk> {
    yield* this.streamMessageImpl(threadId, inputs, signal, opts);
  }

  private async *streamMessageImpl(
    threadId: ThreadId,
    inputs: { id: string; content: string }[],
    signal?: AbortSignal,
    opts?: { subAgent?: boolean },
  ): AsyncGenerator<StreamChunk> {
    await this.threadState.sanitizeOrphanToolCalls(threadId);
    const inputMessages: BaseMessage[] = [];
    // system:persona / system:ctx / system:skills 全部用稳定 id 每轮重发；
    // reducer 按 id 原地更新（位置不变、不累积），无需先 RemoveMessage 再 Add。
    // 人格必须每轮刷新：Agent 的 systemPrompt 随时可改，首轮写死会让老会话
    // 永远带旧人格（静默错误）。
    inputMessages.push(await this.contextBuilder.buildPersonaMessage());
    inputMessages.push(await this.contextBuilder.buildContextMessage(threadId));
    if (this.contextBuilder.hasSkills()) {
      inputMessages.push(this.contextBuilder.buildSkillsMessage());
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
    yield* this.runGraphStream(
      threadId,
      { messages: inputMessages },
      signal,
      opts,
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
   *
   * @param opts.subAgent 为 true 时用子图（与 streamMessage 保持一致）。
   */
  async *resumeStream(
    threadId: ThreadId,
    signal?: AbortSignal,
    opts?: { subAgent?: boolean },
  ): AsyncGenerator<StreamChunk> {
    await this.threadState.sanitizeOrphanToolCalls(threadId);
    yield* this.runGraphStream(
      threadId,
      {
        messages: [
          new RemoveMessage({ id: "system:persona" }),
          await this.contextBuilder.buildPersonaMessage(),
          new RemoveMessage({ id: "system:ctx" }),
          await this.contextBuilder.buildContextMessage(threadId),
        ],
      },
      signal,
      opts,
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
    opts?: { subAgent?: boolean },
  ): AsyncGenerator<StreamChunk> {
    const timing = process.env.MESHBOT_GRAPH_TIMING !== "0";
    const startedAt = Date.now();
    const stream = await this.pickGraph(opts).stream(input, {
      configurable: { thread_id: threadId },
      // 显式给 metadata 盖上本次 run 的 thread_id 章：LangGraph 的
      // ensureLangGraphConfig 只在 metadata 缺 thread_id 时才从 configurable 回填。
      // dispatch_subagent 的子图在父图 tools 节点的 ALS 上下文内调用，不显式传时
      // 会原样继承父的 metadata（含父 thread_id），导致下方读侧过滤无从判别；
      // 且独立子 run 本就不应继承父的 metadata。父子都走本调用点，各自盖各自的章。
      metadata: { thread_id: threadId },
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
    // msgIdMap（resolveMessageId / deleteMsgIds）全局共享，不随图切换。
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
    const flushRound = function* (this: GraphRunner): Generator<StreamChunk> {
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
      // 空轮短路：正文 / reasoning / tool_calls 三者皆空的一轮不发 assistant_done。
      //
      // 上面 updates 分支在 supervisor 节点出口就提前 flush 了真正的一轮并把
      // currentAcc/currentId 清空（**但不清 currentSid**）；langgraph 随后仍会吐
      // 一条只带 finish_reason/usage 的尾随 AIMessageChunk，它被当成「新一轮」
      // 重新累积，于是流结束时的收尾 flush 又发一次 content=""、toolCalls=null 的
      // assistant_done。RunnerService 照单 `recordAssistant()` 落库——messageId
      // 还是同一个雪花（sid 未变），既在前端渲染成「头像+名字+空」的空消息行，
      // 又有把这条消息的真实正文覆盖成空串的风险。
      //
      // 只挡 assistant_done，不挡下面的 usage：usage_metadata 恰恰就挂在这条
      // 尾随 chunk 上，挡掉会丢整轮的 token 计量。usage 的 messageId 用同一个
      // sid，指向前一次 flush 已经落库的那条 assistant，归属仍然正确。
      //
      // checkpointer 不变量不受影响：本函数只产出对外事件流，消息序列由
      // supervisor 节点写入 state，与这里 yield 与否无关；空轮既无 tool_calls
      // 也就不存在 tool_call/tool_result 配对被打断的问题。
      if (content !== "" || reasoning !== "" || toolCalls.length > 0) {
        yield {
          kind: "assistant_done",
          messageId: currentSid,
          content,
          reasoning,
          toolCalls: toolCalls.length > 0 ? toolCalls : null,
        };
      }
      const extracted = extractUsage(currentAcc);
      if (extracted) {
        yield {
          kind: "usage",
          messageId: currentSid,
          providerType: this.modelResolver.getMeta().providerType,
          model: this.modelResolver.getMeta().model,
          modelName: this.modelResolver.getMeta().modelName,
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
      // 断言为 BaseMessageChunk 仅为满足 isAIMessageChunk 的参数签名；
      // 真实窄化由下方 isAIMessageChunk 的结构判定完成，非 chunk 会被兜底分支处理。
      const msg = (
        Array.isArray(messagePart) ? messagePart[0] : messagePart
      ) as BaseMessageChunk;
      // 按 metadata.thread_id 过滤外来事件：dispatch_subagent 的子图在父图 tools
      // 节点内部调用，streamMode:"messages" 经 callback 树采集 LLM token，子图的
      // 事件会冒泡进父图的 stream（父消费侧看到子的轮次 → UI 泄漏、llm_calls 双记）。
      // 上方写侧已显式盖章 metadata.thread_id = 本次 threadId：凡带 thread_id 且
      // 不等于本次 threadId 的事件一律丢弃——必须放在 AIMessageChunk 累加与下面的
      // 非 AIMessageChunk backup-flush 之前（外来 ToolMessage 也不得触发 flushRound）。
      // thread_id 缺失时 fail-open 保留，避免误杀本图自身不带该字段的事件。
      const meta = (Array.isArray(messagePart) ? messagePart[1] : undefined) as
        | { thread_id?: unknown }
        | undefined;
      if (typeof meta?.thread_id === "string" && meta.thread_id !== threadId) {
        continue;
      }
      // 结构判定而非 instanceof：core 1.x 双构建（ESM/CJS）下，langgraph（ESM）
      // 重建的 AIMessageChunk 与本包（CJS）require 的类不同源，instanceof 恒 false，
      // 会把全部流式 chunk 静默丢弃（chunks=0、零输出「正常」结束）。
      //
      // 同时必须验 concat（chunk 独有方法）：langgraph 1.x 在节点完成时会把写进
      // state 的**完整 AIMessage**（id 已被 supervisor 替换成雪花）也从 messages
      // 通道 yield 一次，而 isAIMessageChunk 的结构判定连 AIMessage 也放行
      // （两者 type 都是 "ai"）。不挡住它会被当成"新一轮"：先触发轮切换 flush、
      // 再把整条消息二次累积并以新雪花 id 重复 flush → assistant 双写落库。
      // 让它走下面的非 chunk 兜底分支（flush 当前轮后忽略），与 0.x instanceof
      // 时代的行为一致。
      const isStreamChunk =
        isAIMessageChunk(msg) &&
        typeof (msg as { concat?: unknown }).concat === "function";
      if (!isStreamChunk) {
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
      const sid = this.accountGraphProvider.resolveMessageId(messageId);
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
    this.accountGraphProvider.deleteMsgIds(seenModelIds);
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
}
