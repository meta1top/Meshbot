"use client";

import type { ChannelMember } from "@meshbot/types";
import { useAtomValue } from "jotai";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { currentConversationIdAtom } from "@/atoms/im";
import { listChannelMembers } from "@/rest/im";

/** 成员上下文面板:当前频道成员列表。 */
export function MembersPanel() {
  const t = useTranslations("rightZone");
  const convId = useAtomValue(currentConversationIdAtom);
  const [members, setMembers] = useState<ChannelMember[] | null>(null);

  useEffect(() => {
    if (!convId) {
      setMembers(null);
      return;
    }
    let alive = true;
    listChannelMembers(convId)
      .then((m) => {
        if (alive) setMembers(m);
      })
      .catch(() => {
        if (alive) setMembers([]);
      });
    return () => {
      alive = false;
    };
  }, [convId]);

  if (!convId) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-[12px] text-muted-foreground">
        {t("membersEmpty")}
      </div>
    );
  }
  return (
    <div className="h-full overflow-y-auto p-3">
      {(members ?? []).map((m) => {
        const name = m.displayName ?? m.userId;
        const initial = (name || "?").charAt(0).toUpperCase();
        return (
          <div
            key={m.userId}
            className="mb-1 flex items-center gap-2.5 px-1 py-1.5"
          >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-[12px] font-semibold text-foreground">
              {initial}
            </span>
            <span className="truncate text-[13px] text-foreground">{name}</span>
          </div>
        );
      })}
    </div>
  );
}
