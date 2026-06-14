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
    <div className="sticky top-0 z-10 -mx-4 flex h-11 items-center gap-2 border-b border-border bg-(--shell-content) px-4 lg:-mx-10 lg:px-10">
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
  );
}
