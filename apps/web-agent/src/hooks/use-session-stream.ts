"use client";

import {
  type RunChunkEvent,
  type RunDoneEvent,
  type RunErrorEvent,
  type RunHumanEvent,
  type RunInterruptedEvent,
  type RunReasoningChunkEvent,
  type RunReasoningDoneEvent,
  type RunSnapshotEvent,
  type RunToolCallArgsDeltaEvent,
  type RunToolCallEndEvent,
  type RunToolCallProgressEvent,
  type RunToolCallStartEvent,
  type RunUsageEvent,
  SESSION_WS_EVENTS,
  type SessionTitleUpdatedEvent,
} from "@meshbot/types-agent";
import { clientSnowflakeId } from "@meshbot/web-common";
import { useSetAtom } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  appendUsageAtom,
  appendUsageByMessageAtom,
  resetUsageAtom,
  setInitialUsageAtom,
} from "@/atoms/session-usage";
import { updateSessionTitleAtom } from "@/atoms/sessions";
import type { TimelineMessage } from "@/components/session/message-list";
import { getSessionSocket } from "@/lib/socket";
import { appendMessage, fetchHistory, fetchPending } from "@/rest/session";

export interface SessionStream {
  /** 全部消息（含 pending 队列）。 */
  messages: TimelineMessage[];
  /** 是否有 run 在跑。 */
  running: boolean;
  /** 压缩进行中：null=未压缩；reason 字符串=压缩中。 */
  compacting: null | "threshold" | "ctx-exceeded";
  /** 还有更早历史可上拉。 */
  hasMoreHistory: boolean;
  /** 首屏历史加载中（用于显示骨架）。 */
  historyLoading: boolean;
  /** 单一消息写入口（同步 ref+state），供视图做局部变更（pending 删/改、重生成截断）。 */
  apply: (next: (prev: TimelineMessage[]) => TimelineMessage[]) => void;
  /** 发送一条消息：乐观插 pending user 气泡 + append 到后端。 */
  send: (msg: string) => Promise<void>;
  /** 中断当前 run。 */
  interrupt: () => void;
  /** 上拉加载更早历史（含滚动锚定，需传 scrollContainerRef）。 */
  loadMoreHistory: () => Promise<void>;
}

/**
 * 会话流式状态 hook：拉历史 + 订阅 SESSION_WS 事件 → 维护 TimelineMessage 列表、
 * running、compaction、历史分页，并暴露 send/interrupt/loadMoreHistory 与 apply。
 * sessionId 为 null 时惰性 inert（不请求不订阅），可安全挂载。
 */
