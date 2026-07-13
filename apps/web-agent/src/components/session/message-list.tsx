"use client";

import { cn } from "@meshbot/design";
import type { MessageUsage } from "@meshbot/types-agent";
import { stripLlmuse } from "@meshbot/types-agent";
import type { TimelineMessage } from "@meshbot/web-common/session";
import { useAtomValue } from "jotai";
import { ChevronRight, Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { currentUserAtom } from "@/atoms/auth";
import { AssistantMessageActions } from "./assistant-message-actions";
import { CompactionRow } from "./compaction-row";
import { MarkdownContent } from "./markdown-content";
import { ToolCallBlock } from "./tool-call-block";
import { UserMessageActions } from "./user-message-actions";

/**
 * `TimelineMessage`/`ToolCallView` 原在本文件定义，Task 6 随 `useSessionStream`
 * 迁入 `@meshbot/web-common/session`（hook 唯一数据出口，web-common 侧也要用）。
 * 这里改为 re-export，`@/components/session/message-list` 既有 import 路径不变。
 */
export type {
  TimelineMessage,
  ToolCallView,
} from "@meshbot/web-common/session";

interface MessageListProps {
  messages: TimelineMessage[];
  /** 当前会话 id。供 UserMessageActions 调 regenerate 端点用。 */
  sessionId: string;
  /** 会话是否有 inflight run。重试按钮按这个 disable。 */
  running: boolean;
  /**
   * 用户点重试时，父组件截断 timeline 到该消息（含），实现乐观反馈。
   */
  onRegenerateOptimisticCut: (messageId: string) => void;
  /** 按消息 ID 索引的单次 LLM 调用用量，仅 assistant 消息使用。 */
  usageByMessage?: Record<string, MessageUsage>;
  /** 嵌套模式（子 Agent 卡内）：隐藏头像行/名字/重试/反馈，仅保留内容与工具块。 */
  nested?: boolean;
  /**
   * 只读模式（远程设备历史查看，L2c）：隐藏 AssistantMessageActions /
   * UserMessageActions（重试/反馈/编辑等写操作），保留头像行/名字/工具块。
   * 与 nested 语义正交——nested 是「视觉收窄」，readOnly 是「禁写」。
   */
  readOnly?: boolean;
}

/**
 * 会话消息时间线。Slack 行式：头像 + 名字 + 左对齐内容。
 *
 * 设计原则：
 * - 全局 radius=0（直角），由 design token 强制；
 * - 每条消息以 7×7 头像块 + 粗体名字开头，内容左对齐；
 * - assistant 消息无背景，靠对齐 + 间距区分，避免大色块视觉重量；
 * - reasoning 区无背景，用左侧细竖线低调表示「思考」是从属过程。
 */
export function MessageList({
  messages,
  sessionId,
  running,
  onRegenerateOptimisticCut,
  usageByMessage,
  nested,
  readOnly,
}: MessageListProps) {
  const t = useTranslations("session");
  const user = useAtomValue(currentUserAtom);
  const userName = user?.displayName ?? user?.email ?? t("youName");
  const userInitial = userName.charAt(0).toUpperCase();
  const assistantName = t("assistantName");
  return (
    <div className={cn("flex flex-col gap-1", nested ? "py-1" : "pb-6 pt-2")}>
      {messages
        .filter(
          (m) => !(m.role === "system" && m.metadata?.kind !== "compaction"),
        )
        .map((m) => {
          // 压缩占位行：role=system + metadata.kind="compaction"
          if (m.role === "system" && m.metadata?.kind === "compaction") {
            return (
              <CompactionRow
                key={m.id}
                removedCount={(m.metadata.removedCount as number) ?? 0}
                summary={m.content}
              />
            );
          }
          return (
            <div
              key={m.id}
              className="group relative -mx-2 flex gap-3 rounded px-2 py-1.5 hover:bg-muted/40"
            >
              {!nested &&
                (m.role === "user" ? (
                  <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] bg-[#16a34a] text-[12px] font-semibold text-white">
                    {userInitial}
                  </div>
                ) : (
                  <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] bg-(--shell-accent) text-white">
                    <Sparkles className="h-4 w-4" />
                  </div>
                ))}
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                {!nested && (
                  <div className="text-[13px] font-bold text-foreground">
                    {m.role === "user" ? userName : assistantName}
                  </div>
                )}
                {m.role === "assistant" && m.reasoning ? (
                  <ReasoningBlock
                    text={m.reasoning}
                    startedAt={m.reasoningStartedAt}
                    durationMs={m.reasoningDurationMs}
                    streaming={m.streaming}
                  />
                ) : null}
                {/*
                气泡仅在「有可见正文 / loading / streaming / failed」时出现。
                中间决策轮（仅 reasoning + toolCalls、content 空）不出气泡 —— 否则
                空 div 也算 flex gap-2 一个 item，让「思考过程 ↔ tool 块」之间多一段空白。
                toolCalls 自身有独立块（下方渲染），不靠这里撑场。
              */}
                {(m.role === "user" ||
                  m.content ||
                  m.loading ||
                  m.streaming ||
                  m.failed) && (
                  <div
                    className={cn(
                      "text-sm leading-relaxed text-foreground",
                      m.failed && "text-destructive",
                    )}
                  >
                    {m.loading ? (
                      <TypingDots />
                    ) : (
                      <MarkdownContent
                        text={stripLlmuse(m.content)}
                        streaming={m.role === "assistant" && m.streaming}
                      />
                    )}
                  </div>
                )}
                {m.failed && m.errorText && (
                  <div className="text-xs text-destructive/80">
                    {t("runErrorPrefix")}
                    {m.errorText}
                  </div>
                )}
                {m.role === "assistant" &&
                  m.toolCalls &&
                  m.toolCalls.length > 0 && (
                    <div className="flex flex-col gap-2">
                      {m.toolCalls.map((tc) => (
                        <ToolCallBlock
                          key={tc.toolCallId}
                          tool={tc}
                          sessionId={sessionId}
                        />
                      ))}
                    </div>
                  )}
                {!nested &&
                  !readOnly &&
                  m.role === "assistant" &&
                  m.content &&
                  !m.streaming && (
                    <AssistantMessageActions
                      sessionId={sessionId}
                      messageId={m.id}
                      content={m.content}
                      usage={usageByMessage?.[m.id]}
                      feedback={m.feedback}
                    />
                  )}
                {!nested && !readOnly && m.role === "user" && (
                  <UserMessageActions
                    sessionId={sessionId}
                    messageId={m.id}
                    content={m.content}
                    failed={m.failed}
                    running={running}
                    onOptimisticCut={() => onRegenerateOptimisticCut(m.id)}
                  />
                )}
              </div>
            </div>
          );
        })}
    </div>
  );
}

