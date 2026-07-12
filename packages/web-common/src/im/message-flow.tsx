"use client";

import type { ImMessage } from "@meshbot/types";
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { ImMessageList, type ImMessageListLabels } from "./im-message-list";

export type MessageFlowLabels = ImMessageListLabels;

export interface MessageFlowProps {
  messages: ImMessage[];
  /** 当前登录用户 id，用于判定"是否自己发的"（行式头像色 / 靠右气泡）。 */
  meUserId: string;
  /** 是否还有更早的历史（驱动顶部哨兵是否渲染）。 */
  hasMore: boolean;
  /** 上一页历史是否正在加载（哨兵触发时的去重闸门，由调用方持有状态）。 */
  loadingMore: boolean;
  /** 顶部哨兵进入视口时触发；调用方负责真正的分页请求 + 滚动位置锚定。 */
  onLoadMore: () => void;
  /** 共享滚动容器 ref（由页面级 PageShell 提供），用于粘底检测与 scrollIntoView。 */
  scrollRef: RefObject<HTMLDivElement | null>;
  /** senderId → 展示名；由调用方从 members 字典解析注入（web-common 不碰业务数据源）。 */
  resolveDisplayName: (senderId: string) => string;
  /** 渲染正文：web-agent 注入 MarkdownContent、web-main 可注入纯文本。 */
  renderContent: (m: ImMessage) => ReactNode;
  labels: MessageFlowLabels;
}

/**
 * IM 消息流：顶部哨兵触发向上翻页 + 消息列表（委托 ImMessageList）+ 粘底自动滚动。
 * 纯展示 + DOM 滚动逻辑，不含 socket / REST —— 历史分页与发送均由调用方通过 props 驱动。
 */
export function MessageFlow({
  messages,
  meUserId,
  hasMore,
  loadingMore,
  onLoadMore,
  scrollRef,
  resolveDisplayName,
  renderContent,
  labels,
}: MessageFlowProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const [stickToBottom, setStickToBottom] = useState(true);
  const initialScrollDoneRef = useRef(false);

  // 顶部哨兵：进入视口 → 通知调用方翻页（hasMore=false 时不渲染哨兵，观察器也不挂载）。
  useEffect(() => {
    if (!hasMore) return;
    const sentinel = topSentinelRef.current;
    if (!sentinel) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !loadingMore) {
          onLoadMore();
        }
      },
      { rootMargin: "100px" },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [hasMore, loadingMore, onLoadMore]);

  // 粘底：仅在用户停留在底部时，新消息到达自动滚动（首次瞬时定位，之后平滑）。
  useEffect(() => {
    if (!stickToBottom) return;
    if (messages.length === 0) return;
    if (!initialScrollDoneRef.current) {
      initialScrollDoneRef.current = true;
      bottomRef.current?.scrollIntoView({ behavior: "instant" });
      return;
    }
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, stickToBottom]);

  // 底部哨兵 IO：检测用户是否仍停留在底部，驱动上面的粘底效果。
  useEffect(() => {
    const sentinel = bottomRef.current;
    const root = scrollRef.current;
    if (!sentinel || !root) return;
    const io = new IntersectionObserver(
      (entries) => {
        setStickToBottom(entries[0]?.isIntersecting ?? false);
      },
      { root, threshold: 0 },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [scrollRef]);

  const resolveSender = useCallback(
    (m: ImMessage) => {
      const dn = resolveDisplayName(m.senderId);
      return {
        displayName: dn,
        initial: dn.charAt(0).toUpperCase(),
        isSelf: m.senderId === meUserId,
      };
    },
    [resolveDisplayName, meUserId],
  );

  return (
    <>
      {hasMore && (
        <div
          ref={topSentinelRef}
          className="flex justify-center py-2 text-xs text-muted-foreground/60"
        />
      )}
      <ImMessageList
        messages={messages}
        variant="rows"
        groupKey={(m) => m.senderId}
        resolveSender={resolveSender}
        renderContent={renderContent}
        labels={labels}
        onCopy={(m) => void navigator.clipboard?.writeText(m.content)}
      />
      <div ref={bottomRef} />
    </>
  );
}
