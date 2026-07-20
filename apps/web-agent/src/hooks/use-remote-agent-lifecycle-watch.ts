"use client";

import type { SessionTransport } from "@meshbot/web-common/session";
import { useEffect, useRef } from "react";
import { createRemoteSessionTransport } from "@/lib/session-transport";

/**
 * 需要建立 Agent 级观察通道的候选目标：调用方（侧栏）按「已展开」筛出的
 * agentId，`online` 是该 Agent 宿主设备的在线态。本 hook 是最后一道防线——
 * 即便调用方传入了离线 Agent 也不会真的建 watch（离线 Agent 建 watch 只会被
 * 设备侧以 `reason:"offline"` 拒绝，白占云端路由，见 `startAgentWatch` 的
 * REST 往返 — server-agent 端会话生命周期路由文档）。
 */
export interface AgentLifecycleWatchTarget {
  agentId: string;
  online: boolean;
}

/** 一路 watch 的运行期句柄：transport 实例 + unwatch 闭包，二者成对创建/
 * 释放——本 hook 每个 agentId 独占一个 transport 实例（不与任何 session
 * 级 watch 共享），`dispose()` 总是安全调用（可选链、缺失也不抛）。
 *
 * **Minor-3（T19b review 澄清）**：本端 `createRemoteSessionTransport`
 * （`@/lib/session-transport.ts`）**未实现** `dispose`——三条调用点
 * （下方 :93/:105/:121）里的 `dispose?.()` 在本仓永远是 no-op，不要读成
 * 「确实释放了资源」。真正的释放全靠 `unwatch()`（REST DELETE 拆掉 REST
 * 侧观察通道登记）；`dispose?.()` 只是为了与 `SessionTransport` 契约（以及
 * web-main 的对应实现——那边真的会摘 socket 监听器，见
 * `apps/web-main/src/lib/session-transport.ts:634`）保持调用形状一致，本端
 * 调不调都不影响正确性。 */
interface WatchEntry {
  transport: SessionTransport;
  unwatch: () => void;
}

/**
 * `transport.watchAgent(onEvent)` 要求的回调形参——web-agent 侧刻意不使用它：
 * 本仓只有一条常驻全局事件总线（`ws/events`），Agent 级生命周期镜像事件已经
 * 由 `use-global-events.ts` 的 `onRemoteAgentSessionEvent` 统一落进
 * `remoteSessionsAtom`（`applyRemoteSessionListEventAtom`），不需要再经这条
 * per-transport-instance 回调重复投递一次（`createRemoteSessionTransport` 里
 * `watchAgent` 的实现本身也印证了这点：它的 `onEvent` 形参从未被读取，见
 * `apps/web-agent/src/lib/session-transport.ts` 的 `startAgentWatch` 文档）。
 * 调用 `watchAgent(noop)` 真正起作用的是它触发的 REST 注册（`POST
 * /api/remote-agents/:agentId/watch`）——那才是让云端开始下发镜像事件的动作，
 * 回调本身是否被调用与此无关，因此这里仍必须调用 `watchAgent`，只是传空函数。
 */
function noop(): void {}

/**
 * Agent 级观察通道消费端（T19b）：对每个「已展开 且 宿主在线」的 Agent 建立
 * 一路 `watchAgent`，只负责 watch 的注册/注销生命周期——不做事件落盘（那部分
 * 已经由全局事件总线覆盖，见上方 {@link noop} 的文档）。
 *
 * 与 web-main 的 `useAgentLifecycleWatch`（`apps/web-main/src/hooks/
 * use-agent-lifecycle-watch.ts`，已真机验收）逐字对照，差别只有两处：
 * - 本 hook 不落任何缓存（web-main 落 react-query，本仓事件已由全局总线落进
 *   `remoteSessionsAtom`，见上方 `noop` 文档）；
 * - `watchAgent` 的回调传 `noop`。
 *
 * **生命周期严格对齐 `targets`**：某个 agentId 从「已展开且在线」集合里消失
 * （收起 / 离线 / 从列表消失）→ 立刻 unwatch + dispose，不等组件卸载——设备侧
 * 「零成本」的前提是没人看，若只在 unmount 清，用户折叠一个 Agent 后对端仍会
 * 一直被要求镜像。
 *
 * **离线 Agent 不建 watch**：会被设备侧以 `reason:"offline"` 拒绝，白占云端
 * 路由。
 *
 * **稳定 key**：`targets` 通常是调用方每次渲染内联 `.map(...)` 现造的新数组，
 * 直接放进 `useEffect` 依赖数组会导致 watch 反复建立/拆除——本仓已经因同类
 * `expandedIds` 引用问题出过「远程 Agent 展开后骨架永久转圈」的真机验收缺陷。
 * 内部改用 `targets` 派生出的字符串 key（在线 agentId 排序 join）驱动 effect，
 * effect 内部只读这个 key（split 还原），不读 `targets` 本身，因此依赖数组可以
 * 如实列全而不必 `biome-ignore`。
 *
 * @param transportFactory 测试注入点：默认 `createRemoteSessionTransport`
 *   （真实 socket + REST）。单测传入假 transport，避免拉起真实单例。
 */
export function useRemoteAgentLifecycleWatch(
  targets: AgentLifecycleWatchTarget[],
  transportFactory: (
    agentId: string,
  ) => SessionTransport = createRemoteSessionTransport,
): void {
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
        // 契约上 web-agent 侧的 createRemoteSessionTransport 恒实现
        // watchAgent（T19 已接线）；仍按 `?.` 契约防御式跳过，不占坑（也不留
        // 一个空 entry 挡住下次重试）。
        transport.dispose?.();
        continue;
      }
      const unwatch = transport.watchAgent(noop);
      entries.set(agentId, { transport, unwatch });
    }
  }, [targetKey, transportFactory]);

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
