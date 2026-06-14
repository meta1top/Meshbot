import type { ImMessage } from "@meshbot/types";

interface ImMessageListProps {
  messages: ImMessage[];
  /** userId → sender info, for name and avatar initial */
  members: Record<string, { displayName: string; email: string }>;
  /** current user's id — own messages get a green avatar */
  currentUserId: string;
}

/** Format an ISO date string to HH:MM (local time). */
function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * IM 消息列表。Slack 行式：头像 + 粗体发送者名字 + 时间戳 + 纯文本正文。
 * 纯展示组件，无数据拉取，无 socket。
 */
export function ImMessageList({
  messages,
  members,
  currentUserId,
}: ImMessageListProps) {
  if (messages.length === 0) return null;

  return (
    <div className="flex flex-col gap-5 pb-6">
      {messages.map((m) => {
        const sender = members[m.senderId];
        const displayName = sender?.displayName ?? m.senderId;
        const initial = displayName.charAt(0).toUpperCase();
        const isSelf = m.senderId === currentUserId;

        return (
          <div key={m.id} className="flex gap-3">
            {/* Avatar */}
            <div
              className={[
                "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] text-[12px] font-semibold text-white",
                isSelf ? "bg-[#16a34a]" : "bg-(--shell-accent)",
              ].join(" ")}
            >
              {initial}
            </div>

            {/* Right column */}
            <div className="min-w-0 flex-1">
              {/* Name + timestamp */}
              <div className="mb-1 flex items-baseline gap-2">
                <span className="text-[13px] font-bold text-foreground">
                  {displayName}
                </span>
                <span className="text-[10px] text-muted-foreground">
                  {formatTime(m.createdAt)}
                </span>
              </div>

              {/* Content */}
              <div className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
                {m.content}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