/** "..." 三点跳动 loading 指示器（等首个 chunk 时显示）。颜色调淡避免视觉重量。 */
function TypingDots() {
  const t = useTranslations("session");
  return (
    <span
      role="status"
      aria-label={t("generatingReply")}
      className="inline-flex items-center gap-1 align-middle"
    >
      <span className="h-1 w-1 animate-bounce rounded-full bg-muted-foreground/40 [animation-delay:-0.3s]" />
      <span className="h-1 w-1 animate-bounce rounded-full bg-muted-foreground/40 [animation-delay:-0.15s]" />
      <span className="h-1 w-1 animate-bounce rounded-full bg-muted-foreground/40" />
    </span>
  );
}

/**
 * 推理过程可展开块。思考中默认展开、思考结束后自动收起；用户也可点击切换。
 * 标签显示「思考中 Xs」/「已思考 Xs」/「思考过程」（历史持久化时没耗时信息）。
 */
function ReasoningBlock({
  text,
  startedAt,
  durationMs,
  streaming,
}: {
  text: string;
  startedAt?: number;
  durationMs?: number;
  /**
   * 父 message 是否在流式中（来自 inflight push 或 ws onChunk 标记）。
   * 为 true 时强制走「思考中」分支 + 默认展开，无视 durationMs ——
   * 刷新落在 reasoning 流式中时 durationMs=0 会被误判为「已思考」，
   * 此 prop 是首要语义信号。
   */
  streaming?: boolean;
}) {
  const t = useTranslations("session");
  const isThinking =
    streaming === true || (durationMs === undefined && startedAt !== undefined);
  // 思考中默认展开；思考一结束自动收起。用户点击切换会覆盖这个默认，
  // 但 isThinking 再变化时会再次同步（下一次新的推理流又会展开）。
  const [open, setOpen] = useState(isThinking);
  useEffect(() => {
    setOpen(isThinking);
  }, [isThinking]);
  // 推理中：每 100ms 重渲染一次以更新「思考中 Xs」秒数显示
  const [, force] = useState(0);
  useEffect(() => {
    if (!isThinking) return;
    const id = setInterval(() => force((n) => n + 1), 100);
    return () => clearInterval(id);
  }, [isThinking]);
  const elapsed = isThinking
    ? startedAt !== undefined
      ? Date.now() - startedAt
      : 0
    : (durationMs ?? 0);
  const label = isThinking
    ? elapsed > 0
      ? t("reasoningThinking", { seconds: (elapsed / 1000).toFixed(1) })
      : t("reasoningThinking", { seconds: "0.0" })
    : elapsed > 0
      ? t("reasoningThought", { seconds: (elapsed / 1000).toFixed(1) })
      : t("reasoningProcess");
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 self-start text-xs text-muted-foreground hover:text-foreground"
        aria-expanded={open}
      >
        <ChevronRight
          className={cn("h-3 w-3 transition-transform", open && "rotate-90")}
        />
        <span>{label}</span>
      </button>
      {open && (
        <div className="whitespace-pre-wrap border-l border-border pl-3 text-xs leading-relaxed text-muted-foreground">
          {text}
        </div>
      )}
    </div>
  );
}
