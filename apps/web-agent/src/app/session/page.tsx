"use client";

import {
  type RunChunkEvent,
  type RunDoneEvent,
  type RunErrorEvent,
  type RunHumanEvent,
  type RunInterruptedEvent,
  type RunReasoningChunkEvent,
  type RunToolCallEndEvent,
  type RunToolCallProgressEvent,
  type RunToolCallStartEvent,
  type RunUsageEvent,
  SESSION_WS_EVENTS,
} from "@meshbot/types-agent";
import { useAtomValue, useSetAtom } from "jotai";
import { ArrowDown } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
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
  appendUsageByMessageAtom,
  resetUsageAtom,
  sessionTotalsAtom,
  setInitialUsageAtom,
  usageByMessageAtom,
} from "@/atoms/session-usage";
import {
  ChatInput,
  type ChatInputHandle,
} from "@/components/common/chat-input";
import { CompactionBanner } from "@/components/common/compaction-banner";
import { AppShellLayout } from "@/components/layouts/app-shell-layout";
import {
  MessageList,
  type TimelineMessage,
} from "@/components/session/message-list";
import { PendingList } from "@/components/session/pending-list";
import { toI18nList } from "@/lib/i18n-list";
import { getSessionSocket } from "@/lib/socket";
import { useModelConfigs } from "@/rest/model-config";
import {
  appendMessage,
  deletePendingMessage,
  fetchHistory,
  fetchPending,
} from "@/rest/session";

