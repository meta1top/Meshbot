"use client";

import { useAtomValue, useSetAtom } from "jotai";
import { Sparkles } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Suspense, useEffect, useRef } from "react";
import { activeAssistantSessionAtom } from "@/atoms/active-session";
import { remoteSessionsAtom } from "@/atoms/remote-sessions";
import { PageShell } from "@/components/layouts/page-shell";
import { AssistantConversationBody } from "@/components/session/assistant-conversation-body";
import { SessionHeader } from "@/components/session/session-header";
import { AssistantSidebar } from "@/components/shell/assistant-sidebar";
import { parseAgentAvatar } from "@/lib/agent-avatar";
import { resolveRemoteSessionHeaderView } from "@/lib/remote-session-header";
import { useRemoteAgents } from "@/rest/remote-agents";

/**
 * 远程会话（L3）的标题栏。不复用 SessionHeader——那个组件按 sessionId 查
 * 本地 sessionsAtom，远程会话 id 在本地找不到，会永远卡在标题骨架上。
 *
 * 展示 Agent 名 + 会话标题 + 远程标识（宿主设备名，与侧栏 AgentRow 的
 * `· 宿主设备名` 同一语义）。真机验收缺陷：原实现无条件写死「远程会话」，
 * 现在只在数据没到位（远程 Agent 列表还在拉 / 该会话尚未出现在已加载的会话
 * 列表里）时短暂降级为这句文案（`resolveRemoteSessionHeaderView` 的
 * fallbackTitle），绝不卡骨架、绝不空白——数据一到立刻换成真实标题。
 */
function RemoteSessionHeader({
  agentId,
  sessionId,
}: {
  agentId: string;
  sessionId: string;
}) {
  const t = useTranslations("assistantSidebar");
  const { data: remoteAgents } = useRemoteAgents();
  const remoteSessions = useAtomValue(remoteSessionsAtom);
  const view = resolveRemoteSessionHeaderView({
    agent: remoteAgents?.find((a) => a.id === agentId),
    session: remoteSessions[agentId]?.sessions.find((s) => s.id === sessionId),
    fallbackTitle: t("remoteSessionTitle"),
  });

  return (
    <div className="shrink-0 bg-(--shell-content)">
      <div className="flex h-13 w-full items-center gap-2 border-b border-border px-4 lg:px-6">
        <Sparkles className="h-4 w-4 shrink-0 text-(--shell-accent)" />
        {view.agent ? (
          <span className="flex min-w-0 shrink-0 max-w-[55%] items-center gap-1.5">
            {(() => {
              const { emoji, color } = parseAgentAvatar(view.agent.avatar);
              return (
                <span
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px]"
                  style={{ backgroundColor: color }}
                >
                  {emoji}
                </span>
              );
            })()}
            <span className="truncate text-[13px] font-medium text-foreground/70">
              {view.agent.name}
            </span>
            <span className="min-w-0 truncate text-[11px] text-muted-foreground">
              · {view.agent.deviceName}
            </span>
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-foreground">
          {view.title}
        </span>
      </div>
    </div>
  );
}

function AssistantView() {
  const t = useTranslations("assistantSidebar");
  const searchParams = useSearchParams();
  const id = searchParams.get("id");
  const remoteAgent = searchParams.get("remoteAgent");
  // 远程会话首轮由起手台 create 发起时带入的 streamId：该会话页尚未自己发过
  // 追加消息前，中断只能靠这个 streamId 路由到 B（见 useSessionStream 注释）。
  const streamId = searchParams.get("streamId");
  const scrollRef = useRef<HTMLDivElement>(null);
  const setActiveSession = useSetAtom(activeAssistantSessionAtom);

  // 主内容区当前展示的会话同步进跨组件 atom：全局事件总线（挂在 shell
  // layout，够不到这里的路由参数）据此判断「刚到达的 session.deleted 事件是
  // 不是打在用户正盯着看的这个会话上」（真机验收缺陷：删除会话后侧栏行消失
  // 了，主内容区却还在显示已删除的对话，见 use-global-events.ts）。卸载 /
  // id 变化时清空——不清的话，离开会话页后 activeAssistantSessionAtom 仍
  // 指向旧会话，之后收到的删除事件会误判成「用户还在看」。
  useEffect(() => {
    setActiveSession(id ? { id, remoteAgentId: remoteAgent } : null);
    return () => setActiveSession(null);
  }, [id, remoteAgent, setActiveSession]);

  return (
    <PageShell
      sidebar={<AssistantSidebar />}
      scrollContainerRef={scrollRef}
      header={
        remoteAgent && id ? (
          <RemoteSessionHeader agentId={remoteAgent} sessionId={id} />
        ) : id ? (
          <SessionHeader sessionId={id} />
        ) : undefined
      }
    >
      {remoteAgent && id ? (
        <AssistantConversationBody
          id={id}
          scrollRef={scrollRef}
          remoteAgentId={remoteAgent}
          remoteInitialStreamId={streamId}
        />
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
