"use client";

import type { SessionSummary } from "@meshbot/types-agent";
import { useAtom, useSetAtom } from "jotai";
import { Clock, Plus, Sparkles, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useRef, useState } from "react";
import {
  assistantPanelOpenAtom,
  currentQuickSessionIdAtom,
} from "@/atoms/assistant-panel";
import { addSessionAtom } from "@/atoms/sessions";
import { ChatInput } from "@/components/common/chat-input";
import { MessageList } from "@/components/session/message-list";
import { useSessionStream } from "@/hooks/use-session-stream";
import {
  createSession,
  fetchQuickSessions,
  promoteSession,
} from "@/rest/session";

export function AssistantDock() {
  const t = useTranslations("assistantDock");
  const setOpen = useSetAtom(assistantPanelOpenAtom);
  const [sessionId, setSessionId] = useAtom(currentQuickSessionIdAtom);
  const addSession = useSetAtom(addSessionAtom);

  const scrollRef = useRef<HTMLDivElement>(null);
  const stream = useSessionStream(sessionId, scrollRef);
  const [draft, setDraft] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<SessionSummary[]>([]);
  const [saved, setSaved] = useState(false);

  // 首条惰性创建 quick 会话；之后走 stream.send
  const handleSend = useCallback(
    async (body: string) => {
      if (!sessionId) {
        const res = await createSession(body, "quick");
        setSessionId(res.sessionId);
        return;
      }
      await stream.send(body);
    },
    [sessionId, stream, setSessionId],
  );

  const handleNew = useCallback(() => {
    setSessionId(null);
    setDraft("");
    setSaved(false);
    setHistoryOpen(false);
  }, [setSessionId]);

  const handleHistory = useCallback(async () => {
    const next = !historyOpen;
    setHistoryOpen(next);
    if (next) setHistory(await fetchQuickSessions());
  }, [historyOpen]);

  const handleSave = useCallback(async () => {
    if (!sessionId) return;
    const summary = await promoteSession(sessionId);
    addSession(summary);
    setSaved(true);
  }, [sessionId, addSession]);

  return (
    <div className="flex h-full w-full flex-col">
      {/* 品牌渐变头 */}
      <div className="flex h-[50px] shrink-0 items-center gap-2 border-b border-border bg-[linear-gradient(120deg,#fff3ea,#ffe7ef_45%,#eef2ff)] px-3.5 dark:bg-none">
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-(--shell-accent) text-white">
          <Sparkles className="h-3.5 w-3.5" />
        </span>
        <div className="flex-1">
          <div className="text-[14px] font-bold text-foreground">
            {t("title")}
          </div>
          <div className="text-[10.5px] text-muted-foreground">
            {t("subtitle")}
          </div>
        </div>
        <button
          type="button"
          onClick={() => void handleHistory()}
          title={t("history")}
          aria-label={t("history")}
          className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-black/5 hover:text-foreground"
        >
          <Clock className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={handleNew}
          title={t("newChat")}
          aria-label={t("newChat")}
          className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-black/5 hover:text-foreground"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          title={t("close")}
          aria-label={t("close")}
          className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-black/5 hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* 历史下拉 */}
      {historyOpen && (
        <div className="max-h-[240px] overflow-y-auto border-b border-border p-1.5">
          {history.length === 0 ? (
            <div className="px-2 py-2 text-[12px] text-muted-foreground">
              {t("emptyHint")}
            </div>
          ) : (
            history.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => {
                  setSessionId(s.id);
                  setHistoryOpen(false);
                  setSaved(false);
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-foreground hover:bg-muted"
              >
                <Sparkles className="h-3.5 w-3.5 shrink-0 opacity-60" />
                <span className="truncate">{s.title}</span>
              </button>
            ))
          )}
        </div>
      )}

      {/* 对话区 */}
      <div
        ref={scrollRef}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3"
      >
        {sessionId ? (
          <>
            <MessageList
              messages={stream.messages}
              sessionId={sessionId}
              running={stream.running}
              onRegenerateOptimisticCut={() => {}}
            />
            {!saved && (
              <button
                type="button"
                onClick={() => void handleSave()}
                className="mt-2 self-start rounded-md border border-(--shell-accent)/40 bg-(--shell-accent)/10 px-2.5 py-1 text-[11.5px] font-medium text-(--shell-accent) hover:bg-(--shell-accent)/15"
              >
                💾 {t("save")}
              </button>
            )}
            {saved && (
              <div className="mt-2 self-start text-[11.5px] text-muted-foreground">
                ✓ {t("saved")}
              </div>
            )}
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center px-4 text-center text-[12.5px] text-muted-foreground">
            {t("emptyHint")}
          </div>
        )}
      </div>

      {/* 输入 */}
      <div className="border-t border-border p-2.5">
        <ChatInput
          value={draft}
          onChange={setDraft}
          onSend={handleSend}
          onInterrupt={stream.interrupt}
          isLoading={stream.running}
          placeholder={t("placeholder")}
        />
      </div>
    </div>
  );
}
