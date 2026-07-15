"use client";

import { QUICK_ASSISTANT_NAME_MAX } from "@meshbot/types-agent";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { Sparkles, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  assistantPanelOpenAtom,
  currentQuickSessionIdAtom,
  previewArtifactAtom,
  quickAssistantNameAtom,
} from "@/atoms/assistant-panel";
import {
  sessionTotalsFamily,
  usageByMessageFamily,
} from "@/atoms/session-usage";
import { ChatInput } from "@/components/common/chat-input";
import { ComposerActions } from "@/components/common/composer-actions";
import { DockTabs } from "@/components/im/dock-tabs";
import { MessageList } from "@/components/session/message-list";
import { useChatScroll } from "@/hooks/use-chat-scroll";
import { useLlmusePrefix } from "@/hooks/use-llmuse-prefix";
import { useSessionStream } from "@/hooks/use-session-stream";
import { createLocalSessionTransport } from "@/lib/session-transport";
import { useModelConfigs } from "@/rest/model-config";
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
 *
 * @param chromeless 为真时不渲染自绘的品牌头（RightZone 的统一 tab 条已充当头部），
 *   只保留对话区 + 输入；为假/省略时保持原样（独立使用场景）。
 */
export function AssistantDock({ chromeless }: { chromeless?: boolean } = {}) {
  const t = useTranslations("assistantDock");
  const tChat = useTranslations("chatInput");
  const tSession = useTranslations("session");
  const setOpen = useSetAtom(assistantPanelOpenAtom);
  const [sessionId, setSessionId] = useAtom(currentQuickSessionIdAtom);

  const scrollRef = useRef<HTMLDivElement>(null);
  // 随手问 dock 恒为本机会话（无远程设备概念）；工厂无状态，挂载期稳定即可。
  const transport = useMemo(() => createLocalSessionTransport(), []);
  const stream = useSessionStream(sessionId, scrollRef, transport);

  // token 用量：按本 session 隔离读取（与主会话各读各的，互不串台）；
  // sessionId 未就绪时读空 family（环显示 0/上限，无碍）。
  const usageByMessage = useAtomValue(usageByMessageFamily(sessionId ?? ""));
  const sessionTotals = useAtomValue(sessionTotalsFamily(sessionId ?? ""));
  const { data: modelConfigs } = useModelConfigs();
  const enabledModel = modelConfigs?.find((c) => c.enabled);
  const contextWindow = enabledModel?.contextWindow ?? 128_000;

  // 自动吸底：流式/新消息时跟随到底（与中间会话同套 useChatScroll 逻辑）。
  // dock 无历史分页，hasMore=false → 不挂顶部哨兵 IO（返回的 topSentinelRef 不用）。
  useChatScroll({
    scrollContainerRef: scrollRef,
    messages: stream.messages,
    hasMore: false,
    onLoadMore: () => {},
  });
  const [draft, setDraft] = useState("");

  // 随手问名字：dock 标题，可内联改名；ws renamed 事件（agent / 多窗口改名）实时更新 atom
  const name = useAtomValue(quickAssistantNameAtom);
  const previewArtifact = useAtomValue(previewArtifactAtom);
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
  const prefix = useLlmusePrefix();
  const handleSend = useCallback(
    async (body: string) => {
      const text = prefix(body);
      if (!sessionId) {
        const res = await createSession(text, "quick");
        setSessionId(res.sessionId);
        return;
      }
      await stream.send(text);
    },
    [sessionId, stream, setSessionId, prefix],
  );

  return (
    <div className="flex h-full w-full flex-col">
      {/* 品牌渐变头（高度对齐左侧会话头 h-13）；chromeless 时由外层容器（RightZone）自绘头部承担，这里不渲染 */}
      {!chromeless && (
        <div className="flex h-13 shrink-0 items-center gap-2 border-b border-border bg-[linear-gradient(120deg,#fff3ea,#ffe7ef_45%,#eef2ff)] px-3.5 dark:bg-none">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-(--shell-accent) text-white">
            <Sparkles className="h-3.5 w-3.5" />
          </span>
          {previewArtifact && <DockTabs />}
          {!previewArtifact &&
            (editingName ? (
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
            ))}
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
      )}

      {/* 对话区 */}
      <div
        ref={scrollRef}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-3"
      >
        {sessionId ? (
          <MessageList
            messages={stream.messages}
            sessionId={sessionId}
            running={stream.running}
            usageByMessage={usageByMessage}
            onRegenerateOptimisticCut={() => {}}
            onConfirm={stream.confirm}
            onAnswer={stream.answer}
            // 随手问 dock 恒为默认 Agent 的会话（createSession(text, "quick")
            // 不传 agentId，后端兜底到默认 Agent），但这里手边没有「默认
            // Agent 的 id」这个映射。显式传 undefined 让产物预览走后端
            // resolveOrDefault 兜底到默认 Agent——比传 currentAgentIdAtom
            // （导航条选中态，可能是别的 Agent）更接近真相（Task 12）。
            agentId={undefined}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center px-4 text-center text-[12.5px] text-muted-foreground">
            {t("emptyHint")}
          </div>
        )}
      </div>

      {/* 输入（横向 16 / 底部 16 对齐主会话 layout p-4 + sticky bottom-4） */}
      <div className="px-4 pb-4 pt-2">
        <ChatInput
          value={draft}
          onChange={setDraft}
          onSend={handleSend}
          onInterrupt={stream.interrupt}
          isLoading={stream.running}
          placeholder={t("placeholder")}
          leadingActions={<ComposerActions />}
          tokenUsage={{
            current: sessionTotals.lastInputTokens,
            max: contextWindow,
            breakdown: {
              inputTokens: sessionTotals.inputTokens,
              outputTokens: sessionTotals.outputTokens,
              cacheReadTokens: sessionTotals.cacheReadTokens,
              reasoningTokens: sessionTotals.reasoningTokens,
              callCount: sessionTotals.callCount,
              cumulativeTokens: sessionTotals.totalTokens,
            },
          }}
          labels={{
            attachment: tChat("attachment"),
            interrupt: tChat("interrupt"),
            send: tChat("send"),
            usage: {
              nextRequestLabel: tSession("usage.nextRequestLabel"),
              inputLabel: tSession("usage.inputLabel"),
              cacheLabel: tSession("usage.cacheLabel"),
              outputLabel: tSession("usage.outputLabel"),
              reasoningLabel: tSession("usage.reasoningLabel"),
              cumulativeLabel: tSession("usage.cumulativeLabel"),
              callCount: (count) => tSession("usage.callCount", { count }),
            },
          }}
        />
      </div>
    </div>
  );
}
