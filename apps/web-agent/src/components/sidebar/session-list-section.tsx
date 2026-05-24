"use client";

import type { SessionSummary } from "@meshbot/types-agent";
import { SessionListItem } from "./session-list-item";

interface Props {
  title: string;
  sessions: SessionSummary[];
  /** 列表为空时显示的占位文案；不传则空列表不渲染任何占位（pinned 段就这样）。 */
  emptyText?: string;
}

/** 侧边栏一段：标题 + 子项列表 + 空态占位。 */
export function SessionListSection({ title, sessions, emptyText }: Props) {
  return (
    <div className="mt-5">
      <div className="px-2 text-[12px] font-medium text-muted-foreground">
        {title}
      </div>
      <div className="mt-1 space-y-0.5 text-[14px]">
        {sessions.length > 0 ? (
          sessions.map((s) => <SessionListItem key={s.id} session={s} />)
        ) : emptyText ? (
          <div className="px-2 py-1.5 text-[12px] text-muted-foreground/60">
            {emptyText}
          </div>
        ) : null}
      </div>
    </div>
  );
}
