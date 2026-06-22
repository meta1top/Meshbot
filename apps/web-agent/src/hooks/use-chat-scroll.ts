"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** 距底多少 px 内算「吸底」。给流式增量与布局抖动留余量。 */
const STICK_THRESHOLD_PX = 80;

export interface ChatScroll {
  /** 是否吸附底部（决定是否自动跟随流式输出滚到底；驱动「滚到底」按钮显隐）。 */
  stickToBottom: boolean;
  /** 立即滚到底并恢复吸附（「滚到底」按钮用）。 */
  scrollToBottom: () => void;
}

/**
 * 聊天滚动 hook：吸底自动跟随流式输出 + 距底阈值检测 + 顶部哨兵上拉加载更早。
 *
 * 吸底判定基于滚动容器的 scroll 事件 + 距底距离（而非底部哨兵 IO）：
 * - 容器常驻挂载，监听不受「哨兵条件渲染」时序影响（修复加载后不吸底）；
 * - 内容增长本身不触发 scroll 事件 → 吸底态只由用户主动滚动改变，
 *   天然满足「用户主动上滚后不被强行拽回底部」；
 * - 跟随用 instant（scrollTop=scrollHeight），不受 smooth 动画追不上内容增长
 *   导致的跟随中断（修复流式/新消息不实时滚底）。
 */
export function useChatScroll(opts: {
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  topSentinelRef: React.RefObject<HTMLDivElement | null>;
  /** 触发自动滚的依赖：可见消息列表（长度/末条变化即跟随）。 */
  messages: unknown[];
  /** 是否还有更早历史（false 时不挂顶部哨兵）。 */
  hasMore: boolean;
  /** 顶部哨兵进入视口时调用（上拉加载更早）。 */
  onLoadMore: () => void;
}): ChatScroll {
  const [stickToBottom, setStickToBottom] = useState(true);
  /** 镜像最新吸底态，供 follow effect 同步读取（不进依赖、不滞后）。 */
  const stickRef = useRef(true);
  /** 首次进入会话的 instant 跳底哨兵；切会话清空消息时重置。 */
  const initialScrollDoneRef = useRef(false);

  /** 持有最新 onLoadMore，避免内联箭头每渲染重建顶部哨兵 IO。 */
  const onLoadMoreRef = useRef(opts.onLoadMore);
  onLoadMoreRef.current = opts.onLoadMore;

  const scrollToEnd = useCallback(() => {
    const el = opts.scrollContainerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [opts.scrollContainerRef]);

  /**
   * 滚动监听：按距底距离判吸底。容器常驻 → 监听稳定挂载一次。
   * 内容增长不触发 scroll，故吸底态只由用户滚动改变。
   */
  useEffect(() => {
    const el = opts.scrollContainerRef.current;
    if (!el) return;
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      const atBottom = distance <= STICK_THRESHOLD_PX;
      stickRef.current = atBottom;
      setStickToBottom(atBottom);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [opts.scrollContainerRef]);

  /**
   * 新消息 / 流式增量到达：吸底时跟随到底（instant）。
   * 首次有内容（进入会话 / 切会话后首条）直接吸底到底；messages 清空时重置首次哨兵。
   */
  useEffect(() => {
    if (opts.messages.length === 0) {
      initialScrollDoneRef.current = false;
      return;
    }
    if (!initialScrollDoneRef.current) {
      initialScrollDoneRef.current = true;
      stickRef.current = true;
      setStickToBottom(true);
      // 直接到底 + 下一帧再到底：兜底首屏字体/图片/异步布局导致的高度变化。
      scrollToEnd();
      requestAnimationFrame(scrollToEnd);
      return;
    }
    if (!stickRef.current) return;
    scrollToEnd();
  }, [opts.messages, scrollToEnd]);

  // 顶部哨兵触发上拉加载更早历史。仅随 hasMore 重建 IO（onLoadMore 走 ref）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: topSentinelRef 稳定 RefObject、onLoadMore 走 onLoadMoreRef
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
    stickRef.current = true;
    setStickToBottom(true);
    scrollToEnd();
  }, [scrollToEnd]);

  return { stickToBottom, scrollToBottom };
}
