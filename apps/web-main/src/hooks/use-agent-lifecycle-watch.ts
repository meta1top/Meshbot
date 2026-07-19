"use client";

import type { SessionSummary } from "@meshbot/types-agent";
import {
  applySessionListEvent,
  type SessionListEvent,
} from "@meshbot/web-common/session/session-list-events";
import type { SessionTransport } from "@meshbot/web-common/session/transport";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { createRemoteSessionTransport } from "../lib/session-transport";
import { remoteSessionsQueryKey } from "./use-remote-sessions";

/**
 * 需要建立 Agent 级观察通道的候选目标：调用方（侧栏）按「已展开」筛出的
 * agentId，`online` 是该 Agent 宿主设备的在线态。本 hook 是最后一道防线——
 * 即便调用方传入了离线 Agent 也不会真的建 watch（T15b brief：离线 Agent
 * 建 watch 只会被设备侧拒绝 `reason:"offline"`，白占云端路由）。
 */
export interface AgentLifecycleWatchTarget {
  agentId: string;
  online: boolean;
}

/** 一路 watch 的运行期句柄：transport 实例 + unwatch 闭包，二者成对创建/
 * 释放——本 hook 每个 agentId 独占一个 transport 实例（不与任何 session
 * 级 watch 共享），`dispose()` 总是安全的。 */
interface WatchEntry {
  transport: SessionTransport;
  unwatch: () => void;
}

/**
 * Agent 级观察通道消费端（T15b · 交付点 B 消费端）：对每个「已展开 且 宿主
 * 在线」的 Agent 建立一路 `watchAgent`，把收到的生命周期事件（created/
 * deleted/renamed/status_changed）写进该 Agent 远程会话列表的 react-query
 * 缓存（`remoteSessionsQueryKey`）。
 *
 * **不重构侧栏的数据源**：`useQueries`（`sessionQueries`）仍是唯一的初始
 * 加载 + 定期回源（15s staleTime）路径；本 hook 只做增量 `setQueryData`，
 * 不 `invalidateQueries`——那会立刻回源，抵消实时优势，还可能因 staleTime
 * 产生抖动。
 *
 * **生命周期严格对齐 `targets`**：某个 agentId 从「已展开且在线」集合里
 * 消失（收起 / 离线 / 从列表消失）→ 立刻 unwatch + dispose，不等组件卸载
 * ——T14「零成本」的前提是没人看，若只在 unmount 清，用户折叠一个 Agent
 * 后设备侧仍会一直被要求镜像。
 *
 * **稳定 key**：`targets` 通常是调用方每次渲染内联 `.map(...)` 现造的新
 * 数组，直接放进 `useEffect` 依赖数组会导致 watch 反复建立/拆除——本仓刚
 * 因同类 `expandedIds` 引用问题出过「远程 Agent 展开后骨架永久转圈」的
 * 真机验收缺陷。内部改用 `targets` 派生出的字符串 key（在线 agentId 排序
 * join）驱动 effect，effect 内部只读这个 key（split 还原），不读 `targets`
 * 本身，因此依赖数组可以如实列全而不必 `biome-ignore`。
 *
 * @param transportFactory 测试注入点：默认 `createRemoteSessionTransport`
 *   （真实 socket）。单测传入假 transport，避免拉起真实 `getImSocket()`
 *   单例。
 */
export function useAgentLifecycleWatch(
  targets: AgentLifecycleWatchTarget[],
  transportFactory: (
    agentId: string,
  ) => SessionTransport = createRemoteSessionTransport,
): void {
  const queryClient = useQueryClient();
  const entriesRef = useRef<Map<string, WatchEntry>>(new Map());

  const targetKey = targets
    .filter((t) => t.online)
    .map((t) => t.agentId)
    .sort()
    .join(",");

  useEffect(() => {
    const wantOnline = new Set(targetKey ? targetKey.split(",") : []);
    const entries = entriesRef.current;

    // 不再需要的（离线 / 收起 / 从列表消失）→ 立即 unwatch + dispose，
    // 不等组件卸载（见上方文档）。
    for (const [agentId, entry] of entries) {
      if (wantOnline.has(agentId)) continue;
      entry.unwatch();
      entry.transport.dispose?.();
      entries.delete(agentId);
    }

    // 新增的 → 建 transport + watchAgent。
    for (const agentId of wantOnline) {
      if (entries.has(agentId)) continue;
      const transport = transportFactory(agentId);
      if (!transport.watchAgent) {
        // web-agent 侧要到 T19 才实现 `watchAgent`；本机 transport 不提供
        // 时安全跳过，不占坑（也不留一个空 entry 挡住下次重试）。
        transport.dispose?.();
        continue;
      }
      const unwatch = transport.watchAgent((evt: SessionListEvent) => {
        queryClient.setQueryData<SessionSummary[]>(
          remoteSessionsQueryKey(agentId),
          (old) => applySessionListEvent(old ?? [], evt),
        );
      });
      entries.set(agentId, { transport, unwatch });
    }
  }, [targetKey, queryClient, transportFactory]);

  // 组件真正卸载时兜底释放全部剩余通道。上面的 effect 只在 `targetKey`
  // 变化时做增量 diff（不返回 cleanup 函数），不会在 unmount 时自动触发
  // ——增量 diff 与整体卸载是两个独立关注点，分成两个 effect 更不容易漏写
  // 任一路径。
  useEffect(() => {
    return () => {
      for (const [, entry] of entriesRef.current) {
        entry.unwatch();
        entry.transport.dispose?.();
      }
      entriesRef.current.clear();
    };
  }, []);
}
