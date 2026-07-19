"use client";

import { cn } from "@meshbot/design";
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
import { useQueries } from "@tanstack/react-query";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { computeAgentNodeExpansion } from "@/components/assistant/agent-node-expansion";
import { useSidebarSlot } from "@/components/shell/sidebar-slot-context";
import { remoteSessionsQueryKey } from "@/hooks/use-remote-sessions";
import { parseAgentAvatar } from "@/lib/agent-avatar";
import { remoteQuery } from "@/lib/device-query";
import {
  deviceOnlineQueryKey,
  fetchDeviceOnline,
  useDevicePresenceSync,
} from "@/rest/agent-devices";
import { useAgentRegistrySync, useAgents } from "@/rest/agents";
import { useDevices } from "@/rest/devices";

/** 会话叶子 key 前缀（`session:<sessionId>`）。 */
const SESSION_PREFIX = "session:";
/** Agent 节点 key 前缀（`agent:<cloudAgentId>`）。 */
const AGENT_PREFIX = "agent:";
/** Agent 展开态持久化的 localStorage key（与 web-agent 分开：两端 Agent id
 *  命名空间不同，云端 agent id 和本机 ag:/rag: 前缀不通用）。 */
const EXPANDED_STORAGE_KEY = "meshbot.mainSidebarExpandedAgents";

/**
 * 助手区侧栏：扁平 Agent 列表 → 展开该 Agent 的远程会话（数据装配层，实际树
 * 渲染 + 会话行交给共享 `SessionTree`，`@meshbot/web-common/session`，与
 * web-agent 复用同一份交互逻辑）。
 *
 * 渲染进助手段的持久 layout（`(shell)/assistant/layout.tsx`），因此展开态
 * （`expanded` useState，现已额外落 localStorage，刷新也不丢——真机验收缺陷）
 * 与已加载会话（React Query 缓存）在 `/assistant` ↔ `/assistant/[agentId]`
 * 间导航时不丢——不像旧的「点设备跳独立页」会 remount。
 *
 * 计划二 2c · Task 6：拍平侧栏 IA——删掉「按宿主设备分组 + 每设备取一个展示
 * Agent 做展示↔寻址换算」这一层（曾是 2b · T7 路由改 `[agentId]` 后的过渡期
 * 最小改法：一级按设备分组，设备节点展开时用该设备下最早注册的一个 Agent
 * 反查出寻址用的云端 Agent id）。那一层换算隐含「一设备只有一个可展示 Agent」
 * 的假设，一旦某设备注册了多个 Agent，点设备节点展开出的会话永远是同一个
 * Agent 的、其余 Agent 无从访问；更直接的坏味道（#11）是：那一层换算依赖
 * Agent 列表异步到位，首帧渲染时展开目标还没算出来，设备节点点开后会话子
 * 节点拿不到寻址目标就摆一个永久 skeleton 占位——Agent 列表到位后也不会重新
 * 触发该节点的懒加载（只有展开集合变化才重新装配会话子节点），骨架永远摆着。
 * 拍平后一级直接是 Agent 节点（`useAgents()` 本身就是云端 agent 列表，不需要
 * 经设备反查），寻址目标从数据源直接拿到、不存在异步换算的中间态，骨架问题
 * 随换算层一起消失。
 *
 * - 一级 = 当前账号全部已注册 Agent（在线点 + 头像 + 名字），web-main 无本机
 *   Agent，全部带宿主设备名副标题（`useDevices()` 按 `agent.deviceId` 反查）+
 *   宿主离线灰化（整行 `pointer-events-none`，交给 `SessionTree` 的
 *   `AgentRow`）；
 * - 展开在线 Agent → 并入 `expanded` → `useQueries` 按该 Agent id 懒加载会话
 *   内联铺开，多个 Agent 可同时展开；
 * - 路由携带 `agentId`（`/assistant/[agentId]`）时主动把它并入 `expanded`
 *   （懒加载其会话列表）；`expanded` 是受控展开态的唯一权威——`NavNode.open`
 *   直接读它，不再依赖 `SidebarNav` 内部只在 mount 时读一次的 `defaultOpen`
 *   局部 state，`expanded` 事后变化（路由切换、localStorage 异步读回、用户
 *   手动展开/收起）都会即时反映到树上，不存在「必须在首次挂载前就位」的
 *   竞态；
 * - `expanded` 额外落 localStorage（刷新 / 重新打开页面后手动展开过的 Agent
 *   还在，真机验收缺陷）：初值是空集，mount 后的 effect 里读出来并入，避免
 *   同步读 localStorage 当 `useState` 初值在 SSR 首屏与客户端 hydrate 之间
 *   产生 mismatch；
 * - 点会话叶子 → `/assistant/[agentId]?session=<id>` 打开主区；
 * - Agent 行不出「新建会话」按钮（不注入 `onNewSession`）：新会话统一从
 *   `/assistant` 起手台发起（选 Agent + 写第一句），Agent 行只负责展开会话列表；
 * - 会话全部远程只读（wire protocol 未提供 rename/delete 能力）：不传
 *   `onRenameSession`/`onDeleteSession`；远程 Agent 无法从侧栏编辑人设：不传
 *   `onEditAgent`（`SessionTree` 的 `AgentRow` 按 `info.remote` 自动不出铅笔）。
 */
