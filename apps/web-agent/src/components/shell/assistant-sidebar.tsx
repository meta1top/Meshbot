"use client";

import type { DeviceView } from "@meshbot/types";
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
  deviceOnlineAtom,
  devicesAtom,
  devicesStatusAtom,
  loadDevicesAtom,
  reprobeOnlineAtom,
} from "@/atoms/devices";
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
import { fetchDeviceOnline } from "@/rest/devices";

/** 本地会话 key 前缀（`s:<sessionId>`）。 */
const LOCAL_PREFIX = "s:";
/** Agent 节点 key 前缀（`ag:<agentId>`）。 */
const AGENT_PREFIX = "ag:";

/**
 * 助手二级侧栏：上区「本机 Agent → 会话」嵌套树 + 下区「其他设备 → 远程会话」
 * 两级树。上区每个 Agent 一个可展开节点（头像 + 名字 + running 脉冲点 +
 * hover 编辑铅笔），子节点是该 Agent 名下的本地会话；下区沿用原有设备树，
 * 去掉本机（本机已展开成上区的 Agent 列表，不再重复出现）。设备列表 / 在线态 /
 * 本地会话 / 远程会话 / Agent 列表的订阅与拉取逻辑全部留在本组件（数据装配），
 * 实际树渲染 + 行交互（改名 / 删除 / 活动小红点 / chevron / 自动展开高亮 /
 * Agent 编辑入口）交给共享 `SessionTree`（`@meshbot/web-common/session`）——
 * 与 web-main 复用同一份交互逻辑。
 */
