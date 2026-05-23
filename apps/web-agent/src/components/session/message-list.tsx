"use client";

import { cn } from "@meshbot/design";
import type { MessageUsage } from "@meshbot/types-agent";

/** 时间线上的一条消息（统一视图模型）。 */
export interface TimelineMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  pending?: boolean;
  streaming?: boolean;
  failed?: boolean;
}

interface MessageListProps {
  messages: TimelineMessage[];
  /** 失败消息「重试」按钮回调。 */
  onRetry?: () => void;
  /** 按消息 ID 索引的单次 LLM 调用用量，仅 assistant 消息使用。 */
  usageByMessage?: Record<string, MessageUsage>;
}

/** 会话消息时间线。user 右对齐，assistant 左对齐。 */
export function MessageList({
  messages,
  onRetry,
  usageByMessage,
}: MessageListProps) {
  return (
    <div className="flex flex-col gap-3">
      {messages
        .filter((m) => m.role !== "system")
        .map((m) => (
          <div
            key={m.id}
            className={cn(
              "max-w-[80%] rounded-lg px-3 py-2 text-sm",
              m.role === "user"
                ? "self-end bg-accent text-foreground"
                : "self-start bg-muted text-foreground",
            )}
          >
            {m.content}
            {m.streaming && (
              <span className="ml-1 animate-pulse text-muted-foreground">
                ▋
              </span>
            )}
            {m.pending && (
              <span className="ml-2 text-xs text-muted-foreground">排队中</span>
            )}
            {m.failed && (
              <span className="ml-2 text-xs text-destructive">
                失败
                <button
                  type="button"
                  onClick={onRetry}
                  className="ml-1 underline hover:text-destructive/80"
                >
                  重试
                </button>
              </span>
            )}
            {m.role === "assistant" && usageByMessage?.[m.id] && (
              <div className="mt-1 text-[11px] text-muted-foreground">
                {renderUsageLine(usageByMessage[m.id])}
              </div>
            )}
          </div>
        ))}
    </div>
  );
}

function renderUsageLine(u: MessageUsage): string {
  const parts: string[] = [`${u.providerType} · ${u.model}`];
  let inputPart = `输入 ${u.inputTokens}`;
  if (u.cacheReadTokens > 0) inputPart += `（缓存 ${u.cacheReadTokens}）`;
  parts.push(inputPart);
  let outputPart = `输出 ${u.outputTokens}`;
  if (u.reasoningTokens > 0) outputPart += `（推理 ${u.reasoningTokens}）`;
  parts.push(outputPart);
  parts.push(`${(u.durationMs / 1000).toFixed(1)}s`);
  return parts.join(" · ");
}
