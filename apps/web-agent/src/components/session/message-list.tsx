"use client";

import { cn } from "@meshbot/design";
import type { MessageUsage } from "@meshbot/types-agent";
import { ChevronRight } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { formatTokens } from "@/lib/format-tokens";
import { MarkdownContent } from "./markdown-content";
import { ToolCallBlock } from "./tool-call-block";
import { UserMessageActions } from "./user-message-actions";

export interface ToolCallView {
  toolCallId: string;
  name: string;
  args: unknown;
  /** 流式累积的 stdout/stderr（仅 bash 等流式 tool）。 */
  progress?: string;
  /** 最终结果（end 后；历史读取也填这里）。 */
  result?: string;
  status: "running" | "ok" | "error";
}

/** 时间线上的一条消息（统一视图模型）。 */
export interface TimelineMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  /** 待处理用户消息（仅 user）：服务端尚未开始调 LLM；渲染在输入框上方 pending 区。 */
  pending?: boolean;
  /** 流式输出中（仅 assistant）：尾部追加闪烁光标。 */
  streaming?: boolean;
  /**
   * 等待首个 chunk 的 assistant 占位（仅 assistant）：
   * 已发出用户消息但 LLM 还没返回任何 token。渲染为转圈。
   */
  loading?: boolean;
  failed?: boolean;
  /** 推理模型的思考过程（仅 assistant）：流式累积，渲染在气泡上方可展开折叠区。 */
  reasoning?: string;
  /**
   * 推理开始时间（毫秒时间戳，仅 assistant）。reasoning 正在流入时显示
   * 「思考中 Xs」；assistant content 开始时切换为「已思考 Xs」固定值。
   */
  reasoningStartedAt?: number;
  /** 推理结束耗时（毫秒，仅 assistant）。设值后认为推理已结束。 */
  reasoningDurationMs?: number;
  toolCalls?: ToolCallView[];
}

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
}

/**
 * 会话消息时间线。user 右对齐（浅 primary 色块），assistant 左对齐（无背景，文档化）。
 *
 * 设计原则：
 * - 全局 radius=0（直角），由 design token 强制；
 * - user 消息用浅色 primary 块强调输入；
 * - assistant 消息无背景，靠对齐 + 间距区分，避免大色块视觉重量；
 * - reasoning 区无背景，用左侧细竖线低调表示「思考」是从属过程。
 */
export function MessageList({
  messages,
  sessionId,
  running,
  onRegenerateOptimisticCut,
  usageByMessage,
}: MessageListProps) {
  const t = useTranslations("session");
  return (
    <div className="flex flex-col gap-8 pb-6">
      {messages
        .filter((m) => m.role !== "system")
        .map((m) => (
          <div
            key={m.id}
            className={cn(
              "group relative flex flex-col gap-3",
              // assistant 固定宽 80%：避免表格 / 长行内容触发容器宽度跳动；
              // user 保持 max-w-[80%] 让气泡贴右沿、按内容自适应
              m.role === "user"
                ? "max-w-[80%] self-end items-end"
                : "w-[80%] self-start",
            )}
          >
            {m.role === "assistant" && m.reasoning ? (
              <ReasoningBlock
                text={m.reasoning}
                startedAt={m.reasoningStartedAt}
                durationMs={m.reasoningDurationMs}
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
                  "text-sm leading-relaxed",
                  m.role === "user"
                    ? cn(
                        "px-3.5 py-2 text-foreground whitespace-pre-wrap",
                        m.failed ? "bg-destructive/8" : "bg-foreground/8",
                      )
                    : "text-foreground",
                )}
              >
                {m.loading ? (
                  <TypingDots />
                ) : m.role === "assistant" ? (
                  <MarkdownContent text={m.content} streaming={m.streaming} />
                ) : (
                  <>
                    {m.content}
                    {m.streaming && (
                      <span className="ml-0.5 inline-block w-[2px] animate-pulse bg-muted-foreground/60 align-middle">
                        &nbsp;
                      </span>
                    )}
                  </>
                )}
              </div>
            )}
            {m.role === "assistant" &&
              m.toolCalls &&
              m.toolCalls.length > 0 && (
                <div className="flex flex-col gap-2">
                  {m.toolCalls.map((tc) => (
                    <ToolCallBlock key={tc.toolCallId} tool={tc} />
                  ))}
                </div>
              )}
            {m.role === "assistant" && m.content && usageByMessage?.[m.id] && (
              <div className="text-[11px] text-muted-foreground">
                {renderUsageLine(usageByMessage[m.id], t)}
              </div>
            )}
            {m.role === "user" && (
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
        ))}
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
}: {
  text: string;
  startedAt?: number;
  durationMs?: number;
}) {
  const t = useTranslations("session");
  const isThinking = durationMs === undefined && startedAt !== undefined;
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
    ? Date.now() - (startedAt ?? Date.now())
    : (durationMs ?? 0);
  const label = isThinking
    ? t("reasoningThinking", { seconds: (elapsed / 1000).toFixed(1) })
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

function renderUsageLine(
  u: MessageUsage,
  t: ReturnType<typeof useTranslations<"session">>,
): string {
  const parts: string[] = [u.model];
  let inputPart = `${t("usage.inputLabel")} ${formatTokens(u.inputTokens)}`;
  if (u.cacheReadTokens > 0) {
    inputPart += `（${t("usage.cacheLabel")} ${formatTokens(u.cacheReadTokens)}）`;
  }
  parts.push(inputPart);
  let outputPart = `${t("usage.outputLabel")} ${formatTokens(u.outputTokens)}`;
  if (u.reasoningTokens > 0) {
    outputPart += `（${t("usage.reasoningLabel")} ${formatTokens(u.reasoningTokens)}）`;
  }
  parts.push(outputPart);
  return parts.join(" · ");
}