export function AssistantSidebar() {
  const t = useTranslations("assistantSidebar");
  const tDevices = useTranslations("devices");
  const router = useRouter();
  const slot = useSidebarSlot();
  const searchParams = useSearchParams();
  const activeSessionId = searchParams.get("session");
  const routeParams = useParams<{ agentId?: string }>();
  const routeAgentId = routeParams?.agentId;

  const {
    data: agents,
    isPending: agentsPending,
    error: agentsError,
  } = useAgents();
  const {
    data: allDevices,
    isPending: devicesPending,
    error: devicesError,
  } = useDevices();
  // 两个查询都要落定才能判「真的空」——只等设备列表会在 agents 仍在途时把
  // 尚未到位的空数组误判成空态，闪一下「暂无 Agent」（devices 通常比 agents
  // 先返回：Launcher 与本侧栏各自触发 GET，无共享预取）。
  const isPending = devicesPending || agentsPending;
  // agentList（useAgents）是侧栏一级列表唯一主数据源，devices 只用来查宿主
  // 设备名副标题——任一失败都要显「加载失败」，不能只看 devices 的 error
  // 而让 agents 单独失败时被空态盖掉，误导成「账号下没有 Agent」。
  const error = agentsError ?? devicesError;
  useDevicePresenceSync();
  // 侧栏是助手段持久 layout 里始终挂载的组件（导航切会话不 remount），是
  // agent 列表实时订阅的自然挂载点——覆盖 /assistant 起手台（Launcher 同一份
  // AGENTS_QUERY_KEY 缓存）与 /assistant/[agentId] 详情页，单处订阅即可全覆盖。
  useAgentRegistrySync();

  const devices = useMemo(
    () => (allDevices ?? []).filter((d) => !d.revokedAt),
    [allDevices],
  );
  const deviceNameById = useMemo(
    () => new Map(devices.map((d) => [d.id, d.name])),
    [devices],
  );

  const agentList = useMemo(() => agents ?? [], [agents]);

  // 每个 Agent 宿主设备的在线态（一次并行；presence 事件写同一缓存键，跨
  // Agent 节点、设备管理页复用同一 queryKey）。
  const distinctDeviceIds = useMemo(
    () => [...new Set(agentList.map((a) => a.deviceId))],
    [agentList],
  );
  const onlineQueries = useQueries({
    queries: distinctDeviceIds.map((deviceId) => ({
      queryKey: deviceOnlineQueryKey(deviceId),
      queryFn: () => fetchDeviceOnline(deviceId),
      staleTime: 30_000,
    })),
  });
  const onlineByDevice = new Map(
    distinctDeviceIds.map((id, i) => [
      id,
      onlineQueries[i]?.data?.online ?? false,
    ]),
  );
  const isAgentOnline = (a: { deviceId: string }) =>
    onlineByDevice.get(a.deviceId) ?? false;

  // 已展开 Agent id 集合——受控展开态的唯一权威，同时驱动 useQueries 懒加载 +
  // NavNode.open + localStorage 持久化。组件挂持久 layout，导航切会话不重置。
  // 初值必须是空集：这是 SSR 应用，同步读 localStorage 当 useState 初值会让
  // 服务端首屏渲染结果和客户端 hydrate 后的值对不上（hydration mismatch）；
  // 受控展开态下这一拍延迟无害——localStorage/路由 agentId 在下面两个 effect
  // 里并入后，重渲染即展开，不像过去 NavItem 局部 state 只在 mount 时读一次
  // defaultOpen 那样必须赶在首次挂载前就位。
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  // 从 localStorage 读入用户上次展开的 Agent 集合。
  useEffect(() => {
    const stored = readExpandedKeys(EXPANDED_STORAGE_KEY);
    if (stored.size) setExpanded((prev) => new Set([...prev, ...stored]));
  }, []);

  // 路由携带的 agentId（首帧直达 / 持久 layout 内后续导航到另一 Agent，
  // routeAgentId 变化但组件不 remount）自动并入 expanded——用户之后仍可
  // 手动收起该 Agent（并入是一次性动作，不是持续钉住，见下面 handleToggleAgent
  // 的用户诉求：不能让收起被自动展开逻辑立刻打回）。
  useEffect(() => {
    if (!routeAgentId) return;
    setExpanded((prev) =>
      prev.has(routeAgentId) ? prev : new Set(prev).add(routeAgentId),
    );
  }, [routeAgentId]);

  // Review M-5：Agent 删除后，其展开态 id 若不清理会永久留在 localStorage
  // （落盘集合只增不减）。按当前 Agent 全集求交集，把已经不存在的 id 从
  // expanded 里摘掉并重新落盘。agents 还没加载完成（agentsPending）时提前
  // 返回、不做任何裁剪——不能拿还没到位的 agentList（`agents ?? []` 兜底出的
  // 空数组）当「当前 Agent 都不存在」，把刚从 localStorage 恢复回来的展开态
  // 误删。写盘发生在 setState 之外，理由同下面 handleToggleAgent 的 M-3 注释。
  useEffect(() => {
    if (agentsPending) return;
    const known = new Set(agentList.map((a) => a.id));
    const keep = [...expanded].filter((id) => known.has(id));
    if (keep.length === expanded.size) return;
    const next = new Set(keep);
    writeExpandedKeys(EXPANDED_STORAGE_KEY, next);
    setExpanded(next);
  }, [agentsPending, agentList, expanded]);
  const expandedIds = [...expanded];

  // 展开态变化（开/合都触发）：更新 expanded + 落盘持久化。取代原先只在展开
  // 时触发一次、且不落盘的 onExpandDevice——onToggle 覆盖开合两个方向，这里
  // 收敛成唯一入口，不再需要额外一个仅做「加入 expanded」的 onExpand 处理器。
  // Review M-3：写盘挪到 setState updater 外面的普通语句——updater 应为纯
  // 函数，StrictMode 下会双调用，副作用嵌进去就是重复写盘。直接基于闭包里的
  // expanded 计算 next（这个回调只由用户点击触发，不存在需要函数式更新规避
  // 的并发场景）。
  const handleToggleAgent = (node: NavNode, open: boolean) => {
    const id = node.key.startsWith(AGENT_PREFIX)
      ? node.key.slice(AGENT_PREFIX.length)
      : undefined;
    if (!id) return;
    const next = new Set(expanded);
    if (open) next.add(id);
    else next.delete(id);
    writeExpandedKeys(EXPANDED_STORAGE_KEY, next);
    setExpanded(next);
  };

  // 每个展开 Agent 并行拉会话（走 device-query 单例往返，正常秒回）。
  const sessionQueries = useQueries({
    queries: expandedIds.map((agentId) => ({
      queryKey: remoteSessionsQueryKey(agentId),
      queryFn: () =>
        remoteQuery(agentId, "sessions", {}) as Promise<SessionSummary[]>,
      enabled: isAgentOnline(
        agentList.find((a) => a.id === agentId) ?? { deviceId: "" },
      ),
      staleTime: 15_000,
    })),
  });
  const sessionsByAgent = new Map(
    expandedIds.map((id, i) => [id, sessionQueries[i]]),
  );

  const activeSessionKey = activeSessionId
    ? `${SESSION_PREFIX}${activeSessionId}`
    : undefined;

  // 边装配树边登记每个 key 的渲染元数据，供 SessionTree.nodeInfo 回读。
  const metaByKey = new Map<string, SessionTreeNodeInfo>();

  const sessionChildren = (agentId: string): NavNode[] => {
    const q = sessionsByAgent.get(agentId);
    if (!q || q.isPending) {
      const key = `ph:${agentId}:load`;
      metaByKey.set(key, { kind: "placeholder", variant: "skeleton" });
      return [{ key, label: "" }];
    }
    if (q.isError) {
      const key = `ph:${agentId}:err`;
      metaByKey.set(key, { kind: "placeholder", variant: "note" });
      return [{ key, label: t("remoteLoadFailed") }];
    }
    const sessions = q.data ?? [];
    if (sessions.length === 0) {
      const key = `ph:${agentId}:empty`;
      metaByKey.set(key, { kind: "placeholder", variant: "note" });
      return [{ key, label: t("remoteEmpty") }];
    }
    return sessions.map((s) => {
      const key = `${SESSION_PREFIX}${s.id}`;
      metaByKey.set(key, { kind: "session", title: s.title });
      return {
        key,
        label: s.title,
        onClick: () => router.push(`/assistant/${agentId}?session=${s.id}`),
      };
    });
  };

  const items: NavNode[] = agentList.map((a) => {
    const online = isAgentOnline(a);
    const { emoji, color } = parseAgentAvatar(a.avatar);
    metaByKey.set(`${AGENT_PREFIX}${a.id}`, {
      kind: "agent",
      emoji,
      color,
      name: a.name,
      running: false,
      remote: true,
      deviceName: deviceNameById.get(a.deviceId) ?? a.deviceId,
      online,
    });
    // 展开态/子节点开关/占位 chevron 抽成纯函数 computeAgentNodeExpansion
    // （同目录），离线强制不展开、不产出子节点、但仍要有占位 chevron 对齐
    // 左缘——见该函数顶部注释（Task 6 review Finding #1 + 真机验收 chevron
    // 缺陷，与 web-agent 同构修法保持两端一致）。wantOpen 只看 expanded 集合
    // 本身，不再 `|| a.id === routeAgentId`：routeAgentId 已经在上面的 effect
    // 里并入 expanded 了，这里 OR 一个游离在 expanded 之外的条件，会让用户
    // 手动收起「当前路由指向的 Agent」这个动作在下一次渲染被立刻打回——受控
    // 展开态下 expanded 必须是 open 与否的单一事实来源，这正是另一条真机验收
    // 缺陷明确禁止的写法（`open: expanded.has(k) || containsActiveSession`）。
    const { open, hasChildren, chevronPlaceholder } = computeAgentNodeExpansion(
      online,
      expanded.has(a.id),
    );
    return {
      key: `${AGENT_PREFIX}${a.id}`,
      label: a.name,
      open,
      children: hasChildren ? sessionChildren(a.id) : [],
      chevronPlaceholder,
    };
  });

  const groups: NavGroup[] = [{ key: "agents", items }];

  const labels: SessionTreeLabels = useMemo(
    () => ({ offline: tDevices("offline") }),
    [tDevices],
  );

  if (!slot) return null;

  return createPortal(
    <div className="flex h-full flex-col">
      <SidebarHeader title={t("title")} />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-2">
        {error ? (
          <div className="px-2 py-1 text-[12px] text-(--shell-sidebar-fg)/55">
            {tDevices("loadFailed")}
          </div>
        ) : isPending ? (
          <TreeSkeleton />
        ) : agentList.length === 0 ? (
          <div className="px-2 py-1 text-[12px] text-(--shell-sidebar-fg)/55">
            {t("empty")}
          </div>
        ) : (
          <SessionTree
            groups={groups}
            activeSessionKey={activeSessionKey}
            nodeInfo={(node) => metaByKey.get(node.key)}
            onToggle={handleToggleAgent}
            labels={labels}
          />
        )}
      </div>
    </div>,
    slot,
  );
}

/** 树首载骨架：Agent 行形状（在线点 + 变宽文字条），非整块 spinner。 */
function TreeSkeleton() {
  return (
    <div className="space-y-1.5" aria-hidden>
      {["w-24", "w-20", "w-16"].map((w) => (
        <div key={w} className="flex items-center gap-2 px-2 py-1">
          <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-(--shell-sidebar-fg)/15" />
          <span
            className={cn(
              "h-3 animate-pulse rounded bg-(--shell-sidebar-fg)/15",
              w,
            )}
          />
        </div>
      ))}
    </div>
  );
}