export function useSessionStream(
  sessionId: string | null,
  scrollContainerRef: React.RefObject<HTMLDivElement | null>,
): SessionStream {
  const [messages, setMessages] = useState<TimelineMessage[]>([]);
  const [running, setRunning] = useState(false);
  const messagesRef = useRef<TimelineMessage[]>([]);
  const oldestMessageIdRef = useRef<string | null>(null);
  const hasMoreHistoryRef = useRef(true);
  const loadingMoreRef = useRef(false);
  const [hasMoreHistory, setHasMoreHistory] = useState(true);
  const [historyLoading, setHistoryLoading] = useState(false);
  /** 压缩进行中标记。null = 未压缩；string = 压缩原因（用于 banner 文案）。 */
  const [compacting, setCompacting] = useState<
    null | "threshold" | "ctx-exceeded"
  >(null);

  const setInitialUsage = useSetAtom(setInitialUsageAtom);
  const appendUsage = useSetAtom(appendUsageAtom);
  const appendUsageByMessage = useSetAtom(appendUsageByMessageAtom);
  const resetUsage = useSetAtom(resetUsageAtom);
  const updateSessionTitle = useSetAtom(updateSessionTitleAtom);

  /** 单一写入口：同步更新 ref 与 state。 */
  const apply = useCallback(
    (next: (prev: TimelineMessage[]) => TimelineMessage[]) => {
      messagesRef.current = next(messagesRef.current);
      setMessages(messagesRef.current);
    },
    [],
  );

  /**
   * onHuman 触发：把指定 user 消息从当前位置抽出、追加到数组末尾，清 pending
   * 标记（→ 离开 pending 区，进入聊天列表），并保证末尾存在 loading 占位 assistant 气泡。
   *
   * 用户手动发送时 messageId 由前端生成、append 同步用同一 id，run.human 到达时能 find 到。
   * 服务端注入的消息（如定时任务触发）前端没有乐观气泡，idx===-1，按事件携带的 content 新建。
   */
  const migrateHumanToTimeline = useCallback(
    (messageId: string, content: string): void => {
      apply((prev) => {
        const idx = prev.findIndex((m) => m.id === messageId);
        if (idx === -1) {
          const withoutLoading = prev.filter((m) => !m.loading);
          return [
            ...withoutLoading,
            { id: messageId, role: "user" as const, content },
            {
              id: `loading-${messageId}`,
              role: "assistant" as const,
              content: "",
              loading: true,
            },
          ];
        }
        // 同 batch 多条 user 时（onHuman 连发多次），第一次会 append loading，
        // 后续每次必须把 loading 重新抽出再附到末尾，否则后到的 user 会被插在
        // loading 上面，loading 卡在用户消息中间。
        const target = { ...prev[idx], pending: false };
        const withoutTarget = [...prev.slice(0, idx), ...prev.slice(idx + 1)];
        const existingLoading = withoutTarget.find((m) => m.loading);
        const withoutLoading = withoutTarget.filter((m) => !m.loading);
        const loading = existingLoading ?? {
          id: `loading-${messageId}`,
          role: "assistant" as const,
          content: "",
          loading: true,
        };
        return [...withoutLoading, target, loading];
      });
    },
    [apply],
  );

  /** 按 messageId 累加流式 delta；不存在则新建 assistant 气泡。 */
  const upsertChunk = useCallback(
    (messageId: string, delta: string, streaming: boolean) => {
      apply((prev) => {
        const idx = prev.findIndex((m) => m.id === messageId);
        if (idx === -1) {
          return [
            ...prev,
            { id: messageId, role: "assistant", content: delta, streaming },
          ];
        }
        const copy = [...prev];
        const existing = copy[idx];
        copy[idx] = {
          ...existing,
          content: streaming ? existing.content + delta : delta,
          streaming,
        };
        return copy;
      });
    },
    [apply],
  );

  useEffect(() => {
    if (!sessionId) return;
    // 切换 session：清空上一轮 timeline + inflight 状态 + usage 累计。否则
    // 后面的「合并历史 + socketArrived」逻辑会把旧 session 的消息当成「socket 已先到」
    // 保留下来，两段对话就混在一起。
    messagesRef.current = [];
    setMessages([]);
    setRunning(false);
    oldestMessageIdRef.current = null;
    hasMoreHistoryRef.current = true;
    setHasMoreHistory(true);
    resetUsage();
    let cancelled = false;
    setHistoryLoading(true);

    void Promise.all([fetchHistory(sessionId), fetchPending(sessionId)])
      .then(([history, pending]) => {
        if (cancelled) return;
        const initial: TimelineMessage[] = history.messages.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          // 持久化的 reasoning 直接带入；设了 durationMs=0 让 UI 显示「已思考」
          // 不显示动态秒数（实际生成时长信息没存）。reasoningStartedAt 不设。
          ...(m.reasoning
            ? { reasoning: m.reasoning, reasoningDurationMs: 0 }
            : {}),
          // 持久化的 tool calls：转 ToolCallView；progress 留空（流式过程没存）
          ...(m.toolCalls && m.toolCalls.length > 0
            ? {
                toolCalls: m.toolCalls.map((tc) => ({
                  toolCallId: tc.toolCallId,
                  name: tc.name,
                  args: tc.args,
                  status: tc.status,
                  result: tc.result,
                })),
              }
            : {}),
          feedback: m.feedback ?? null,
        }));
        const historyIds = new Set(history.messages.map((m) => m.id));
        if (history.inflight) {
          setRunning(history.inflight.status === "streaming");
          // 只在真正 streaming 时推 inflight 气泡；done/interrupted 状态下
          // checkpointer 已持久化对应消息，再推一条会形成「双气泡」（一个完整、
          // 一个空带闪烁光标）。
          if (
            history.inflight.messageId &&
            history.inflight.status === "streaming" &&
            !historyIds.has(history.inflight.messageId)
          ) {
            // reasoning 也带上：避免「正文流中切回会话」时思考过程丢失。
            // durationMs=0 让 UI 直接显示「已思考」（流式秒数信息没存）；
            // 后续 ws 订阅 replay 的 reasoning chunk 会按 messageId 累加到此条上。
            initial.push({
              id: history.inflight.messageId,
              role: "assistant",
              content: history.inflight.content,
              streaming: true,
              ...(history.inflight.reasoning
                ? {
                    reasoning: history.inflight.reasoning,
                    // 服务端记录的真实 reasoning 起始时刻；缺失时不设 startedAt
                    // （ReasoningBlock 走 streaming + 无 startedAt 的 fallback「思考中 0.0s」分支）
                    ...(history.inflight.reasoningStartedAt !== null &&
                    history.inflight.reasoningStartedAt !== undefined
                      ? {
                          reasoningStartedAt:
                            history.inflight.reasoningStartedAt,
                        }
                      : {}),
                  }
                : {}),
            });
          }
        }
        for (const p of pending.pending) {
          if (p.status === "processed") {
            continue;
          }
          if (historyIds.has(p.id)) {
            if (p.status === "failed") {
              const idx = initial.findIndex((m) => m.id === p.id);
              if (idx !== -1) {
                initial[idx] = { ...initial[idx], failed: true };
              }
            }
            continue;
          }
          if (p.status === "pending") {
            // 排队中（runner 还没认领、从未入库）→ 输入框上方 pending 区
            initial.push({
              id: p.id,
              role: "user",
              content: p.content,
              pending: true,
            });
            continue;
          }
          // processing / failed 且不在首页历史 id 集合里：
          // - inHistory=true → 已落入 session_messages（只是在更早的历史页）。
          //   跳过，由历史在正确 seq 位置展示——否则会被追加到时间线末尾，造成
          //   "失败/旧消息堆在最后面"（首页 historyIds 不含分页深处的 id）。
          // - inHistory=false → 孤儿（如 run.human 记录前就失败）。它是最新的，
          //   历史里没有，追加到末尾才看得到 + 可重试。
          if (!p.inHistory) {
            initial.push({
              id: p.id,
              role: "user",
              content: p.content,
              failed: p.status === "failed",
            });
          }
        }
        // 合并：历史快照打底，但保留 socket 已先到的消息（不被覆盖）
        apply((current) => {
          const initialIds = new Set(initial.map((m) => m.id));
          const socketArrived = current.filter((m) => !initialIds.has(m.id));
          return [...initial, ...socketArrived];
        });
        if (history.sessionTotals) {
          setInitialUsage({
            sessionTotals: history.sessionTotals,
            byMessage: history.byMessage,
          });
        } else {
          // 防御：首次必有 sessionTotals
          appendUsageByMessage(history.byMessage);
        }
        oldestMessageIdRef.current = initial[0]?.id ?? null;
        hasMoreHistoryRef.current = history.hasMore;
        setHasMoreHistory(history.hasMore);
      })
      .finally(() => {
        if (!cancelled) setHistoryLoading(false);
      });

    const socket = getSessionSocket();
    const subscribe = () =>
      socket.emit(SESSION_WS_EVENTS.subscribe, { sessionId });

    const onHuman = (e: RunHumanEvent) => {
      if (e.sessionId !== sessionId) return;
      migrateHumanToTimeline(e.messageId, e.content);
    };
    const onReasoning = (e: RunReasoningChunkEvent) => {
      if (e.sessionId !== sessionId) return;
      setRunning(true);
      apply((prev) => {
        // 首个 reasoning 到达：清掉 loading 占位。任何时候至多有 1 个 loading
        // （migrateHumanToTimeline 用 `if (next.some(m => m.loading)) return next`
        // 保证），全清安全；不动 user 的 pending 标记（那个只由 run.human 清）。
        const withoutLoading = prev.filter((m) => !m.loading);
        const idx = withoutLoading.findIndex((m) => m.id === e.messageId);
        // 不存在则创建 assistant 占位：reasoningStartedAt 设为现在，
        // content 为空（等 onChunk 到达时填）
        if (idx === -1) {
          return [
            ...withoutLoading,
            {
              id: e.messageId,
              role: "assistant" as const,
              content: "",
              reasoning: e.delta,
              reasoningStartedAt: Date.now(),
            },
          ];
        }
        const copy = [...withoutLoading];
        const existing = copy[idx];
        copy[idx] = {
          ...existing,
          reasoning: (existing.reasoning ?? "") + e.delta,
          // existing.reasoningStartedAt 来自 inflight 透传（刷新场景）
          // 或来自 idx===-1 分支首次创建（fresh 流式场景，已设 Date.now()）
          // 两种情况都已正确赋值，不再用「?? Date.now()」覆盖
          reasoningStartedAt: existing.reasoningStartedAt,
        };
        return copy;
      });
    };
    /**
     * LLM 本轮 reasoning_content 结束、转入 tool_calls token 流时由 graph 检测后
     * emit 出来。前端据此锁 reasoningDurationMs，让「思考中 Xs」尽早切到「已思考 Xs」，
     * 避免把后续几秒的 tool_calls token 流时间也算进思考时长（对长 tool_call args
     * 尤其明显——一个长 curl + python 脚本可能要流好几秒）。
     *
     * content-having 轮（无 tool_calls）：reasoning_done 不会触发；
     * onChunk 收到首个 content 字时已经锁过 duration，行为不变。
     */
    const onReasoningDone = (e: RunReasoningDoneEvent) => {
      if (e.sessionId !== sessionId) return;
      apply((prev) =>
        prev.map((m) => {
          if (m.id !== e.messageId) return m;
          if (
            m.reasoningStartedAt === undefined ||
            m.reasoningDurationMs !== undefined
          ) {
            return m; // 没记 startedAt 或已锁过，跳过
          }
          return {
            ...m,
            reasoningDurationMs: Date.now() - m.reasoningStartedAt,
          };
        }),
      );
    };
    const onChunk = (e: RunChunkEvent) => {
      if (e.sessionId !== sessionId) return;
      setRunning(true);
      apply((prev) => {
        // 首个 chunk 到达：
        // 1) 清掉 loading 占位（任何时候至多 1 个，全清安全）
        // 2) 该消息若有进行中的 reasoning（startedAt 已设、durationMs 未设），
        //    在第一次 chunk 到达时锁定 reasoningDurationMs
        //
        // pending user 标记的清理交给 run.human 事件（服务端真相），不在这里顺手做。
        const withoutLoading = prev.filter((m) => !m.loading);
        return withoutLoading.map((m) => {
          if (m.id === e.messageId) {
            const next = m.failed ? { ...m, failed: false } : m;
            if (
              next.reasoningStartedAt !== undefined &&
              next.reasoningDurationMs === undefined
            ) {
              return {
                ...next,
                reasoningDurationMs: Date.now() - next.reasoningStartedAt,
              };
            }
            return next;
          }
          return m;
        });
      });
      upsertChunk(e.messageId, e.delta, true);
    };
    /**
     * subscribe 回放：按 messageId **SET**（覆盖，非累加）本轮全量 reasoning/content，
     * 与 HTTP inflight push 互为幂等，根治回放叠加 / 断线重连的文本翻倍。
     * 缺失则按快照建气泡；后续真正的增量仍走 onReasoning / onChunk（append）。
     */
    const onSnapshot = (e: RunSnapshotEvent) => {
      if (e.sessionId !== sessionId) return;
      setRunning(true);
      apply((prev) => {
        const withoutLoading = prev.filter((m) => !m.loading);
        const idx = withoutLoading.findIndex((m) => m.id === e.messageId);
        if (idx === -1) {
          return [
            ...withoutLoading,
            {
              id: e.messageId,
              role: "assistant" as const,
              content: e.content,
              streaming: true,
              ...(e.reasoning ? { reasoning: e.reasoning } : {}),
              ...(e.reasoningStartedAt !== null
                ? { reasoningStartedAt: e.reasoningStartedAt }
                : {}),
            },
          ];
        }
        const copy = [...withoutLoading];
        const existing = copy[idx];
        copy[idx] = {
          ...existing,
          content: e.content, // SET 覆盖，不累加
          streaming: true,
          // reasoning 仅在快照非空时覆盖，避免空快照抹掉已有 reasoning
          reasoning: e.reasoning || existing.reasoning,
          reasoningStartedAt:
            e.reasoningStartedAt ?? existing.reasoningStartedAt,
        };
        return copy;
      });
    };
    const onDone = (e: RunDoneEvent) => {
      if (e.sessionId !== sessionId) return;
      setRunning(false);
      apply((prev) =>
        prev.map((m) =>
          m.id === e.messageId
            ? { ...m, content: e.content, streaming: false }
            : m,
        ),
      );
    };
    const onInterrupted = (e: RunInterruptedEvent) => {
      if (e.sessionId !== sessionId) return;
      setRunning(false);
      apply((prev) =>
        prev.map((m) =>
          m.id === e.messageId ? { ...m, streaming: false } : m,
        ),
      );
    };
    const onError = (e: RunErrorEvent) => {
      if (e.sessionId !== sessionId) return;
      setRunning(false);
      // 不再追加错误气泡：把对应气泡标记 failed，由其上挂载重试按钮
      // pendingIds 覆盖「流前出错」场景（messageId 为 null 时仍能标记用户气泡）
      const failedIds = new Set<string>(e.pendingIds);
      if (e.messageId) {
        failedIds.add(e.messageId);
      }
      // 清掉失败那条 user 对应的 loading 占位（id 形如 loading-<messageId>）；
      // 其它 run 的 loading 不动。
      const loadingIdsToDrop = new Set<string>();
      for (const id of failedIds) loadingIdsToDrop.add(`loading-${id}`);
      apply((prev) =>
        prev
          .filter((m) => !loadingIdsToDrop.has(m.id))
          .map((m) =>
            failedIds.has(m.id)
              ? { ...m, failed: true, pending: false, streaming: false }
              : m,
          ),
      );
    };
    const onUsage = (e: RunUsageEvent) => {
      if (e.sessionId !== sessionId) return;
      appendUsage(e);
    };
    // 标题事件全局广播（不限当前 session）：按事件 sessionId patch 列表 + 标题栏
    //（两处都读 sessionsAtom）。后台 LLM 生成标题完成后实时刷新。
    const onTitleUpdated = (e: SessionTitleUpdatedEvent) => {
      updateSessionTitle({ id: e.sessionId, title: e.title });
    };
    const onToolArgsDelta = (e: RunToolCallArgsDeltaEvent) => {
      if (e.sessionId !== sessionId) return;
      // 按 toolCallId 把 args 增量合并到「同一个工具块」（像 chunk 按 messageId
      // 合并到消息）：流式 args → running → 完成 是同一个块的状态推进，不再先建
      // 独立预览块再整批清空。个别 provider 流里不带 id → 跳过预览，等 onToolStart。
      const toolCallId = e.toolCallId;
      if (!toolCallId) return;
      apply((prev) => {
        const merge = (m: TimelineMessage): TimelineMessage => {
          const list = m.toolCalls ? [...m.toolCalls] : [];
          const i = list.findIndex((t) => t.toolCallId === toolCallId);
          if (i === -1) {
            list.push({
              toolCallId,
              name: e.name ?? "",
              status: "streaming",
              argsText: e.delta,
            });
          } else {
            list[i] = {
              ...list[i],
              name: e.name ?? list[i].name,
              argsText: (list[i].argsText ?? "") + e.delta,
            };
          }
          return { ...m, toolCalls: list };
        };
        const idx = prev.findIndex((m) => m.id === e.messageId);
        // 中间决策轮可能无 content/reasoning：不存在则建一个无正文的 assistant 壳，
        // 不设 streaming（避免空正文闪烁光标），由 toolCalls 块自身呈现进行态。
        if (idx === -1) {
          return [
            ...prev,
            merge({ id: e.messageId, role: "assistant", content: "" }),
          ];
        }
        const copy = [...prev];
        copy[idx] = merge(copy[idx]);
        return copy;
      });
    };
    const onToolStart = (e: RunToolCallStartEvent) => {
      if (e.sessionId !== sessionId) return;
      apply((prev) =>
        prev.map((m) => {
          if (m.id !== e.messageId) return m;
          // tool_call 开始 = 本轮 LLM 文本已收尾。
          // 1) 锁住 reasoningDurationMs，否则「思考中 Xs」会一直跳到本轮 LLM 结束才能切回「已思考」。
          // 2) 清 streaming 标记，否则中间决策轮（content 已停 + tool_call 进行中）
          //    气泡尾部的闪烁光标永不熄灭 —— runDone 要等整轮跑完才发。
          const lockDuration =
            m.reasoningStartedAt !== undefined &&
            m.reasoningDurationMs === undefined
              ? { reasoningDurationMs: Date.now() - m.reasoningStartedAt }
              : {};
          // 合并到流式阶段已建的同一块（按 toolCallId 命中）：升级 running、填权威
          // args、清流式文本。命不中（无流式预览 / 重复 start）则新建/覆盖。
          // 按 toolCallId 命中 = 幂等：重复 start 不会再 push 出重复块。
          const list = m.toolCalls ? [...m.toolCalls] : [];
          const i = list.findIndex((t) => t.toolCallId === e.toolCallId);
          const next = {
            toolCallId: e.toolCallId,
            name: e.name,
            args: e.args,
            status: "running" as const,
            argsText: undefined,
          };
          if (i === -1) {
            list.push(next);
          } else {
            list[i] = { ...list[i], ...next };
          }
          return {
            ...m,
            ...lockDuration,
            streaming: false,
            toolCalls: list,
          };
        }),
      );
    };
    const onToolProgress = (e: RunToolCallProgressEvent) => {
      if (e.sessionId !== sessionId) return;
      apply((prev) =>
        prev.map((m) =>
          m.toolCalls?.some((t) => t.toolCallId === e.toolCallId)
            ? {
                ...m,
                toolCalls: m.toolCalls.map((t) =>
                  t.toolCallId === e.toolCallId
                    ? { ...t, progress: (t.progress ?? "") + e.delta }
                    : t,
                ),
              }
            : m,
        ),
      );
    };
    const onToolEnd = (
      // gateway 已剥 content；前端只用 resultPreview
      e: Omit<RunToolCallEndEvent, "content">,
    ) => {
      if (e.sessionId !== sessionId) return;
      apply((prev) =>
        prev.map((m) =>
          m.toolCalls?.some((t) => t.toolCallId === e.toolCallId)
            ? {
                ...m,
                toolCalls: m.toolCalls.map((t) =>
                  t.toolCallId === e.toolCallId
                    ? {
                        ...t,
                        status: e.ok ? ("ok" as const) : ("error" as const),
                        result: e.resultPreview,
                      }
                    : t,
                ),
              }
            : m,
        ),
      );
    };

    socket.on("connect", subscribe);
    if (socket.connected) subscribe();
    socket.on(SESSION_WS_EVENTS.runHuman, onHuman);
    socket.on(SESSION_WS_EVENTS.runReasoning, onReasoning);
    socket.on(SESSION_WS_EVENTS.runReasoningDone, onReasoningDone);
    socket.on(SESSION_WS_EVENTS.runChunk, onChunk);
    socket.on(SESSION_WS_EVENTS.runSnapshot, onSnapshot);
    socket.on(SESSION_WS_EVENTS.runDone, onDone);
    socket.on(SESSION_WS_EVENTS.runInterrupted, onInterrupted);
    socket.on(SESSION_WS_EVENTS.runError, onError);
    socket.on(SESSION_WS_EVENTS.runUsage, onUsage);
    socket.on(SESSION_WS_EVENTS.titleUpdated, onTitleUpdated);
    socket.on(SESSION_WS_EVENTS.runToolCallArgsDelta, onToolArgsDelta);
    socket.on(SESSION_WS_EVENTS.runToolCallStart, onToolStart);
    socket.on(SESSION_WS_EVENTS.runToolCallProgress, onToolProgress);
    socket.on(SESSION_WS_EVENTS.runToolCallEnd, onToolEnd);

    // === Compaction 三事件 —— banner 状态 + 完成后触发 history 重新拉取 ===
    const onCompactionStart = (payload: {
      sessionId: string;
      reason: "threshold" | "ctx-exceeded";
    }) => {
      if (payload.sessionId !== sessionId) return;
      setCompacting(payload.reason);
    };
    const onCompactionDone = (payload: { sessionId: string }) => {
      if (payload.sessionId !== sessionId) return;
      setCompacting(null);
      // 注：history 不是 react-query 管理，没法直接 invalidate。新插入的
      // compaction 占位行要等用户下次进入 session 或滚动加载时才出现。
      // v1 接受；v2 可加 fetchHistory 然后 merge 进 messages atom。
    };
    const onCompactionError = (payload: {
      sessionId: string;
      error: string;
    }) => {
      if (payload.sessionId !== sessionId) return;
      setCompacting(null);
      // 暂无统一 toast 库；用 console.warn 占位，banner 自然撤掉即可
      console.warn(`[compaction] error: ${payload.error}`);
    };
    socket.on(SESSION_WS_EVENTS.runCompactionStart, onCompactionStart);
    socket.on(SESSION_WS_EVENTS.runCompactionDone, onCompactionDone);
    socket.on(SESSION_WS_EVENTS.runCompactionError, onCompactionError);

    return () => {
      cancelled = true;
      // 离开旧 session：通知 gateway leave 房间，否则切换多个 session 后
      // socket 同时订阅一堆 room，每个 session 跑起来都推送过来浪费带宽。
      socket.emit(SESSION_WS_EVENTS.unsubscribe, { sessionId });
      socket.off("connect", subscribe);
      socket.off(SESSION_WS_EVENTS.runHuman, onHuman);
      socket.off(SESSION_WS_EVENTS.runReasoning, onReasoning);
      socket.off(SESSION_WS_EVENTS.runReasoningDone, onReasoningDone);
      socket.off(SESSION_WS_EVENTS.runChunk, onChunk);
      socket.off(SESSION_WS_EVENTS.runSnapshot, onSnapshot);
      socket.off(SESSION_WS_EVENTS.runDone, onDone);
      socket.off(SESSION_WS_EVENTS.runInterrupted, onInterrupted);
      socket.off(SESSION_WS_EVENTS.runError, onError);
      socket.off(SESSION_WS_EVENTS.runUsage, onUsage);
      socket.off(SESSION_WS_EVENTS.titleUpdated, onTitleUpdated);
      socket.off(SESSION_WS_EVENTS.runToolCallArgsDelta, onToolArgsDelta);
      socket.off(SESSION_WS_EVENTS.runToolCallStart, onToolStart);
      socket.off(SESSION_WS_EVENTS.runToolCallProgress, onToolProgress);
      socket.off(SESSION_WS_EVENTS.runToolCallEnd, onToolEnd);
      socket.off(SESSION_WS_EVENTS.runCompactionStart, onCompactionStart);
      socket.off(SESSION_WS_EVENTS.runCompactionDone, onCompactionDone);
      socket.off(SESSION_WS_EVENTS.runCompactionError, onCompactionError);
    };
  }, [
    sessionId,
    apply,
    upsertChunk,
    migrateHumanToTimeline,
    resetUsage,
    setInitialUsage,
    appendUsage,
    appendUsageByMessage,
    updateSessionTitle,
  ]);

  /**
   * 会话页发送：前端生成最终 messageId（雪花），乐观插入 user 气泡到 pending 区，
   * 用雪花（非 UUID）使 human id 与服务端 assistant 雪花 / checkpointer / 事件流 /
   * session_messages.id 三处收口一致，历史与 inflight 去重才能命中。
   * append 传同一 id 给后端。这样 run.human 到达时能直接按 id 找到目标气泡迁移，
   * 不需要 tempId 替换 / pendingHumanIdsRef 缓存。
   *
   * loading 占位 + 迁出 pending 区到聊天区末尾，全部交给 onHuman 处理。
   */
  const send = useCallback(
    async (msg: string) => {
      if (!sessionId) return;
      const messageId = clientSnowflakeId();
      apply((prev) => [
        ...prev,
        { id: messageId, role: "user", content: msg, pending: true },
      ]);
      try {
        await appendMessage(sessionId, messageId, msg);
      } catch (err) {
        console.error("追加消息失败", err);
      }
    },
    [sessionId, apply],
  );

  /** Stop 按钮：经 socket 发中断信号。 */
  const interrupt = useCallback(() => {
    if (!sessionId) return;
    getSessionSocket().emit(SESSION_WS_EVENTS.interrupt, { sessionId });
  }, [sessionId]);

  /**
   * 滚动到顶部触发：拉早于当前最旧消息的下一批 history。
   * - 锚定视口：prepend 前后 scrollTop 自动补偿，使用户当前看的消息不动
   * - 并发去重：loadingMoreRef 期间忽略重复触发
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: scrollContainerRef 是 RefObject，.current 故意不进依赖（与原实现一致）
  const loadMoreHistory = useCallback(async () => {
    if (!sessionId) return;
    if (!hasMoreHistoryRef.current) return;
    if (loadingMoreRef.current) return;
    const cursor = oldestMessageIdRef.current;
    if (!cursor) return;
    loadingMoreRef.current = true;
    const scroller = scrollContainerRef.current;
    const prevScrollHeight = scroller?.scrollHeight ?? 0;
    const prevScrollTop = scroller?.scrollTop ?? 0;
    try {
      const res = await fetchHistory(sessionId, cursor);
      apply((prev) => {
        const newMessages: TimelineMessage[] = res.messages.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          ...(m.reasoning
            ? { reasoning: m.reasoning, reasoningDurationMs: 0 }
            : {}),
        }));
        // 去重：socket 抢先到的或本地已有的不重复 prepend
        const existingIds = new Set(prev.map((m) => m.id));
        const fresh = newMessages.filter((m) => !existingIds.has(m.id));
        return [...fresh, ...prev];
      });
      appendUsageByMessage(res.byMessage);
      oldestMessageIdRef.current = res.messages[0]?.id ?? cursor;
      hasMoreHistoryRef.current = res.hasMore;
      setHasMoreHistory(res.hasMore);
      // 锚定视口：等 DOM 完成 prepend 后补偿 scrollTop
      requestAnimationFrame(() => {
        if (!scroller) return;
        const newScrollHeight = scroller.scrollHeight;
        scroller.scrollTop =
          prevScrollTop + (newScrollHeight - prevScrollHeight);
      });
    } catch (err) {
      console.error("加载更早消息失败", err);
    } finally {
      loadingMoreRef.current = false;
    }
  }, [sessionId, apply, appendUsageByMessage]);

  return {
    messages,
    running,
    compacting,
    hasMoreHistory,
    historyLoading,
    apply,
    send,
    interrupt,
    loadMoreHistory,
  };
}
