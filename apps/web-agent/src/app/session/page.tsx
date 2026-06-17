"use client";

import { useAtomValue } from "jotai";
import { ArrowDown } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { sessionTotalsAtom, usageByMessageAtom } from "@/atoms/session-usage";
import {
  ChatInput,
  type ChatInputHandle,
} from "@/components/common/chat-input";
import { CompactionBanner } from "@/components/common/compaction-banner";
import { AppShellLayout } from "@/components/layouts/app-shell-layout";
import { MessageList } from "@/components/session/message-list";
import { PendingList } from "@/components/session/pending-list";
import { SessionHeader } from "@/components/session/session-header";
import { useSessionStream } from "@/hooks/use-session-stream";
import { toI18nList } from "@/lib/i18n-list";
import { useModelConfigs } from "@/rest/model-config";
import { deletePendingMessage } from "@/rest/session";

function SessionView() {
  const t = useTranslations("session");
  const tHome = useTranslations("home");
  const searchParams = useSearchParams();
  const router = useRouter();
  const sessionId = searchParams.get("id");
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
  const { data: modelConfigs } = useModelConfigs();
  const enabledModel = modelConfigs?.find((c) => c.enabled);
  // contextWindow 由后端在配置入库时按 MODEL_SPECS 解析后固化（用户可覆盖），前端直接读
  const contextWindow = enabledModel?.contextWindow ?? 128_000;

  // null 守卫（视图职责）：sessionId 缺失时跳转首页
  useEffect(() => {
    if (!sessionId) router.replace("/assistant");
  }, [sessionId, router]);

  // 切换会话：复位首次跳底哨兵，让新会话首条消息渲染时走 instant（无「先看顶→滑下来」闪烁）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId 是触发 key，initialScrollDoneRef 是 RefObject（.current 故意不进依赖）
  useEffect(() => {
    initialScrollDoneRef.current = false;
  }, [sessionId]);

  const stream = useSessionStream(sessionId, scrollContainerRef);

  const timelineMessages = useMemo(
    () => stream.messages.filter((m) => !m.pending),
    [stream.messages],
  );
  const queuedMessages = useMemo(
    () => stream.messages.filter((m) => m.pending),
    [stream.messages],
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
   * 删除一条 pending 消息。
   * - 200：本地从 messages 移除
   * - 404：消息已不存在，本地也移除（兜底）
   * - 409：runner 已开始处理；不动本地，依赖 onHuman 自然推动状态收敛
   * - 其他错误：alert 提示
   */
  const handleDeletePending = async (id: string) => {
    if (!sessionId) return;
    try {
      await deletePendingMessage(sessionId, id);
      stream.apply((prev) => prev.filter((m) => m.id !== id));
    } catch (err) {
      const status =
        err instanceof Error &&
        "response" in err &&
        typeof (err as { response?: { status?: number } }).response?.status ===
          "number"
          ? (err as { response: { status: number } }).response.status
          : undefined;
      if (status === 404) {
        stream.apply((prev) => prev.filter((m) => m.id !== id));
      } else if (status === 409) {
        window.alert(t("cannotDeleteWhileProcessing"));
      } else {
        console.error("删除 pending 失败", err);
        window.alert(t("networkError"));
      }
    }
  };

  /**
   * 编辑 = 删 + 把内容回填输入框 + focus。
   * 若输入框已有非空 draft，confirm 后才覆盖。
   */
  const handleEditPending = async (id: string) => {
    if (!sessionId) return;
    if (draft.trim() && !window.confirm(t("confirmOverwriteDraft"))) return;
    try {
      const { content } = await deletePendingMessage(sessionId, id);
      stream.apply((prev) => prev.filter((m) => m.id !== id));
      setDraft(content);
      // 把 content 显式传给 focus —— setDraft 是异步的，focus 同一 tick 调用时
      // 闭包里的 value 仍是旧值。withText 让组件直接同步 DOM 到末尾。
      chatInputRef.current?.focus(content);
    } catch (err) {
      const status =
        err instanceof Error &&
        "response" in err &&
        typeof (err as { response?: { status?: number } }).response?.status ===
          "number"
          ? (err as { response: { status: number } }).response.status
          : undefined;
      if (status === 404) {
        stream.apply((prev) => prev.filter((m) => m.id !== id));
      } else if (status === 409) {
        window.alert(t("cannotEditWhileProcessing"));
      } else {
        console.error("编辑 pending 失败", err);
        window.alert(t("networkError"));
      }
    }
  };

  // 顶部哨兵触发上拉加载更早历史
  const topSentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!stream.hasMoreHistory) return;
    const sentinel = topSentinelRef.current;
    if (!sentinel) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          void stream.loadMoreHistory();
        }
      },
      { rootMargin: "100px" },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [stream.loadMoreHistory, stream.hasMoreHistory]);

  return (
    <AppShellLayout
      scrollContainerRef={scrollContainerRef}
      header={sessionId ? <SessionHeader sessionId={sessionId} /> : undefined}
    >
      <div className="flex w-full flex-1 flex-col">
        {stream.hasMoreHistory && (
          <div
            ref={topSentinelRef}
            className="flex justify-center py-2 text-xs text-muted-foreground/60"
          />
        )}
        {!stream.hasMoreHistory && timelineMessages.length > 0 && (
          <div className="py-2 text-center text-xs text-muted-foreground/40">
            会话开头
          </div>
        )}
        <CompactionBanner
          visible={!!stream.compacting}
          reason={stream.compacting ?? undefined}
        />
        <MessageList
          messages={timelineMessages}
          sessionId={sessionId ?? ""}
          running={stream.running}
          onRegenerateOptimisticCut={(messageId) => {
            // 截断到该消息（含），并清掉它的 failed 标记：
            // 重生成就是「这条 user 即将重跑」，旧的 failed 已陈旧；
            // 若新一轮再失败，onError 会重新打 failed。
            stream.apply((prev) => {
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
          onSend={stream.send}
          onInterrupt={stream.interrupt}
          isLoading={stream.running}
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
