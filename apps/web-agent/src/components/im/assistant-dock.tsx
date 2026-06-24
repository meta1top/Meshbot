"use client";

import { QUICK_ASSISTANT_NAME_MAX } from "@meshbot/types-agent";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { Sparkles, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  assistantPanelOpenAtom,
  currentQuickSessionIdAtom,
  quickAssistantNameAtom,
} from "@/atoms/assistant-panel";
import { ChatInput } from "@/components/common/chat-input";
import { MessageList } from "@/components/session/message-list";
import { useChatScroll } from "@/hooks/use-chat-scroll";
import { useSessionStream } from "@/hooks/use-session-stream";
import {
  fetchQuickAssistantName,
  renameQuickAssistant,
} from "@/rest/quick-assistant";
import { createSession, fetchQuickSessions } from "@/rest/session";

/**
 * 随手问 dock：单一全局会话。
 *
 * 不再有「多会话/历史/新建/保存」——挂载时解析账号唯一的 quick 会话（最新一条即
 * 全局会话），之后永远往它追加；上下文长了由 runner 的 ContextCompactor 自动压缩。
 * 不存在时等首条消息惰性创建，且永不创建第二个。
 */
export function AssistantDock() {
  const t = useTranslations("assistantDock");
  const setOpen = useSetAtom(assistantPanelOpenAtom);
  const [sessionId, setSessionId] = useAtom(currentQuickSessionIdAtom);

  const scrollRef = useRef<HTMLDivElement>(null);
  const stream = useSessionStream(sessionId, scrollRef);

  // 自动吸底：流式/新消息时跟随到底（与中间会话同套 useChatScroll 逻辑）。
  // dock 无历史分页，hasMore=false → 顶部哨兵仅占位、不挂 IO。
  const topSentinelRef = useRef<HTMLDivElement>(null);
  useChatScroll({
    scrollContainerRef: scrollRef,
    topSentinelRef,
    messages: stream.messages,
    hasMore: false,
    onLoadMore: () => {},
  });
  const [draft, setDraft] = useState("");

  // 随手问名字：dock 标题，可内联改名；ws renamed 事件（agent / 多窗口改名）实时更新 atom
  const name = useAtomValue(quickAssistantNameAtom);
  const setName = useSetAtom(quickAssistantNameAtom);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");

  // 首次挂载拉取随手问名字（best-effort）
  useEffect(() => {
    void fetchQuickAssistantName()
      .then(setName)
      .catch(() => {});
  }, [setName]);

  // 解析全局 quick 会话：取账号最新（唯一）的 quick 会话；无则等首条消息创建。
  useEffect(() => {
    if (sessionId) return;
    void fetchQuickSessions()
      .then((list) => {
        if (list[0]) setSessionId(list[0].id);
      })
      .catch(() => {});
  }, [sessionId, setSessionId]);

  const startEditName = useCallback(() => {
    setNameDraft(name);
    setEditingName(true);
  }, [name]);

  const commitName = useCallback(async () => {
    const next = nameDraft.trim();
    setEditingName(false);
    if (!next || next === name) return;
    setName(next); // 乐观更新（服务端 ws renamed 事件随后也会到）
    try {
      await renameQuickAssistant(next);
    } catch {
      void fetchQuickAssistantName()
        .then(setName)
        .catch(() => {});
    }
  }, [nameDraft, name, setName]);

  // 首条惰性创建全局 quick 会话；之后走 stream.send
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

  return (
    <div className="flex h-full w-full flex-col">
      {/* 品牌渐变头（高度对齐左侧会话头 h-11） */}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-[linear-gradient(120deg,#fff3ea,#ffe7ef_45%,#eef2ff)] px-3.5 dark:bg-none">
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-(--shell-accent) text-white">
          <Sparkles className="h-3.5 w-3.5" />
        </span>
        {editingName ? (
          <input
            // biome-ignore lint/a11y/noAutofocus: 点击标题进入编辑，聚焦即用户意图
            autoFocus
            value={nameDraft}
            maxLength={QUICK_ASSISTANT_NAME_MAX}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={() => void commitName()}
            onKeyDown={(e) => {
              if (e.key === "Enter") void commitName();
              else if (e.key === "Escape") setEditingName(false);
            }}
            aria-label={t("rename")}
            className="min-w-0 flex-1 rounded bg-black/5 px-1.5 py-0.5 text-[14px] font-bold text-foreground outline-none focus:bg-black/10 dark:bg-white/10"
          />
        ) : (
          <button
            type="button"
            onClick={startEditName}
            title={t("rename")}
            className="min-w-0 flex-1 truncate text-left text-[14px] font-bold text-foreground hover:opacity-80"
          >
            {name}
          </button>
        )}
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

      {/* 对话区 */}
      <div
        ref={scrollRef}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3"
      >
        {sessionId ? (
          <MessageList
            messages={stream.messages}
            sessionId={sessionId}
            running={stream.running}
            onRegenerateOptimisticCut={() => {}}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center px-4 text-center text-[12.5px] text-muted-foreground">
            {t("emptyHint")}
          </div>
        )}
      </div>

      {/* 输入 */}
      <div className="p-2.5">
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
