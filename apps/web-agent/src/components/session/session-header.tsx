"use client";

import { useAtomValue, useSetAtom } from "jotai";
import { Star } from "lucide-react";
import { sessionsAtom, togglePinAtom } from "@/atoms/sessions";

export function SessionHeader({ sessionId }: { sessionId: string }) {
  const sessions = useAtomValue(sessionsAtom);
  const togglePin = useSetAtom(togglePinAtom);
  const session = sessions.find((s) => s.id === sessionId);
  if (!session) return null;
  return (
    <div className="shrink-0 border-b border-border bg-(--shell-content)">
      <div className="flex h-11 w-full items-center gap-2 px-4 lg:px-6">
        <button
          type="button"
          onClick={() =>
            void togglePin({ id: session.id, pinned: !session.pinned })
          }
          className={
            session.pinned
              ? "text-(--shell-accent)"
              : "text-muted-foreground hover:text-foreground"
          }
          aria-pressed={session.pinned}
        >
          <Star
            className="h-4 w-4"
            fill={session.pinned ? "currentColor" : "none"}
          />
        </button>
        <span className="truncate text-[13px] font-semibold text-foreground">
          {session.title}
        </span>
      </div>
    </div>
  );
}