export function AssistantSidebar() {
  const t = useTranslations("assistantSidebar");
  const tSessionMenu = useTranslations("appShell.sessionMenu");
  const tDeleteConfirm = useTranslations("appShell.deleteConfirm");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // 当前路由若指向远程会话（?remoteDevice=…&id=…），据此定向展开该设备节点
  // 并主动触发其会话列表懒加载——否则刷新后设备折叠、列表未拉，无从高亮。
  const urlRemoteDevice = searchParams.get("remoteDevice");
  const urlSessionId = searchParams.get("id");
  const devices = useAtomValue(devicesAtom);
  const devicesStatus = useAtomValue(devicesStatusAtom);
  const online = useAtomValue(deviceOnlineAtom);
  const { data: agents, isLoading: agentsLoading } = useAgents();
  // 本机全量会话（未按 agent 过滤）——分组本身按 agentId 切（groupSessionsByAgent），
  // 不能在这里前置过滤，否则其他 Agent 的会话永远看不到。
  const localSessions = useAtomValue(sessionsAtom);
  const sessionsStatus = useAtomValue(sessionsStatusAtom);
  const remoteSessions = useAtomValue(remoteSessionsAtom);
  const scheduleActivity = useAtomValue(scheduleActivityAtom);
  const loadDevices = useSetAtom(loadDevicesAtom);
  const loadSidebar = useSetAtom(loadSidebarAtom);
  const reprobeOnline = useSetAtom(reprobeOnlineAtom);
  const loadRemoteSessions = useSetAtom(loadRemoteSessionsAtom);
  const setDeviceOnline = useSetAtom(deviceOnlineAtom);
  const clearScheduleActivity = useSetAtom(clearScheduleActivityAtom);
  const rename = useSetAtom(renameSessionAtom);
  const removeSession = useSetAtom(deleteSessionAtom);
  const [editor, setEditor] = useState<{
    open: boolean;
    agentId: string | null;
  }>({ open: false, agentId: null });

  useEffect(() => {
    void loadSidebar();
    void loadDevices();
  }, [loadSidebar, loadDevices]);

  // URL 指向的远程设备：主动拉会话列表（defaultOpen 只影响树的展开态，
  // 不会走用户交互的 onExpand 回调，懒加载需在此显式触发）。
  useEffect(() => {
    if (urlRemoteDevice) void loadRemoteSessions(urlRemoteDevice);
  }, [urlRemoteDevice, loadRemoteSessions]);

  // Fix2 兜底：设备非干净退出时云端 presence 靠 45s TTL 静默过期、不发离线事件，
  // 侧栏可见期间周期重探在线态纠正之（真正的实时离线事件属服务端后续改进）。
  useEffect(() => {
    const timer = setInterval(() => void reprobeOnline(), 25_000);
    return () => clearInterval(timer);
  }, [reprobeOnline]);

  // 当前激活会话对应的树 key：本地 `s:<id>`，远程 `r:<deviceId>:<id>`。两者 key
  // 前缀不同、互斥，可安全合一成单个 activeSessionKey 交给 SessionTree（驱动
  // 高亮 + 祖先 Agent/设备分支自动展开）。
  const activeSessionKey =
    pathname === "/assistant" && urlSessionId
      ? urlRemoteDevice
        ? `r:${urlRemoteDevice}:${urlSessionId}`
        : `${LOCAL_PREFIX}${urlSessionId}`
      : undefined;

  // 边装配树边登记每个 key 的渲染元数据（同一次 render 内，nodeInfo 回读复用）。
  const metaByKey = new Map<string, SessionTreeNodeInfo>();

  // 上区：本机 Agent → 会话。agents 顺序决定分组顺序；running 脉冲点取自
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
    // 去当前态后，Agent 节点没有「全局当前」可比，defaultOpen 只看一件事——
    // 「含当前 URL 会话的那个 Agent 自动展开」，其余折叠。这个判定还依赖
    // sessionChildren 在 NavItem **首次挂载**时就是真实数据——`open` 状态只在
    // mount 时读一次 defaultOpen，之后 sessionsStatus 变化不会重新计算，所以
    // 下面 SessionTree 的 `loading` 必须把 sessionsStatus 一并纳入（否则设备
    // 先于会话加载完成时，Agent 节点会带着骨架占位子节点抢先挂载，defaultOpen
    // 判定到空 sessionChildren，永久错过这次自动展开）。
    const containsActiveSession = sessionChildren.some(
      (c) => c.key === activeSessionKey,
    );
    return {
      key: `${AGENT_PREFIX}${a.id}`,
      label: a.name,
      defaultOpen: containsActiveSession,
      // 去当前态：Agent 行点击只做展开/收起（NavItem 默认行为），不设当前、
      // 不高亮——不传 SessionTree 的 onSelectAgent（该回调已从 web-common 移除）。
      children: sessionChildren,
    };
  });

  // 装配某设备的会话子节点。子节点数组恒非空（loading/空/错误各给一个占位节点），
  // 以保证设备节点 hasChildren=true——chevron 常驻、onExpand 可触发，与原
  // DeviceNode「离线也显示 chevron」「展开才拉远程」一致。
  const buildChildren = (d: DeviceView): NavNode[] => {
    const rs = remoteSessions[d.id];
    if (!rs || rs.status === "loading") {
      metaByKey.set(`ph:${d.id}:load`, {
        kind: "placeholder",
        variant: "skeleton",
      });
      return [{ key: `ph:${d.id}:load`, label: "" }];
    }
    if (rs.status === "error") {
      metaByKey.set(`ph:${d.id}:err`, { kind: "placeholder", variant: "note" });
      return [{ key: `ph:${d.id}:err`, label: t("remoteLoadFailed") }];
    }
    if (rs.sessions.length === 0) {
      metaByKey.set(`ph:${d.id}:empty`, {
        kind: "placeholder",
        variant: "note",
      });
      return [{ key: `ph:${d.id}:empty`, label: t("remoteEmpty") }];
    }
    return rs.sessions.map((s: SessionSummary) => {
      const key = `r:${d.id}:${s.id}`;
      metaByKey.set(key, { kind: "session", title: s.title });
      return {
        key,
        label: s.title,
        onClick: () =>
          router.push(`/assistant?remoteDevice=${d.id}&id=${s.id}`),
      };
    });
  };

  // 下区：其他设备（去本机——本机已展开成上区的 Agent 列表，不再重复出现）。
  const deviceNodes: NavNode[] = devices
    .filter((d) => !d.revokedAt)
    .filter((d) => !d.isCurrent)
    .map((d) => {
      const isOnline = online[d.id] ?? false;
      const children = buildChildren(d);
      metaByKey.set(`dev:${d.id}`, {
        kind: "device",
        online: isOnline,
        expandable: isOnline,
      });
      return {
        key: `dev:${d.id}`,
        label: d.name,
        defaultOpen: d.id === urlRemoteDevice,
        children,
      };
    });

  const groups: NavGroup[] = [
    { key: "agents", items: agentNodes },
    { key: "devices", items: deviceNodes },
  ];

  // 展开远程设备：按需拉会话列表 + 重探一次在线态（借「用户主动关心这台设备」
  // 的信号刷新在线态，比等下次整页重探更及时）。离线设备不触发（expandable=false
  // 时 chevron 不可点，SidebarNav 不会为它触发 onExpand）。
  const handleExpandDevice = (node: NavNode) => {
    const id = node.key.startsWith("dev:") ? node.key.slice(4) : undefined;
    if (!id) return;
    const device = devices.find((d) => d.id === id);
    if (!device) return;
    void loadRemoteSessions(id);
    fetchDeviceOnline(id)
      .then((v) => setDeviceOnline((m) => ({ ...m, [id]: v })))
      .catch(() => {
        // 探测失败保留原在线态，不强行判离线（避免网络抖动误判）
      });
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

  // Agent 行的编辑铅笔：`ag:<agentId>` 去掉前缀即目标 agentId。
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
        {devicesStatus === "error" ? (
          <div className="px-2 py-1 text-[12px] text-(--shell-sidebar-fg)/55">
            {t("devicesLoadFailed")}
          </div>
        ) : (
          <SessionTree
            loading={shouldShowSidebarSkeleton(
              devicesStatus,
              sessionsStatus,
              agentsLoading,
            )}
            groups={groups}
            activeSessionKey={activeSessionKey}
            nodeInfo={(node) => metaByKey.get(node.key)}
            onExpandDevice={handleExpandDevice}
            onRenameSession={onRenameSession}
            onDeleteSession={onDeleteSession}
            onEditAgent={onEditAgent}
            labels={labels}
          />
        )}
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
