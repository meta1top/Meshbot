"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface ChatScroll {
  /** 是否吸附底部（决定是否自动跟随流式输出滚到底）。 */
  stickToBottom: boolean;
  /** 立即（instant）滚到底并恢复吸附（「滚到底」按钮用）。 */
  scrollToBottom: () => void;
}

/**
 * 聊天滚动 hook：吸底自动跟随流式输出 + 底部哨兵吸附检测 + 顶部哨兵上拉加载更早。
 * 由调用方提供滚动容器 / 底部哨兵 / 顶部哨兵 refs 与消息依赖。
 */
export function useChatScroll(opts: {
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  bottomRef: React.RefObject<HTMLDivElement | null>;
  topSentinelRef: React.RefObject<HTMLDivElement | null>;
  /** 触发自动滚的依赖：可见消息列表（长度/末条变化即跟随）。 */
  messages: unknown[];
  /** 是否还有更早历史（false 时不挂顶部哨兵）。 */
  hasMore: boolean;
  /** 顶部哨兵进入视口时调用（上拉加载更早）。 */
  onLoadMore: () => void;
}): ChatScroll {
  /**
   * 是否吸附到底部：决定流式输出时是否自动滚到底。
   * - 初始 true（默认 follow）
   * - 用户主动滚离底部 → bottomRef IO 报 not intersecting → false
   * - 用户滚回底部（或点「滚到底」按钮）→ bottomRef IO 报 intersecting → true
   */
  const [stickToBottom, setStickToBottom] = useState(true);
  /**
   * 首次进入会话的 instant 跳底哨兵：跟随 effect 第一次触发时用 instant（无动画）
   * 直接到底，之后再用 smooth 跟流。切会话时消息清空（messages.length===0）会被重置 false。
   */
  const initialScrollDoneRef = useRef(false);
  /**
   * 用 ref 持有最新 onLoadMore：调用方常传内联箭头（每渲染新引用），
   * 若直接进顶部哨兵 effect 依赖会导致 IO 每渲染 disconnect+reconnect
   * （流式期间频繁 re-render 时尤甚）。ref pattern 让 effect 只随 hasMore 重建。
   */
  const onLoadMoreRef = useRef(opts.onLoadMore);
  onLoadMoreRef.current = opts.onLoadMore;

  /**
   * 新消息或流式增量到达时，仅在 stickToBottom=true 时自动滚到底。
   * 用户主动滚离底部时停止跟随；点右下角按钮可恢复。
   *
   * 首次触发（initialScrollDoneRef=false）走 instant：history fetch 完成后
   * 视口直接到底，无「先看顶 → 滑下来」闪烁。之后才用 smooth 跟流。
   *
   * 切会话时 useSessionStream 会把 messages 清为 []，此时重置 initialScrollDoneRef，
   * 确保下一个会话首条消息渲染时走 instant（与原页面级 sessionId effect 等价）。
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: initialScrollDoneRef 是 RefObject（.current 故意不进依赖）
  useEffect(() => {
    if (!stickToBottom) return;
    // 消息还没就位（fetchHistory 未 resolve）：重置首次跳底哨兵，并跳过；
    // 避免空 timeline 那次 effect 提前把首次哨兵置 true，导致下一次有内容时已走 smooth。
    if (opts.messages.length === 0) {
      initialScrollDoneRef.current = false;
      return;
    }
    if (!initialScrollDoneRef.current) {
      initialScrollDoneRef.current = true;
      // 不传 block：与 smooth 跟随保持一致（默认 "start"，sticky 输入框
      // 不会遮挡末尾消息）。
      opts.bottomRef.current?.scrollIntoView({ behavior: "instant" });
      return;
    }
    opts.bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [opts.messages, stickToBottom]);

  /**
   * 底部哨兵 IO：bottomRef 可见 = 用户在底部 → stickToBottom=true；
   * 不可见 = 用户滚走了 → false。直接基于"哨兵在不在视口"判断，比 scroll
   * 事件 + 阈值检测更稳（不受 smooth 动画期间的瞬时偏移干扰）。
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: bottomRef/scrollContainerRef 是稳定 RefObject，IO 仅挂载时建立一次（.current 故意不进依赖，与原实现一致）
  useEffect(() => {
    const sentinel = opts.bottomRef.current;
    const root = opts.scrollContainerRef.current;
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

  // 顶部哨兵触发上拉加载更早历史。仅随 hasMore 重建 IO（onLoadMore 走 ref，
  // 不进依赖，避免内联箭头每渲染重建 observer）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: topSentinelRef 稳定 RefObject、onLoadMore 走 onLoadMoreRef（.current 故意不进依赖）
  useEffect(() => {
    if (!opts.hasMore) return;
    const sentinel = opts.topSentinelRef.current;
    if (!sentinel) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          onLoadMoreRef.current();
        }
      },
      { rootMargin: "100px" },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [opts.hasMore]);

  const scrollToBottom = useCallback(() => {
    setStickToBottom(true);
    opts.bottomRef.current?.scrollIntoView({ behavior: "instant" });
  }, [opts.bottomRef]);

  return { stickToBottom, scrollToBottom };
}
