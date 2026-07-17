"use client";

import type { SessionSummary } from "@meshbot/types-agent";
import {
  SessionTree,
  type SessionTreeLabels,
  type SessionTreeNodeInfo,
} from "@meshbot/web-common/session";
import {
  type NavGroup,
  type NavNode,
  SidebarHeader,
} from "@meshbot/web-common/shell";
import { useAtomValue, useSetAtom } from "jotai";
import { Plus, SquarePen } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  loadRemoteSessionsAtom,
  remoteSessionsAtom,
} from "@/atoms/remote-sessions";
import {
  clearScheduleActivityAtom,
  scheduleActivityAtom,
} from "@/atoms/schedule-activity";
import {
  deleteSessionAtom,
  renameSessionAtom,
  sessionsAtom,
  sessionsStatusAtom,
} from "@/atoms/sessions";
import { loadSidebarAtom } from "@/atoms/sidebar";
import { AgentEditorSheet } from "@/components/agent/agent-editor-sheet";
import { parseAgentAvatar } from "@/lib/agent-avatar";
import { groupSessionsByAgent } from "@/lib/group-sessions-by-agent";
import { shouldShowSidebarSkeleton } from "@/lib/should-show-sidebar-skeleton";
import { useAgents } from "@/rest/agents";
import { useRemoteAgents } from "@/rest/remote-agents";

/** 本地会话 key 前缀（`s:<sessionId>`）。 */
const LOCAL_PREFIX = "s:";
/** 本机 Agent 节点 key 前缀（`ag:<agentId>`）。 */
const AGENT_PREFIX = "ag:";
/** 远程 Agent 节点 key 前缀（`rag:<cloudAgentId>`）。 */
const REMOTE_AGENT_PREFIX = "rag:";

/**
 * 助手二级侧栏：本机 Agent + 远程 Agent 同一扁平列表（本机在前、远程在后，
 * 计划二 2c·B2 D2），去掉「其他设备 → 远程会话」独立设备分区——设备不再是
 * 导航层，远程 Agent 直接以 Agent 身份出现，宿主设备名只作副标题消歧
 * （D1），宿主离线时整行灰化、禁止展开/发起（D3）。每个 Agent 节点展开出
 * 其名下会话：本机会话可内联改名/删除（hover 铅笔），远程会话只读（无铅笔/
 * 无三点菜单）。Agent 列表 / 本地会话 / 远程会话订阅与拉取逻辑全部留在本组件
 * （数据装配），实际树渲染 + 行交互交给共享 `SessionTree`
 * （`@meshbot/web-common/session`）——与 web-main 复用同一份交互逻辑。
 */
