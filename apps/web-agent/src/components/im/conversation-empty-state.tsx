import type { ConversationSummary } from "@meshbot/types";
import { Hash, Lock } from "lucide-react";
import { useTranslations } from "next-intl";

/** 频道/私信无消息时的空状态：频道显示频道名+开始语；私信显示对端头像+名字+开始语。 */
export function ConversationEmptyState({
  conversation,
}: {
  conversation: ConversationSummary;
}) {
  const t = useTranslations("messages");
  const isChannel = conversation.type === "channel";

  if (isChannel) {
    const name = conversation.name ?? "";
    const isPrivate = conversation.visibility === "private";
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-(--shell-accent)/12 text-(--shell-accent)">
          {isPrivate ? (
            <Lock className="h-6 w-6" />
          ) : (
            <Hash className="h-6 w-6" />
          )}
        </div>
        <div className="flex items-center gap-1.5 text-[17px] font-bold text-foreground">
          {isPrivate ? (
            <Lock className="h-4 w-4" />
          ) : (
            <Hash className="h-4 w-4" />
          )}
          <span>{name}</span>
        </div>
        <p className="max-w-sm text-[13px] text-muted-foreground">
          {t("channelStartHint", { name })}
        </p>
      </div>
    );
  }

  const peerName = conversation.peer?.displayName ?? "";
  const initial = (peerName || conversation.peer?.email || "?")
    .charAt(0)
    .toUpperCase();
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-(--shell-accent)/15 text-[24px] font-semibold text-(--shell-accent)">
        {initial}
      </div>
      <div className="text-[17px] font-bold text-foreground">{peerName}</div>
      <p className="max-w-sm text-[13px] text-muted-foreground">
        {t("dmStartHint", { name: peerName })}
      </p>
    </div>
  );
}
