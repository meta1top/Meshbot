"use client";

import {
  type RunChunkEvent,
  type RunDoneEvent,
  type RunErrorEvent,
  type RunHumanEvent,
  type RunInterruptedEvent,
  type RunReasoningChunkEvent,
  type RunUsageEvent,
  SESSION_WS_EVENTS,
} from "@meshbot/types-agent";
import { useAtomValue, useSetAtom } from "jotai";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  appendUsageAtom,
  resetUsageAtom,
  sessionTotalsAtom,
  setInitialUsageAtom,
  usageByMessageAtom,
} from "@/atoms/session-usage";
import { ChatInput } from "@/components/common/chat-input";
import { AppShellLayout } from "@/components/layouts/app-shell-layout";
import {
  MessageList,
  type TimelineMessage,
} from "@/components/session/message-list";
import { PendingList } from "@/components/session/pending-list";
import { getModelContextWindow } from "@/lib/model-context-window";
import { getSessionSocket } from "@/lib/socket";
import { useModelConfigs } from "@/rest/model-config";
import {
  appendMessage,
  fetchHistory,
  fetchPending,
  retrySession,
} from "@/rest/session";

function SessionView() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const sessionId = searchParams.get("id");
  const [messages, setMessages] = useState<TimelineMessage[]>([]);
  const [running, setRunning] = useState(false);
  const messagesRef = useRef<TimelineMessage[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  const usageByMessage = useAtomValue(usageByMessageAtom);
  const sessionTotals = useAtomValue(sessionTotalsAtom);
  const setInitialUsage = useSetAtom(setInitialUsageAtom);
  const appendUsage = useSetAtom(appendUsageAtom);
  const resetUsage = useSetAtom(resetUsageAtom);
  const { data: modelConfigs } = useModelConfigs();
  const enabledModel = modelConfigs?.find((c) => c.enabled);
  const contextWindow = enabledModel
    ? getModelContextWindow(enabledModel.model)
    : 128_000;

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
   * 因 messageId 由前端生成、append 同步用同一 id，run.human 到达时一定能 find 到。
   */
  const migrateHumanToTimeline = useCallback(
    (messageId: string): void => {
      apply((prev) => {
        const idx = prev.findIndex((m) => m.id === messageId);
        if (idx === -1) return prev;
        const target = { ...prev[idx], pending: false };
        const rest = [...prev.slice(0, idx), ...prev.slice(idx + 1)];
        const next = [...rest, target];
        if (next.some((m) => m.loading)) return next;
        return [
          ...next,
          {
            id: `loading-${messageId}`,
            role: "assistant" as const,
            content: "",
            loading: true,
          },
        ];
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
    if (!sessionId) {
      router.replace("/");
      return;
    }
    resetUsage();
    let cancelled = false;

    void Promise.all([fetchHistory(sessionId), fetchPending(sessionId)]).then(
      ([history, pending]) => {
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
            initial.push({
              id: history.inflight.messageId,
              role: "assistant",
              content: history.inflight.content,
              streaming: true,
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
          // 仅 status === "pending"（runner 还没认领）进 pending 区；
          // processing 当作正常 user 气泡（runner 已在跑、对应 assistant 即将出现）；
          // failed 当作正常 user 气泡 + 失败标记。
          initial.push({
            id: p.id,
            role: "user",
            content: p.content,
            pending: p.status === "pending",
            failed: p.status === "failed",
          });
        }
        // 合并：历史快照打底，但保留 socket 已先到的消息（不被覆盖）
        apply((current) => {
          const initialIds = new Set(initial.map((m) => m.id));
          const socketArrived = current.filter((m) => !initialIds.has(m.id));
          return [...initial, ...socketArrived];
        });
        setInitialUsage(history.usage);
      },
    );

    const socket = getSessionSocket();
    const subscribe = () =>
      socket.emit(SESSION_WS_EVENTS.subscribe, { sessionId });

    const onHuman = (e: RunHumanEvent) => {
      if (e.sessionId !== sessionId) return;
      migrateHumanToTimeline(e.messageId);
    };
    const onReasoning = (e: RunReasoningChunkEvent) => {
      if (e.sessionId !== sessionId) return;
      setRunning(true);
      apply((prev) => {
        // 首个 reasoning 到达：清当前消息的 loading 占位（按 id 匹配，而非全清，
        // 否则会把同时排队的其它 user 消息从 pending 区误清出来——pending 标记
        // 只由 run.human 事件清，不由 reasoning/chunk 顺手清）。
        const withoutLoading = prev.filter(
          (m) => !(m.loading && m.id === `loading-${e.messageId}`),
        );
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
          reasoningStartedAt: existing.reasoningStartedAt ?? Date.now(),
        };
        return copy;
      });
    };
    const onChunk = (e: RunChunkEvent) => {
      if (e.sessionId !== sessionId) return;
      setRunning(true);
      apply((prev) => {
        // 首个 chunk 到达：
        // 1) 清掉本次 run 的 loading 占位（按 id 匹配，不全清，避免影响其它排队中的 run）
        // 2) 该消息若有进行中的 reasoning（startedAt 已设、durationMs 未设），
        //    在第一次 chunk 到达时锁定 reasoningDurationMs
        //
        // pending user 标记的清理交给 run.human 事件（服务端真相），不在这里顺手做。
        const withoutLoading = prev.filter(
          (m) => !(m.loading && m.id === `loading-${e.messageId}`),
        );
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

    socket.on("connect", subscribe);
    if (socket.connected) subscribe();
    socket.on(SESSION_WS_EVENTS.runHuman, onHuman);
    socket.on(SESSION_WS_EVENTS.runReasoning, onReasoning);
    socket.on(SESSION_WS_EVENTS.runChunk, onChunk);
    socket.on(SESSION_WS_EVENTS.runDone, onDone);
    socket.on(SESSION_WS_EVENTS.runInterrupted, onInterrupted);
    socket.on(SESSION_WS_EVENTS.runError, onError);
    socket.on(SESSION_WS_EVENTS.runUsage, onUsage);

    return () => {
      cancelled = true;
      socket.off("connect", subscribe);
      socket.off(SESSION_WS_EVENTS.runHuman, onHuman);
      socket.off(SESSION_WS_EVENTS.runReasoning, onReasoning);
      socket.off(SESSION_WS_EVENTS.runChunk, onChunk);
      socket.off(SESSION_WS_EVENTS.runDone, onDone);
      socket.off(SESSION_WS_EVENTS.runInterrupted, onInterrupted);
      socket.off(SESSION_WS_EVENTS.runError, onError);
      socket.off(SESSION_WS_EVENTS.runUsage, onUsage);
    };
  }, [
    sessionId,
    router,
    apply,
    upsertChunk,
    migrateHumanToTimeline,
    resetUsage,
    setInitialUsage,
    appendUsage,
  ]);

  const timelineMessages = useMemo(
    () => messages.filter((m) => !m.pending),
    [messages],
  );
  const queuedMessages = useMemo(
    () => messages.filter((m) => m.pending),
    [messages],
  );

  /** 新消息或流式增量到达时，平滑滚动到底部。 */
  // biome-ignore lint/correctness/useExhaustiveDependencies: timelineMessages 仅作触发依赖，effect 体不直接读取
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [timelineMessages]);

  /**
   * 会话页发送：前端生成最终 messageId（UUID），乐观插入 user 气泡到 pending 区，
   * append 传同一 id 给后端。这样 run.human 到达时能直接按 id 找到目标气泡迁移，
   * 不需要 tempId 替换 / pendingHumanIdsRef 缓存。
   *
   * loading 占位 + 迁出 pending 区到聊天区末尾，全部交给 onHuman 处理。
   */
  const handleSend = useCallback(
    async (msg: string) => {
      if (!sessionId) return;
      const messageId = crypto.randomUUID();
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
  const handleInterrupt = useCallback(() => {
    if (!sessionId) return;
    getSessionSocket().emit(SESSION_WS_EVENTS.interrupt, { sessionId });
  }, [sessionId]);

  /** 失败消息「重试」：调 retry 接口，结果经 socket 事件回流。 */
  const handleRetry = useCallback(async () => {
    if (!sessionId) return;
    try {
      await retrySession(sessionId);
    } catch (err) {
      console.error("重试失败", err);
    }
  }, [sessionId]);

  return (
    <AppShellLayout>
      <div className="flex w-full flex-1 flex-col">
        <MessageList
          messages={timelineMessages}
          onRetry={handleRetry}
          usageByMessage={usageByMessage}
        />
        <div ref={bottomRef} />
      </div>
      {/*
        sticky 输入区：bottom-4 距底 16px；上方放绝对定位的渐变遮罩做软淡出。
        下方那 16px 缝隙由独立 bottom-bar 覆盖，避免滚动文字从缝隙钻出。
      */}
      <div className="sticky bottom-4 mt-auto w-full bg-background">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 -top-6 h-6 bg-linear-to-b from-transparent to-background"
        />
        {/* 底部缝隙遮挡：与 sticky 容器的 bottom-4 一致，覆盖输入框与窗口底之间的间隙 */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 -bottom-4 h-4 bg-background"
        />
        {queuedMessages.length > 0 && (
          <div className="mb-2">
            <PendingList
              messages={queuedMessages}
              onDelete={() => console.warn("删除待处理消息：即将支持")}
              onEdit={() => console.warn("编辑待处理消息：即将支持")}
            />
          </div>
        )}
        <ChatInput
          onSend={handleSend}
          onInterrupt={handleInterrupt}
          isLoading={running}
          tokenUsage={{
            current: sessionTotals.totalTokens,
            max: contextWindow,
            breakdown: {
              inputTokens: sessionTotals.inputTokens,
              outputTokens: sessionTotals.outputTokens,
              cacheReadTokens: sessionTotals.cacheReadTokens,
              reasoningTokens: sessionTotals.reasoningTokens,
              callCount: sessionTotals.callCount,
            },
          }}
        />
      </div>
    </AppShellLayout>
  );
}

/** 会话页。useSearchParams 需 Suspense 边界（静态导出要求）。 */
export default function SessionPage() {
  return (
    <Suspense fallback={null}>
      <SessionView />
    </Suspense>
  );
}
