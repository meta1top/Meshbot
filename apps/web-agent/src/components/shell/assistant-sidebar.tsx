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
  readExpandedKeys,
  SidebarHeader,
  writeExpandedKeys,
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
import { useRemoteAgentLifecycleWatch } from "@/hooks/use-remote-agent-lifecycle-watch";
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
/** Agent 展开态持久化的 localStorage key（与 web-main 分开：两端 Agent key
 *  命名空间不同，`ag:`/`rag:` 前缀不通用）。 */
const EXPANDED_STORAGE_KEY = "meshbot.sidebarExpandedAgents";

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

  // 本机 Agent 分组（agents 顺序决定分组顺序；running 脉冲点取自其中）。提前
  // 到这里计算：下面「URL 指向的本机会话 → 反查所属 Agent」要用它，不依赖
  // agentNodes 装配循环产出的 sessionChildren（那是渲染期产物）。
  const agentGroups = groupSessionsByAgent(agents ?? [], localSessions);

  // Agent 展开态：受控 + localStorage 持久化（真机验收缺陷——刷新后手动展开
  // 的 Agent 全部塌回去，此前唯一权威是 NavItem 内部 useState，只在 mount
  // 时读一次 defaultOpen）。初值必须是空集，不能同步读 localStorage 当初值：
  // 受控态下这一拍延迟完全无害（下面 effect 里 union 进来，重渲染即展开），
  // 而如果图省事把 localStorage 塞进 useState 初值，一旦这段代码将来挪去
  // SSR 场景（web-main 是 SSR 应用）就会 hydration mismatch——两端统一按这个
  // 更安全的写法来，不因为 web-agent 目前是纯 CSR 桌面壳就抄近路。
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const stored = readExpandedKeys(EXPANDED_STORAGE_KEY);
    if (stored.size) setExpanded((prev) => new Set([...prev, ...stored]));
  }, []);

  // Review M-5：Agent 删除后，其展开态 key 若不清理会永久留在 localStorage
  // （落盘集合只增不减）。按当前 Agent 全集（本机 + 远程）求交集，把已经不
  // 存在的 key 从 expanded 里摘掉并重新落盘。agents/remoteAgents 任一还没
  // 加载完成（undefined）时提前返回、不做任何裁剪——不能拿还没到位的空列表
  // 当「当前 Agent 都不存在」，把刚从 localStorage 恢复回来的展开态误删。
  // writeExpandedKeys 是普通语句、不嵌在 setState updater 内部（Review
  // M-3：updater 应为纯函数，嵌入副作用在 StrictMode 下会因 updater 被双调用
  // 而重复写盘）。
  useEffect(() => {
    if (!agents || !remoteAgents) return;
    const known = new Set([
      ...agents.map((a) => `${AGENT_PREFIX}${a.id}`),
      ...remoteAgents.map((r) => `${REMOTE_AGENT_PREFIX}${r.id}`),
    ]);
    const keep = [...expanded].filter((k) => known.has(k));
    if (keep.length === expanded.size) return;
    const next = new Set(keep);
    writeExpandedKeys(EXPANDED_STORAGE_KEY, next);
    setExpanded(next);
  }, [agents, remoteAgents, expanded]);

  // URL 指向的 Agent key：远程 `rag:<id>`，本机会话反查其所属 Agent 拼
  // `ag:<id>`——直接查 agentGroups，不依赖 sessionChildren 装配结果。
  const urlLocalAgentId = urlSessionId
    ? agentGroups.find((g) => g.sessions.some((s) => s.id === urlSessionId))
        ?.agentId
    : undefined;
  const urlAgentKey = urlRemoteAgent
    ? `${REMOTE_AGENT_PREFIX}${urlRemoteAgent}`
    : urlLocalAgentId
      ? `${AGENT_PREFIX}${urlLocalAgentId}`
      : undefined;
  // URL 指向的 Agent 自动并入展开集合——agent id 变化（切换会话/直达链接）时
  // 重新触发，用户仍可在此之后手动收起（并入是一次性动作，不是持续钉住）。
  useEffect(() => {
    if (!urlAgentKey) return;
    setExpanded((prev) =>
      prev.has(urlAgentKey) ? prev : new Set(prev).add(urlAgentKey),
    );
  }, [urlAgentKey]);

  // Review C-1：远程会话拉取是事件驱动的，loadRemoteSessions 只有三个既有
  // 触发点——urlRemoteAgent 的 effect（下面）、用户点击触发的 onExpand
  // （handleExpandNode）、以及远程会话正文页自己的加载逻辑。从 localStorage
  // 恢复展开态、以及上面 M-5 的裁剪都会把 `rag:` key 直接并入 expanded，完全
  // 绕开这三个触发点：`open=true` 但 `remoteSessions[id]` 因 atom 刷新已重置为
  // undefined，没有任何代码会再去拉，骨架占位子行会永久卡住。这里对 expanded
  // 里所有 `rag:` key 补一次拉取，只对宿主在线的远程 Agent 触发（离线 Agent
  // `children` 恒空数组，拉了也没地方渲染）。loadRemoteSessionsAtom 自身已有
  // loading/loaded 短路（见 atoms/remote-sessions.ts），这里不需要再叠一层
  // 去重守卫——多次调用（包括与 urlRemoteAgent effect、用户 onExpand 重叠）
  // 都是安全的空操作。
  useEffect(() => {
    for (const key of expanded) {
      if (!key.startsWith(REMOTE_AGENT_PREFIX)) continue;
      const agentId = key.slice(REMOTE_AGENT_PREFIX.length);
      const ra = remoteAgents?.find((r) => r.id === agentId);
      if (ra?.deviceOnline) void loadRemoteSessions(agentId);
    }
  }, [expanded, remoteAgents, loadRemoteSessions]);

  // Agent 级观察通道（T18/T19 · 消费端 T19b）：对每个「已展开 且 宿主在线」
  // 的远程 Agent 建一路 `watchAgent`，让云端开始下发该 Agent 的会话生命周期
  // 镜像事件——事件本身落进 `remoteSessionsAtom` 走的是另一条路径（全局事件
  // 总线 `use-global-events.ts`），本调用只管 watch 的注册/注销生命周期，见
  // `useRemoteAgentLifecycleWatch` 类文档。`targets` 是每次渲染新建的数组，
  // 这是安全的——hook 内部按稳定字符串 key 驱动 effect，不直接依赖数组引用。
  useRemoteAgentLifecycleWatch(
    (remoteAgents ?? [])
      .filter((ra) => expanded.has(`${REMOTE_AGENT_PREFIX}${ra.id}`))
      .map((ra) => ({ agentId: ra.id, online: ra.deviceOnline })),
  );

  // 展开态变化（开/合都触发）：更新 expanded + 落盘持久化。Review M-4：只有
  // Agent 节点（本机 `ag:`/远程 `rag:`）的展开态值得落盘，校验前缀，避免未来
  // 若有非 Agent 节点接了这个 onToggle 把无关 key 混进展开集合。Review
  // M-3：写盘是普通语句，不嵌在 setState updater 内部——updater 应为纯函数，
  // StrictMode 下会双调用，副作用嵌进去就是重复写盘；这里直接基于闭包里的
  // expanded 计算 next（不用函数式更新），这个回调只由用户点击触发，不存在
  // 需要函数式更新规避的并发场景。
  const handleToggleAgent = useCallback(
    (node: NavNode, open: boolean) => {
      const isAgentKey =
        node.key.startsWith(AGENT_PREFIX) ||
        node.key.startsWith(REMOTE_AGENT_PREFIX);
      if (!isAgentKey) return;
      const next = new Set(expanded);
      if (open) next.add(node.key);
      else next.delete(node.key);
      writeExpandedKeys(EXPANDED_STORAGE_KEY, next);
      setExpanded(next);
    },
    [expanded],
  );

  useEffect(() => {
    void loadSidebar();
  }, [loadSidebar]);

  // URL 指向的远程 Agent：主动拉会话列表（受控展开态只决定树上是否画出子
  // 节点，不会走用户交互的 onExpand 回调，懒加载需在此显式触发）。
  useEffect(() => {
    if (urlRemoteAgent) void loadRemoteSessions(urlRemoteAgent);
  }, [urlRemoteAgent, loadRemoteSessions]);

  // 当前激活会话对应的树 key：本地 `s:<id>`，远程 `r:<cloudAgentId>:<id>`。
  // 两者 key 前缀不同、互斥，可安全合一成单个 activeSessionKey 交给
  // SessionTree（仅用于高亮——Agent 分支展开态已全量受控，不再靠这个 key
  // 驱动自动展开，见 session-tree.tsx 的 activeSessionKey JSDoc）。
  const activeSessionKey =
    pathname === "/assistant" && urlSessionId
      ? urlRemoteAgent
        ? `r:${urlRemoteAgent}:${urlSessionId}`
        : `${LOCAL_PREFIX}${urlSessionId}`
      : undefined;

  // 边装配树边登记每个 key 的渲染元数据（同一次 render 内，nodeInfo 回读复用）。
  const metaByKey = new Map<string, SessionTreeNodeInfo>();

  // 本机 Agent → 会话（agentGroups 已在组件顶部提前算好）。
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

    // 展开态已提升为受控（组件顶部 expanded state + 两个 effect：localStorage
    // 持久化 + URL 指向的 Agent 自动并入），不再靠 defaultOpen 在 NavItem
    // **首次挂载**时读一次——这也是为什么下面 SessionTree 的 `loading` 仍要把
    // sessionsStatus 纳入：不是为了凑 defaultOpen 的挂载时机（那个竞态受控化
    // 之后已经不存在，open 变化随时触发重渲染），而是纯粹为了防闪烁——不然
    // Agent 节点会先带着骨架占位子节点渲染一帧，sessionsStatus 到位后再整体
    // 换成真实会话，肉眼可见一次跳动。
    return {
      key: `${AGENT_PREFIX}${a.id}`,
      label: a.name,
      open: expanded.has(`${AGENT_PREFIX}${a.id}`),
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

  // 远程 Agent（其他设备上已注册）：本机在前、远程在后（D2）。宿主离线时
  // 不产出任何子节点（`children` 恒空数组）——防的是幽灵子行（Review
  // Finding #1：URL 直达离线 Agent 时 defaultOpen 曾经为真，占位子行渲染在
  // AgentRow 灰化包裹之外、未置灰可 hover）。这条防线保留在 `children` 上；
  // 至于 `open`，受控化之后不再单独按 `ra.deviceOnline` 门控——曾在线时展开
  // 过、被记进 expanded 集合的 Agent 转离线后 `open` 实际可能仍是 true（见下
  // 面的行内注释）。这本身是安全的：`NavItem` 只有 `hasChildren && open` 同
  // 时为真才画子节点区块，`hasChildren` 已经因 `children` 恒空数组而为假，
  // `open` 是否为真不影响是否泄漏子行，因此无需再对 `open` 额外 && 一次
  // `ra.deviceOnline`。改的是 chevron：`children` 恒空数组本会连带
  // `hasChildren` 为假，NavItem 索性连 chevron 都不画，导致离线行图标位只剩
  // 头像、比在线行少一格 chevron 宽度，整列参差（真机验收缺陷）。修法不是把
  // children 填回去（正是上面要杜绝的幽灵子行写法），而是单独传
  // `chevronPlaceholder: true`——NavItem 在没有 children 的前提下画一个灰化、
  // 恒折叠、不可点的占位 chevron，只对齐左缘。SessionTree 侧仍会把整行
  // pointer-events 关掉（online:false）+ 显示「离线」徽标，用户能看到该
  // Agent 离线，只是展不开（D3）。
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
    // 展开态同样受控（expanded.has）：即便某个 Agent key 曾在线时展开过、被
    // 记进 expanded 集合，宿主转离线后 children 恒空数组，NavItem 的
    // `hasChildren && open` 两者都要真才画子节点区块——hasChildren 已经是
    // 假，open 是否为真不影响是否泄漏子行，无需在这里再对 expanded.has 结果
    // 额外 && ra.deviceOnline 一次。
    return {
      key: `${REMOTE_AGENT_PREFIX}${ra.id}`,
      label: ra.name,
      open: expanded.has(`${REMOTE_AGENT_PREFIX}${ra.id}`),
      children: ra.deviceOnline ? buildRemoteChildren(ra.id) : [],
      chevronPlaceholder: !ra.deviceOnline,
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
          onToggle={handleToggleAgent}
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
