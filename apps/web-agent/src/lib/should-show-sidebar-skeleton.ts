import type { DevicesStatus } from "@/atoms/devices";
import type { SessionsStatus } from "@/atoms/sessions";

/**
 * 侧栏骨架屏 gate：devices / sessions 两个状态机 + agents（react-query）三路
 * 合流，任一「还在首次加载」就转圈。
 *
 * `agentsLoading` 必须传 `useAgents()` 的 `isLoading`（而非 `!data`）——
 * react-query 请求失败后 `data` 永远是 `undefined`，但 `isLoading` 会随之
 * 转为 `false`；用 `!data` 判定会让一次网络抖动使整个侧栏永久卡骨架屏
 * （风险：Important#2）。
 *
 * devices 明确到达 `"error"` 时不进这个 gate（调用方走独立的错误文案分支，
 * 整树替换），所以这里对 `"error"` 一律不拦。抽成纯函数是为了锁住 mount 时
 * 序竞态（风险 3：devices 先于 sessions/agents 到达时必须继续转圈，否则
 * Agent 节点带着骨架占位子节点抢先挂载、defaultOpen 判定到空子节点、永久
 * 错过自动展开）——这条判定逻辑值得独立单测，不依赖组件渲染。
 */
export function shouldShowSidebarSkeleton(
  devicesStatus: DevicesStatus,
  sessionsStatus: SessionsStatus,
  agentsLoading: boolean,
): boolean {
  return (
    devicesStatus === "idle" ||
    devicesStatus === "loading" ||
    sessionsStatus === "idle" ||
    sessionsStatus === "loading" ||
    agentsLoading
  );
}
