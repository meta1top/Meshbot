import type { SessionsStatus } from "@/atoms/sessions";

/**
 * 侧栏骨架屏 gate：sessions（本机会话）+ agents（react-query）两路合流，任一
 * 「还在首次加载」就转圈。远程 Agent 列表（`useRemoteAgents()`）不纳入这个
 * gate——本机 Agent/会话就绪即可先渲染侧栏，远程 Agent 加载完成后在列表尾部
 * 自然补入，不必等它（计划二 2c·B2 去设备树后，侧栏不再依赖设备列表首屏）。
 *
 * `agentsLoading` 必须传 `useAgents()` 的 `isLoading`（而非 `!data`）——
 * react-query 请求失败后 `data` 永远是 `undefined`，但 `isLoading` 会随之
 * 转为 `false`；用 `!data` 判定会让一次网络抖动使整个侧栏永久卡骨架屏
 * （风险：Important#2）。
 */
export function shouldShowSidebarSkeleton(
  sessionsStatus: SessionsStatus,
  agentsLoading: boolean,
): boolean {
  return (
    sessionsStatus === "idle" || sessionsStatus === "loading" || agentsLoading
  );
}
