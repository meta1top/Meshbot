"use client";

import {
  type RunChunkEvent,
  type RunDoneEvent,
  type RunErrorEvent,
  type RunInterruptedEvent,
  SESSION_WS_EVENTS,
} from "@meshbot/types-agent";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { ChatInput } from "@/components/common/chat-input";
import { AppShellLayout } from "@/components/layouts/app-shell-layout";
import {
  MessageList,
  type TimelineMessage,
} from "@/components/session/message-list";
import { disconnectSessionSocket, getSessionSocket } from "@/lib/socket";
import { appendMessage, fetchHistory, fetchPending } from "@/rest/session";

function SessionView() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const sessionId = searchParams.get("id");
  const [messages, setMessages] = useState<TimelineMessage[]>([]);
  const [running, setRunning] = useState(false);
  const messagesRef = useRef<TimelineMessage[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  /** 单一写入口：同步更新 ref 与 state。 */
  const apply = useCallback(
    (next: (prev: TimelineMessage[]) => TimelineMessage[]) => {
      messagesRef.current = next(messagesRef.current);
      setMessages(messagesRef.current);
    },
    [],
  );

  /** 按 messageId 累加流式 delta；不存在则新建 assistant 气泡。 */
  const upsertChunk = useCallback(
    (messageId: string, delta: string, streaming: boolean) => {
      apply((prev) => {
        const idx = prev.findIndex((m) => m.id === messageId);
        if (idx === -1) {
          return [
            ...prev,
            { id: messageId, role: "assistant", content: delta, streaming },
          ];
        }
        const copy = [...prev];
        const existing = copy[idx];
        copy[idx] = {
          ...existing,
          content: streaming ? existing.content + delta : delta,
          streaming,
        };
        return copy;
      });
    },
    [apply],
  );

  useEffect(() => {
    if (!sessionId) {
      router.replace("/");
      return;
    }
    let cancelled = false;

    void Promise.all([fetchHistory(sessionId), fetchPending(sessionId)]).then(
      ([history, pending]) => {
        if (cancelled) return;
        const initial: TimelineMessage[] = history.messages.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
        }));
        if (history.inflight) {
          setRunning(history.inflight.status === "streaming");
          if (history.inflight.messageId) {
            initial.push({
              id: history.inflight.messageId,
              role: "assistant",
              content: history.inflight.content,
              streaming: history.inflight.status === "streaming",
            });
          }
        }
        for (const p of pending.pending) {
          initial.push({
            id: p.id,
            role: "user",
            content: p.content,
            pending: true,
          });
        }
        // 合并：历史快照打底，但保留 socket 已先到的消息（不被覆盖）
        apply((current) => {
          const initialIds = new Set(initial.map((m) => m.id));
          const socketArrived = current.filter((m) => !initialIds.has(m.id));
          return [...initial, ...socketArrived];
        });
      },
    );

    const socket = getSessionSocket();
    const subscribe = () =>
      socket.emit(SESSION_WS_EVENTS.subscribe, { sessionId });

    const onChunk = (e: RunChunkEvent) => {
      if (e.sessionId !== sessionId) return;
      setRunning(true);
      upsertChunk(e.messageId, e.delta, true);
    };
    const onDone = (e: RunDoneEvent) => {
      if (e.sessionId !== sessionId) return;
      setRunning(false);
      apply((prev) =>
        prev.map((m) =>
          m.id === e.messageId
            ? { ...m, content: e.content, streaming: false }
            : m,
        ),
      );
    };
    const onInterrupted = (e: RunInterruptedEvent) => {
      if (e.sessionId !== sessionId) return;
      setRunning(false);
      apply((prev) =>
        prev.map((m) =>
          m.id === e.messageId ? { ...m, streaming: false } : m,
        ),
      );
    };
    const onError = (e: RunErrorEvent) => {
      if (e.sessionId !== sessionId) return;
      setRunning(false);
      apply((prev) => [
        ...prev,
        {
          id: `err-${crypto.randomUUID()}`,
          role: "assistant",
          content: `出错：${e.error}`,
        },
      ]);
    };

    socket.on("connect", subscribe);
    if (socket.connected) subscribe();
    socket.on(SESSION_WS_EVENTS.runChunk, onChunk);
    socket.on(SESSION_WS_EVENTS.runDone, onDone);
    socket.on(SESSION_WS_EVENTS.runInterrupted, onInterrupted);
    socket.on(SESSION_WS_EVENTS.runError, onError);

    return () => {
      cancelled = true;
      socket.off("connect", subscribe);
      socket.off(SESSION_WS_EVENTS.runChunk, onChunk);
      socket.off(SESSION_WS_EVENTS.runDone, onDone);
      socket.off(SESSION_WS_EVENTS.runInterrupted, onInterrupted);
      socket.off(SESSION_WS_EVENTS.runError, onError);
      disconnectSessionSocket();
    };
  }, [sessionId, router, apply, upsertChunk]);

  /** 新消息或流式增量到达时，平滑滚动到底部。 */
  // biome-ignore lint/correctness/useExhaustiveDependencies: messages 仅作触发依赖，effect 体不直接读取
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  /** 会话页继续发送：立即插 pending 气泡，调追加接口。 */
  const handleSend = useCallback(
    async (msg: string) => {
      if (!sessionId) return;
      const tempId = `local-${Date.now()}`;
      apply((prev) => [
        ...prev,
        { id: tempId, role: "user", content: msg, pending: true },
      ]);
      try {
        await appendMessage(sessionId, msg);
      } catch (err) {
        console.error("追加消息失败", err);
      }
    },
    [sessionId, apply],
  );

  /** Stop 按钮：经 socket 发中断信号。 */
  const handleInterrupt = useCallback(() => {
    if (!sessionId) return;
    getSessionSocket().emit(SESSION_WS_EVENTS.interrupt, { sessionId });
  }, [sessionId]);

  return (
    <AppShellLayout>
      <div className="flex w-full max-w-[620px] flex-1 flex-col">
        <MessageList messages={messages} />
        <div ref={bottomRef} />
      </div>
      <div className="sticky bottom-4 mt-auto bg-background pt-4">
        <ChatInput
          onSend={handleSend}
          onInterrupt={handleInterrupt}
          isLoading={running}
        />
      </div>
    </AppShellLayout>
  );
}

/** 会话页。useSearchParams 需 Suspense 边界（静态导出要求）。 */
export default function SessionPage() {
  return (
    <Suspense fallback={null}>
      <SessionView />
    </Suspense>
  );
}
