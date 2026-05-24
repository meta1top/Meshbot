"use client";

import type { SessionSummary } from "@meshbot/types-agent";
import { SessionListItem } from "./session-list-item";

interface Props {
  title: string;
  sessions: SessionSummary[];
}

/** 侧边栏一段：标题 + 子项列表。 */
export function SessionListSection({ title, sessions }: Props) {
  return (
    <div className="mt-5">
      <div className="px-2 text-[12px] font-medium text-muted-foreground">
        {title}
      </div>
      <div className="mt-1 space-y-0.5 text-[14px]">
        {sessions.map((s) => (
          <SessionListItem key={s.id} session={s} />
        ))}
      </div>
    </div>
  );
}
