"use client";

import { cn } from "@meshbot/design";

/** 时间线上的一条消息（统一视图模型）。 */
export interface TimelineMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  pending?: boolean;
  streaming?: boolean;
}

interface MessageListProps {
  messages: TimelineMessage[];
}

/** 会话消息时间线。user 右对齐，assistant 左对齐。 */
export function MessageList({ messages }: MessageListProps) {
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
          </div>
        ))}
    </div>
  );
}