function SessionView() {
  const t = useTranslations("session");
  const tHome = useTranslations("home");
  const searchParams = useSearchParams();
  const router = useRouter();
  const sessionId = searchParams.get("id");
  const [messages, setMessages] = useState<TimelineMessage[]>([]);
  const [running, setRunning] = useState(false);
  const messagesRef = useRef<TimelineMessage[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState("");
  const chatInputRef = useRef<ChatInputHandle>(null);

  // 输入框 placeholder：挂载后从同一组文案随机选一条（与首页一致，避免单调）
  // sync-locales 把数组 flatten 成 numeric-key 对象，toI18nList 兜底还原列表
  const placeholders = toI18nList(tHome.raw("inputPlaceholders"));
  const [phIdx, setPhIdx] = useState(0);
  useEffect(() => {
    if (placeholders.length > 1) {
      setPhIdx(Math.floor(Math.random() * placeholders.length));
    }
  }, [placeholders.length]);
  const inputPlaceholder = placeholders[phIdx];
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const oldestMessageIdRef = useRef<string | null>(null);
  const hasMoreHistoryRef = useRef(true);
  const loadingMoreRef = useRef(false);
  const [hasMoreHistory, setHasMoreHistory] = useState(true);
  /** 压缩进行中标记。null = 未压缩；string = 压缩原因（用于 banner 文案）。 */
  const [compacting, setCompacting] = useState<
    null | "threshold" | "ctx-exceeded"
  >(null);
  const topSentinelRef = useRef<HTMLDivElement>(null);
  /**
   * 是否吸附到底部：决定流式输出时是否自动滚到底。
   * - 初始 true（默认 follow）
   * - 用户主动滚离底部 → bottomRef IO 报 not intersecting → false
   * - 用户滚回底部（或点「滚到底」按钮）→ bottomRef IO 报 intersecting → true
   */
  const [stickToBottom, setStickToBottom] = useState(true);
  /**
   * 首次进入会话的 instant 跳底哨兵：跟随 effect 第一次触发时用 instant（无动画）
   * 直接到底，之后再用 smooth 跟流。切会话时（initSession effect）会被重置 false。
   */
  const initialScrollDoneRef = useRef(false);

  const usageByMessage = useAtomValue(usageByMessageAtom);
  const sessionTotals = useAtomValue(sessionTotalsAtom);
  const setInitialUsage = useSetAtom(setInitialUsageAtom);
  const appendUsage = useSetAtom(appendUsageAtom);
  const appendUsageByMessage = useSetAtom(appendUsageByMessageAtom);
  const resetUsage = useSetAtom(resetUsageAtom);
  const { data: modelConfigs } = useModelConfigs();
  const enabledModel = modelConfigs?.find((c) => c.enabled);
  // contextWindow 由后端在配置入库时按 MODEL_SPECS 解析后固化（用户可覆盖），前端直接读
  const contextWindow = enabledModel?.contextWindow ?? 128_000;

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
    if (!sessionId) {
      router.replace("/");
      return;
    }
    // 切换 session：清空上一轮 timeline + inflight 状态 + usage 累计。否则
    // 后面的「合并历史 + socketArrived」逻辑会把旧 session 的消息当成「socket 已先到」
    // 保留下来，两段对话就混在一起。
    messagesRef.current = [];
    setMessages([]);
    setRunning(false);
    oldestMessageIdRef.current = null;
    hasMoreHistoryRef.current = true;
    setHasMoreHistory(true);
    initialScrollDoneRef.current = false;
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
                    reasoningDurationMs: 0,
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
          return {
            ...m,
            ...lockDuration,
            streaming: false,
            toolCalls: [
              ...(m.toolCalls ?? []),
              {
                toolCallId: e.toolCallId,
                name: e.name,
                args: e.args,
                status: "running" as const,
              },
            ],
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
    socket.on(SESSION_WS_EVENTS.runChunk, onChunk);
    socket.on(SESSION_WS_EVENTS.runDone, onDone);
    socket.on(SESSION_WS_EVENTS.runInterrupted, onInterrupted);
    socket.on(SESSION_WS_EVENTS.runError, onError);
    socket.on(SESSION_WS_EVENTS.runUsage, onUsage);
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
      socket.off(SESSION_WS_EVENTS.runChunk, onChunk);
      socket.off(SESSION_WS_EVENTS.runDone, onDone);
      socket.off(SESSION_WS_EVENTS.runInterrupted, onInterrupted);
      socket.off(SESSION_WS_EVENTS.runError, onError);
      socket.off(SESSION_WS_EVENTS.runUsage, onUsage);
      socket.off(SESSION_WS_EVENTS.runToolCallStart, onToolStart);
      socket.off(SESSION_WS_EVENTS.runToolCallProgress, onToolProgress);
      socket.off(SESSION_WS_EVENTS.runToolCallEnd, onToolEnd);
      socket.off(SESSION_WS_EVENTS.runCompactionStart, onCompactionStart);
      socket.off(SESSION_WS_EVENTS.runCompactionDone, onCompactionDone);
      socket.off(SESSION_WS_EVENTS.runCompactionError, onCompactionError);
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
    appendUsageByMessage,
  ]);

  const timelineMessages = useMemo(
    () => messages.filter((m) => !m.pending),
    [messages],
  );
  const queuedMessages = useMemo(
    () => messages.filter((m) => m.pending),
    [messages],
  );

  /**
   * 新消息或流式增量到达时，仅在 stickToBottom=true 时自动滚到底。
   * 用户主动滚离底部时停止跟随；点右下角按钮可恢复。
   *
   * 首次触发（initialScrollDoneRef=false）走 instant：history fetch 完成后
   * 视口直接到底，无「先看顶 → 滑下来」闪烁。之后才用 smooth 跟流。
   */
  useEffect(() => {
    if (!stickToBottom) return;
    // 消息还没就位（fetchHistory 未 resolve）：跳过；避免空 timeline
    // 那次 effect 提前把首次哨兵置 true，导致下一次有内容时已走 smooth。
    if (timelineMessages.length === 0) return;
    if (!initialScrollDoneRef.current) {
      initialScrollDoneRef.current = true;
      // 不传 block：与 smooth 跟随保持一致（默认 "start"，sticky 输入框
      // 不会遮挡末尾消息）。
      bottomRef.current?.scrollIntoView({ behavior: "instant" });
      return;
    }
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [timelineMessages, stickToBottom]);

  /**
   * 底部哨兵 IO：bottomRef 可见 = 用户在底部 → stickToBottom=true；
   * 不可见 = 用户滚走了 → false。直接基于"哨兵在不在视口"判断，比 scroll
   * 事件 + 阈值检测更稳（不受 smooth 动画期间的瞬时偏移干扰）。
   */
  useEffect(() => {
    const sentinel = bottomRef.current;
    const root = scrollContainerRef.current;
    if (!sentinel || !root) return;
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries[0]?.isIntersecting ?? false;
        setStickToBottom(visible);
      },
      { root, threshold: 0 },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, []);

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

  /**
   * 删除一条 pending 消息。
   * - 200：本地从 messages 移除
   * - 404：消息已不存在，本地也移除（兜底）
   * - 409：runner 已开始处理；不动本地，依赖 onHuman 自然推动状态收敛
   * - 其他错误：alert 提示
   */
  const handleDeletePending = useCallback(
    async (id: string) => {
      if (!sessionId) return;
      try {
        await deletePendingMessage(sessionId, id);
        apply((prev) => prev.filter((m) => m.id !== id));
      } catch (err) {
        const status =
          err instanceof Error &&
          "response" in err &&
          typeof (err as { response?: { status?: number } }).response
            ?.status === "number"
            ? (err as { response: { status: number } }).response.status
            : undefined;
        if (status === 404) {
          apply((prev) => prev.filter((m) => m.id !== id));
        } else if (status === 409) {
          window.alert(t("cannotDeleteWhileProcessing"));
        } else {
          console.error("删除 pending 失败", err);
          window.alert(t("networkError"));
        }
      }
    },
    [sessionId, apply, t],
  );

  /**
   * 编辑 = 删 + 把内容回填输入框 + focus。
   * 若输入框已有非空 draft，confirm 后才覆盖。
   */
  const handleEditPending = useCallback(
    async (id: string) => {
      if (!sessionId) return;
      if (draft.trim() && !window.confirm(t("confirmOverwriteDraft"))) return;
      try {
        const { content } = await deletePendingMessage(sessionId, id);
        apply((prev) => prev.filter((m) => m.id !== id));
        setDraft(content);
        // 把 content 显式传给 focus —— setDraft 是异步的，focus 同一 tick 调用时
        // 闭包里的 value 仍是旧值。withText 让组件直接同步 DOM 到末尾。
        chatInputRef.current?.focus(content);
      } catch (err) {
        const status =
          err instanceof Error &&
          "response" in err &&
          typeof (err as { response?: { status?: number } }).response
            ?.status === "number"
            ? (err as { response: { status: number } }).response.status
            : undefined;
        if (status === 404) {
          apply((prev) => prev.filter((m) => m.id !== id));
        } else if (status === 409) {
          window.alert(t("cannotEditWhileProcessing"));
        } else {
          console.error("编辑 pending 失败", err);
          window.alert(t("networkError"));
        }
      }
    },
    [sessionId, draft, apply, t],
  );

  /**
   * 滚动到顶部触发：拉早于当前最旧消息的下一批 history。
   * - 锚定视口：prepend 前后 scrollTop 自动补偿，使用户当前看的消息不动
   * - 并发去重：loadingMoreRef 期间忽略重复触发
   */
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

  // 顶部哨兵触发上拉加载更早历史
  useEffect(() => {
    if (!hasMoreHistory) return;
    const sentinel = topSentinelRef.current;
    if (!sentinel) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          void loadMoreHistory();
        }
      },
      { rootMargin: "100px" },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [loadMoreHistory, hasMoreHistory]);

  return (
    <AppShellLayout scrollContainerRef={scrollContainerRef}>
      <div className="flex w-full flex-1 flex-col">
        {hasMoreHistory && (
          <div
            ref={topSentinelRef}
            className="flex justify-center py-2 text-xs text-muted-foreground/60"
          />
        )}
        {!hasMoreHistory && timelineMessages.length > 0 && (
          <div className="py-2 text-center text-xs text-muted-foreground/40">
            会话开头
          </div>
        )}
        <CompactionBanner
          visible={!!compacting}
          reason={compacting ?? undefined}
        />
        <MessageList
          messages={timelineMessages}
          sessionId={sessionId ?? ""}
          running={running}
          onRegenerateOptimisticCut={(messageId) => {
            // 截断到该消息（含），并清掉它的 failed 标记：
            // 重生成就是「这条 user 即将重跑」，旧的 failed 已陈旧；
            // 若新一轮再失败，onError 会重新打 failed。
            apply((prev) => {
              const idx = prev.findIndex((m) => m.id === messageId);
              if (idx < 0) return prev;
              return prev
                .slice(0, idx + 1)
                .map((m) =>
                  m.id === messageId && m.failed ? { ...m, failed: false } : m,
                );
            });
          }}
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
        {/* 滚到底按钮：仅在用户离开底部时显示；点击恢复 stickToBottom + 立即平滑滚到底 */}
        {!stickToBottom && (
          <button
            type="button"
            aria-label={t("scrollToBottom")}
            className="absolute right-2 -top-12 flex h-9 w-9 items-center justify-center rounded-full border border-border bg-background text-foreground shadow-sm hover:bg-muted"
            onClick={() => {
              setStickToBottom(true);
              bottomRef.current?.scrollIntoView({ behavior: "instant" });
            }}
          >
            <ArrowDown className="h-4 w-4" />
          </button>
        )}
        {queuedMessages.length > 0 && (
          <div className="mb-2">
            <PendingList
              messages={queuedMessages}
              onDelete={handleDeletePending}
              onEdit={handleEditPending}
            />
          </div>
        )}
        <ChatInput
          ref={chatInputRef}
          value={draft}
          onChange={setDraft}
          onSend={handleSend}
          onInterrupt={handleInterrupt}
          isLoading={running}
          placeholder={inputPlaceholder}
          tokenUsage={{
            // 「下次请求估算 / ctx 上限」—— 用 lastInputTokens 作为代理：
            // 这是上一轮 LLM 真实计数，下一轮 input 约等于这个（用户新输入
            // 通常远小于历史）。比 sum(input+output) 量纲更对。
            current: sessionTotals.lastInputTokens,
            max: contextWindow,
            breakdown: {
              inputTokens: sessionTotals.inputTokens,
              outputTokens: sessionTotals.outputTokens,
              cacheReadTokens: sessionTotals.cacheReadTokens,
              reasoningTokens: sessionTotals.reasoningTokens,
              callCount: sessionTotals.callCount,
              cumulativeTokens: sessionTotals.totalTokens,
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