export function AssistantSidebar() {
  const t = useTranslations("assistantSidebar");
  const tSessionMenu = useTranslations("appShell.sessionMenu");
  const tDeleteConfirm = useTranslations("appShell.deleteConfirm");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // 当前路由若指向远程会话（?remoteAgent=…&id=…），据此定向展开该远程 Agent
  // 节点并主动触发其会话列表懒加载——否则刷新后节点折叠、列表未拉，无从高亮。
  const urlRemoteAgent = searchParams.get("remoteAgent");
  const urlSessionId = searchParams.get("id");
  const { data: agents, isLoading: agentsLoading } = useAgents();
  const { data: remoteAgents } = useRemoteAgents();
  // 本机全量会话（未按 agent 过滤）——分组本身按 agentId 切（groupSessionsByAgent），
  // 不能在这里前置过滤，否则其他 Agent 的会话永远看不到。
  const localSessions = useAtomValue(sessionsAtom);
  const sessionsStatus = useAtomValue(sessionsStatusAtom);
  const remoteSessions = useAtomValue(remoteSessionsAtom);
  const scheduleActivity = useAtomValue(scheduleActivityAtom);
  const loadSidebar = useSetAtom(loadSidebarAtom);
  const loadRemoteSessions = useSetAtom(loadRemoteSessionsAtom);
  const clearScheduleActivity = useSetAtom(clearScheduleActivityAtom);
  const rename = useSetAtom(renameSessionAtom);
  const removeSession = useSetAtom(deleteSessionAtom);
  const [editor, setEditor] = useState<{
    open: boolean;
    agentId: string | null;
  }>({ open: false, agentId: null });

  useEffect(() => {
    void loadSidebar();
  }, [loadSidebar]);

  // URL 指向的远程 Agent：主动拉会话列表（defaultOpen 只影响树的展开态，
  // 不会走用户交互的 onExpand 回调，懒加载需在此显式触发）。
  useEffect(() => {
    if (urlRemoteAgent) void loadRemoteSessions(urlRemoteAgent);
  }, [urlRemoteAgent, loadRemoteSessions]);

  // 当前激活会话对应的树 key：本地 `s:<id>`，远程 `r:<cloudAgentId>:<id>`。
  // 两者 key 前缀不同、互斥，可安全合一成单个 activeSessionKey 交给
  // SessionTree（驱动高亮 + 祖先 Agent 分支自动展开）。
  const activeSessionKey =
    pathname === "/assistant" && urlSessionId
      ? urlRemoteAgent
        ? `r:${urlRemoteAgent}:${urlSessionId}`
        : `${LOCAL_PREFIX}${urlSessionId}`
      : undefined;

  // 边装配树边登记每个 key 的渲染元数据（同一次 render 内，nodeInfo 回读复用）。
  const metaByKey = new Map<string, SessionTreeNodeInfo>();

  // 本机 Agent → 会话。agents 顺序决定分组顺序；running 脉冲点取自
  // groupSessionsByAgent（该 Agent 名下有 status==="running" 的会话）。
  const agentGroups = groupSessionsByAgent(agents ?? [], localSessions);
  const agentNodes: NavNode[] = (agents ?? []).map((a) => {
    const grp = agentGroups.find((g) => g.agentId === a.id);
    const { emoji, color } = parseAgentAvatar(a.avatar);
    metaByKey.set(`${AGENT_PREFIX}${a.id}`, {
      kind: "agent",
      emoji,
      color,
      name: a.name,
      running: grp?.running ?? false,
    });

    let sessionChildren: NavNode[];
    if (sessionsStatus === "idle" || sessionsStatus === "loading") {
      const key = `ph:${AGENT_PREFIX}${a.id}:load`;
      metaByKey.set(key, { kind: "placeholder", variant: "skeleton" });
      sessionChildren = [{ key, label: "" }];
    } else if ((grp?.sessions.length ?? 0) === 0) {
      const key = `ph:${AGENT_PREFIX}${a.id}:empty`;
      metaByKey.set(key, { kind: "placeholder", variant: "note" });
      sessionChildren = [{ key, label: t("empty") }];
    } else {
      sessionChildren = (grp?.sessions ?? []).map((sn) => {
        const key = `${LOCAL_PREFIX}${sn.id}`;
        metaByKey.set(key, {
          kind: "session",
          title: sn.title,
          editable: true,
          deletable: true,
          hasActivity: scheduleActivity.has(sn.id),
        });
        return {
          key,
          label: sn.title,
          onClick: () => {
            clearScheduleActivity(sn.id);
            router.push(`/assistant?id=${sn.id}`);
          },
        };
      });
    }

    // 祖先自动展开（SidebarNav：`node.defaultOpen ?? isNavNodeActive(...)`）：
    // Agent 节点没有「全局当前」可比，defaultOpen 只看一件事——「含当前 URL
    // 会话的那个 Agent 自动展开」，其余折叠。这个判定还依赖 sessionChildren
    // 在 NavItem **首次挂载**时就是真实数据——`open` 状态只在 mount 时读一次
    // defaultOpen，之后 sessionsStatus 变化不会重新计算，所以下面 SessionTree
    // 的 `loading` 必须把 sessionsStatus 一并纳入（否则 Agent 节点会带着骨架
    // 占位子节点抢先挂载，defaultOpen 判定到空 sessionChildren，永久错过这次
    // 自动展开）。
    const containsActiveSession = sessionChildren.some(
      (c) => c.key === activeSessionKey,
    );
    return {
      key: `${AGENT_PREFIX}${a.id}`,
      label: a.name,
      defaultOpen: containsActiveSession,
      // Agent 行点击只做展开/收起（NavItem 默认行为），不设当前、不高亮——
      // 不传 SessionTree 的 onSelectAgent（该回调已从 web-common 移除）。
      children: sessionChildren,
    };
  });

  // 装配某远程 Agent 的会话子节点。子节点数组恒非空（loading/空/错误各给一个
  // 占位节点），以保证节点 hasChildren=true——chevron 常驻、onExpand 可触发。
  const buildRemoteChildren = (agentId: string): NavNode[] => {
    const rs = remoteSessions[agentId];
    if (!rs || rs.status === "loading") {
      const key = `ph:${agentId}:load`;
      metaByKey.set(key, { kind: "placeholder", variant: "skeleton" });
      return [{ key, label: "" }];
    }
    if (rs.status === "error") {
      const key = `ph:${agentId}:err`;
      metaByKey.set(key, { kind: "placeholder", variant: "note" });
      return [{ key, label: t("remoteLoadFailed") }];
    }
    if (rs.sessions.length === 0) {
      const key = `ph:${agentId}:empty`;
      metaByKey.set(key, { kind: "placeholder", variant: "note" });
      return [{ key, label: t("remoteEmpty") }];
    }
    return rs.sessions.map((s: SessionSummary) => {
      const key = `r:${agentId}:${s.id}`;
      metaByKey.set(key, { kind: "session", title: s.title });
      return {
        key,
        label: s.title,
        onClick: () =>
          router.push(`/assistant?remoteAgent=${agentId}&id=${s.id}`),
      };
    });
  };

  // 远程 Agent（其他设备上已注册）：本机在前、远程在后（D2）。宿主离线的
  // Agent 仍给占位子节点撑出 chevron，但 SessionTree 会把整行 pointer-events
  // 关掉（online:false）——离线不可展开/不可发起（D3）。
  const remoteAgentNodes: NavNode[] = (remoteAgents ?? []).map((ra) => {
    const { emoji, color } = parseAgentAvatar(ra.avatar);
    metaByKey.set(`${REMOTE_AGENT_PREFIX}${ra.id}`, {
      kind: "agent",
      emoji,
      color,
      name: ra.name,
      running: false,
      remote: true,
      deviceName: ra.deviceName,
      online: ra.deviceOnline,
    });
    const children = ra.deviceOnline
      ? buildRemoteChildren(ra.id)
      : [{ key: `ph:${ra.id}:offline`, label: "" }];
    return {
      key: `${REMOTE_AGENT_PREFIX}${ra.id}`,
      label: ra.name,
      defaultOpen: ra.id === urlRemoteAgent,
      children,
    };
  });

  const groups: NavGroup[] = [
    { key: "agents", items: [...agentNodes, ...remoteAgentNodes] },
  ];

  // 展开节点：仅远程 Agent 需要懒加载会话（本机会话已在 sessionsAtom，无需
  // 额外拉取）。SessionTree 的 prop 名仍是 onExpandDevice（设备去掉后语义已
  // 变成「节点展开」，改的只是本地处理函数名）。
  const handleExpandNode = (node: NavNode) => {
    if (!node.key.startsWith(REMOTE_AGENT_PREFIX)) return;
    void loadRemoteSessions(node.key.slice(REMOTE_AGENT_PREFIX.length));
  };

  const onRenameSession = useCallback(
    (node: NavNode, title: string) =>
      rename({ id: node.key.slice(LOCAL_PREFIX.length), title }),
    [rename],
  );

  const onDeleteSession = useCallback(
    async (node: NavNode) => {
      const id = node.key.slice(LOCAL_PREFIX.length);
      await removeSession(id);
      if (activeSessionKey === node.key) router.push("/assistant");
    },
    [removeSession, activeSessionKey, router],
  );

  // Agent 行的编辑铅笔：`ag:<agentId>` 去掉前缀即目标 agentId（远程 Agent
  // 节点不出这个铅笔，SessionTree 的 AgentRow 已按 info.remote 挡住）。
  const onEditAgent = useCallback((node: NavNode) => {
    setEditor({ open: true, agentId: node.key.slice(AGENT_PREFIX.length) });
  }, []);

  const labels: SessionTreeLabels = useMemo(
    () => ({
      offline: t("offline"),
      rename: tSessionMenu("rename"),
      delete: tSessionMenu("delete"),
      deleteConfirmTitle: (title: string) => tDeleteConfirm("title", { title }),
      deleteConfirmDescription: tDeleteConfirm("description"),
      deleteConfirmConfirm: tDeleteConfirm("confirm"),
      deleteConfirmCancel: tDeleteConfirm("cancel"),
      editAgent: t("editAgent"),
    }),
    [t, tSessionMenu, tDeleteConfirm],
  );

  return (
    <div className="flex h-full flex-col">
      <SidebarHeader
        title={t("title")}
        action={
          <button
            type="button"
            title={t("newSession")}
            onClick={() => router.push("/assistant")}
            className="flex h-7 w-7 items-center justify-center rounded-md text-(--shell-sidebar-fg)/70 transition-colors hover:bg-(--shell-sidebar-hover) hover:text-(--shell-sidebar-fg)"
          >
            <SquarePen className="h-4 w-4" />
          </button>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-2">
        <SessionTree
          loading={shouldShowSidebarSkeleton(sessionsStatus, agentsLoading)}
          groups={groups}
          activeSessionKey={activeSessionKey}
          nodeInfo={(node) => metaByKey.get(node.key)}
          onExpandDevice={handleExpandNode}
          onRenameSession={onRenameSession}
          onDeleteSession={onDeleteSession}
          onEditAgent={onEditAgent}
          labels={labels}
        />
      </div>
      <div className="shrink-0 border-t border-border px-3 py-2">
        <button
          type="button"
          onClick={() => setEditor({ open: true, agentId: null })}
          className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-[13px] text-(--shell-sidebar-fg)/70 transition-colors hover:bg-(--shell-sidebar-hover) hover:text-(--shell-sidebar-fg)"
        >
          <Plus className="h-4 w-4" /> {t("newAgent")}
        </button>
      </div>
      <AgentEditorSheet
        agentId={editor.agentId}
        open={editor.open}
        onOpenChange={(open) => setEditor((s) => ({ ...s, open }))}
      />
    </div>
  );
}
