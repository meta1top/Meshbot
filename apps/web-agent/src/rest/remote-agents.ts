"use client";

import type { WatchScope } from "@meshbot/types";
import type { RemoteAgentView } from "@meshbot/types-agent";
import { apiClient } from "@meshbot/web-common";
import { useQuery } from "@tanstack/react-query";

/** 远程 Agent 列表 query key。 */
export const remoteAgentsQueryKey = ["remote-agents"] as const;

/** 拉同账号其他设备上已注册的远程 Agent（经本地 server-agent 代理云端）。 */
export async function listRemoteAgents(): Promise<RemoteAgentView[]> {
  const { data } = await apiClient.get<RemoteAgentView[]>("/api/remote-agents");
  return data;
}

/**
 * 设备级 presence 的 userId 前缀。server-main 发的是 `device:<deviceId>`
 * （见 `apps/server-main/src/ws/im.gateway.ts` 的 `userId: \`device:${...}\``），
 * 与 web-main 侧 `rest/agent-devices.ts` 用的同一个值。
 */
const DEVICE_PRESENCE_PREFIX = "device:";

/**
 * 把一条设备 presence 事件应用到远程 Agent 列表缓存的 `deviceOnline` 上。
 *
 * **为什么需要它**：`deviceOnline` 是 `/api/remote-agents` 响应里**烘焙好的快照**
 * （server-agent 请求那一刻向云端探测的结果），而 `REMOTE_AGENT_EVENTS.registryChanged`
 * 只在**注册表变化**（增删改名）时触发重拉——设备上下线不属于注册表变化，于是
 * 侧栏的在线态只能等下次重拉或**刷新页面**才更新（真机反馈）。
 *
 * presence 事件本来就已经转发到 web-agent 了（`events.gateway.ts` 的
 * `@OnEvent(IM_WS_EVENTS.presence)`），此前只喂给了 `atoms/devices.ts`
 * 里的 `deviceOnlineAtom`——那个 atom 在 2c 拍平侧栏 IA 之后**已无任何读取方**，
 * 且它的前缀判据写的是 `agent:` 而非 `device:`，双重失效（该文件已整体删除）。
 * 这里直接 patch 侧栏真正读的那份缓存。
 *
 * 只改命中 deviceId 的行、不整体替换：`updatedAt` 之类的字段不归 presence 管
 * （同 `applySessionListEvent` 的字段级归并原则）。列表尚未加载时是 no-op。
 */
export function applyRemoteAgentPresence(
  queryClient: { setQueryData: SetRemoteAgents },
  p: { userId: string; online: boolean },
): void {
  if (!p.userId.startsWith(DEVICE_PRESENCE_PREFIX)) return;
  const deviceId = p.userId.slice(DEVICE_PRESENCE_PREFIX.length);
  if (!deviceId) return;
  queryClient.setQueryData(remoteAgentsQueryKey, (old?: RemoteAgentView[]) => {
    if (!old) return old;
    if (
      !old.some((a) => a.deviceId === deviceId && a.deviceOnline !== p.online)
    )
      return old;
    return old.map((a) =>
      a.deviceId === deviceId ? { ...a, deviceOnline: p.online } : a,
    );
  });
}

/** `applyRemoteAgentPresence` 只需要 queryClient 的这一个方法（便于单测注入假对象）。 */
type SetRemoteAgents = (
  key: typeof remoteAgentsQueryKey,
  updater: (old?: RemoteAgentView[]) => RemoteAgentView[] | undefined,
) => unknown;

/** 当前账号其他设备上的远程 Agent 列表（起手台 + 侧栏共用同一份缓存）。 */
export function useRemoteAgents() {
  return useQuery({
    queryKey: remoteAgentsQueryKey,
    queryFn: listRemoteAgents,
  });
}

/**
 * 发起对目标远程 Agent 的观察（Agent 级观察通道，T18/T19，web-agent 浏览器
 * 不直连云端，经本机 server-agent 代理）。`scope="agent"` 订该 Agent 的会话
 * 生命周期镜像（不带 sessionId）；`scope="session"` 订某个会话的推理帧（须带
 * `sessionId`，对应 T18 `RemoteWatchStartSchema` 的 refine 校验）。返回
 * `watchId`，注销时原样传给 {@link unwatchRemoteAgent}。
 */
export async function watchRemoteAgent(
  agentId: string,
  scope: WatchScope,
  sessionId?: string,
): Promise<{ watchId: string }> {
  const { data } = await apiClient.post<{ watchId: string }>(
    `/api/remote-agents/${agentId}/watch`,
    scope === "session" ? { scope, sessionId } : { scope },
  );
  return data;
}

/** 注销对目标远程 Agent 的观察（离开视图 / 组件卸载时调用）。 */
export async function unwatchRemoteAgent(
  agentId: string,
  watchId: string,
): Promise<void> {
  await apiClient.delete(`/api/remote-agents/${agentId}/watch/${watchId}`);
}
