import type { ConversationSummary } from "@meshbot/types";
import type { MemberInfo } from "@meshbot/types-agent";

export interface RecipientGroups {
  channels: ConversationSummary[];
  members: MemberInfo[];
}

/** 过滤「至：」候选：频道按 name，成员按 displayName/email；成员始终排除当前用户。空查询返回全部。 */
export function filterRecipients(
  query: string,
  channels: ConversationSummary[],
  members: MemberInfo[],
  currentUserId: string | null,
): RecipientGroups {
  const q = query.trim().toLowerCase();
  const others = members.filter((m) => m.userId !== currentUserId);
  if (!q) return { channels, members: others };
  return {
    channels: channels.filter((c) => (c.name ?? "").toLowerCase().includes(q)),
    members: others.filter(
      (m) =>
        m.displayName.toLowerCase().includes(q) ||
        m.email.toLowerCase().includes(q),
    ),
  };
}
