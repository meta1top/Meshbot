"use client";

import { Sparkles } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Suspense, useEffect, useRef, useState } from "react";
import { MessageSkeleton } from "@/components/im/message-skeleton";
import { PageShell } from "@/components/layouts/page-shell";
import { AssistantConversationBody } from "@/components/session/assistant-conversation-body";
import {
  MessageList,
  type TimelineMessage,
} from "@/components/session/message-list";
import { SessionHeader } from "@/components/session/session-header";
import { AssistantSidebar } from "@/components/shell/assistant-sidebar";
import { fetchRemoteHistory } from "@/rest/remote-devices";

/**
 * B 侧 `RemoteQueryInboundService` 直出 `SessionMessageService.listPage()` 的
 * 原始 SessionMessage 行（详见该 service 与 remote-device.controller.ts 的注释），
 * 并非真正的 HistoryMessage：toolCalls / metadata 是未解析的 JSON 字符串，无
 * feedback 字段，且可能混入 role="tool" 行。A 侧 controller 把它 `as` 成
 * HistoryResponse 只是编译期类型糊弄，运行时字段对不上，这里必须防御式映射。
 */
interface RemoteRawMessage {
  id: string;
  role: string;
  content: string;
  reasoning?: string | null;
  /** JSON 字符串，形如 `[{id,name,args}]`（LangChain AIMessage.tool_calls 原始形状）。 */
  toolCalls?: string | null;
  /** JSON 字符串（session_message.metadata 原始列）；压缩占位行携带 kind="compaction"。 */
  metadata?: string | null;
  [key: string]: unknown;
}

interface RemoteRawHistory {
  messages?: RemoteRawMessage[];
  [key: string]: unknown;
}

/**
 * 远程历史单条消息 → TimelineMessage。字段缺失/解析失败一律给默认值，
 * 绝不假设运行时形状与本地 historyMessageToTimeline 的输入一致。
 */
function remoteMessageToTimeline(m: RemoteRawMessage): TimelineMessage {
  let toolCalls: TimelineMessage["toolCalls"];
  if (typeof m.toolCalls === "string" && m.toolCalls) {
    try {
      const parsed = JSON.parse(m.toolCalls) as Array<{
        id?: string;
        toolCallId?: string;
        name?: string;
        args?: unknown;
      }>;
      if (Array.isArray(parsed) && parsed.length > 0) {
        toolCalls = parsed.map((tc) => ({
          toolCallId: tc.toolCallId ?? tc.id ?? "",
          name: tc.name ?? "",
          args: tc.args,
          // 只读历史无「进行中」语义：一律按终态展示，避免误触发确认卡的
          // 可编辑分支（ImSendConfirmCard 等只在 status==="running" 时可写）。
          status: "ok" as const,
        }));
      }
    } catch {
      toolCalls = undefined;
    }
  }
  let metadata: TimelineMessage["metadata"];
  if (typeof m.metadata === "string" && m.metadata) {
    try {
      metadata = JSON.parse(m.metadata) as TimelineMessage["metadata"];
    } catch {
      metadata = undefined;
    }
  }
  return {
    id: String(m.id),
    role: m.role === "user" || m.role === "assistant" ? m.role : "system",
    content: typeof m.content === "string" ? m.content : "",
    ...(m.reasoning ? { reasoning: m.reasoning, reasoningDurationMs: 0 } : {}),
    ...(toolCalls ? { toolCalls } : {}),
    ...(metadata ? { metadata } : {}),
    feedback: null,
  };
}

/** 远程设备会话只读历史视图：拉一次 history，不订阅任何流（非本机会话）。 */
function RemoteSessionView({
  deviceId,
  sessionId,
}: {
  deviceId: string;
  sessionId: string;
}) {
  const t = useTranslations("assistantSidebar");
  const [status, setStatus] = useState<"loading" | "loaded" | "error">(
    "loading",
  );
  const [messages, setMessages] = useState<TimelineMessage[]>([]);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setMessages([]);
    fetchRemoteHistory(deviceId, sessionId)
      .then((res) => {
        if (cancelled) return;
        const raw = (res as unknown as RemoteRawHistory).messages ?? [];
        setMessages(
          raw
            // role="tool" 行是工具执行结果的落库行，不是可展示的时间线消息
            // （本地 controller 的映射同样会过滤掉，见 session.controller.ts）。
            .filter((m) => m.role !== "tool")
            .map(remoteMessageToTimeline),
        );
        setStatus("loaded");
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [deviceId, sessionId]);

  return (
    <div className="flex w-full flex-1 flex-col">
      {status === "loading" ? (
        <MessageSkeleton />
      ) : status === "error" ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          {t("remoteLoadFailed")}
        </div>
      ) : messages.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          {t("remoteEmpty")}
        </div>
      ) : (
        <MessageList
          readOnly
          messages={messages}
          sessionId={sessionId}
          running={false}
          onRegenerateOptimisticCut={() => {}}
        />
      )}
      {/* 禁用态输入区占位：远程会话只读，不触达真实 ChatInput（那是给本机会话用的）。 */}
      <div className="sticky bottom-4 mt-auto w-full bg-background">
        <div className="flex items-center rounded-xl border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
          {t("remoteReadOnly")}
        </div>
      </div>
    </div>
  );
}

/**
 * 远程只读会话的标题栏。不复用 SessionHeader——那个组件按 sessionId 查
 * 本地 sessionsAtom，远程会话 id 在本地找不到，会永远卡在标题骨架上。
 */
function RemoteSessionHeader() {
  const t = useTranslations("assistantSidebar");
  return (
    <div className="shrink-0 bg-(--shell-content)">
      <div className="flex h-13 w-full items-center gap-2 border-b border-border px-4 lg:px-6">
        <Sparkles className="h-4 w-4 shrink-0 text-(--shell-accent)" />
        <span className="truncate text-[15px] font-semibold text-foreground">
          {t("remoteReadOnly")}
        </span>
      </div>
    </div>
  );
}

function AssistantView() {
  const t = useTranslations("assistantSidebar");
  const searchParams = useSearchParams();
  const id = searchParams.get("id");
  const remoteDevice = searchParams.get("remoteDevice");
  const scrollRef = useRef<HTMLDivElement>(null);

  return (
    <PageShell
      sidebar={<AssistantSidebar />}
      scrollContainerRef={scrollRef}
      header={
        remoteDevice && id ? (
          <RemoteSessionHeader />
        ) : id ? (
          <SessionHeader sessionId={id} />
        ) : undefined
      }
    >
      {remoteDevice && id ? (
        <RemoteSessionView deviceId={remoteDevice} sessionId={id} />
      ) : id ? (
        <AssistantConversationBody id={id} scrollRef={scrollRef} />
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          {t("emptyHint")}
        </div>
      )}
    </PageShell>
  );
}

/** /assistant 页。useSearchParams 需 Suspense 边界(静态导出要求)。 */
export default function AssistantPage() {
  return (
    <Suspense fallback={null}>
      <AssistantView />
    </Suspense>
  );
}
