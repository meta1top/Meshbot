import { IM_WS_EVENTS, type PresenceState } from "@meshbot/types";
import {
  type UseQueryResult,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect } from "react";
import { mainApi } from "@/lib/api";
import { getImSocket } from "@/lib/im-socket";

/** 设备 presence 事件里 userId 的前缀（区分设备 Agent presence 与人类 presence）。
 * 与 server-main ImGateway 广播的 `agent:${deviceId}` 契约保持一致。 */
const AGENT_PRESENCE_PREFIX = "agent:";

/** 设备 Agent 在线态 query key（sidebar / 设备页 / presence 实时更新共用）。 */
export function deviceOnlineQueryKey(deviceId: string) {
  return ["main", "devices", deviceId, "online"] as const;
}

/**
 * 设备 Agent 在线态 hook（Agent-DM 会话侧栏在线点、设备管理页在线列首屏用）。
 * 仅取首屏快照，之后的实时变化靠 `useDevicePresenceSync` 订阅 presence 事件推送。
 */
export function useDeviceOnline(
  deviceId: string,
): UseQueryResult<{ online: boolean }> {
  return useQuery({
    queryKey: deviceOnlineQueryKey(deviceId),
    queryFn: async () =>
      (
        await mainApi.get<{ online: boolean }>(
          `/api/devices/${deviceId}/online`,
        )
      ).data,
    enabled: deviceId.length > 0,
  });
}

/**
 * 订阅 `ws/im` 的 presence 事件，实时刷新设备 Agent 在线态缓存。
 * 只认 `agent:` 前缀的 userId（设备 presence），提取 deviceId 后直接写入对应
 * `useDeviceOnline` 缓存（不触发重新拉取）；人类 presence（无前缀）忽略。
 * 挂载即订阅、卸载即清理，供侧栏与设备管理页共用。
 */
export function useDevicePresenceSync(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    const socket = getImSocket();
    const onPresence = (p: PresenceState) => {
      if (!p.userId.startsWith(AGENT_PRESENCE_PREFIX)) return;
      const deviceId = p.userId.slice(AGENT_PRESENCE_PREFIX.length);
      if (!deviceId) return;
      queryClient.setQueryData(deviceOnlineQueryKey(deviceId), {
        online: p.online,
      });
    };
    socket.on(IM_WS_EVENTS.presence, onPresence);
    return () => {
      socket.off(IM_WS_EVENTS.presence, onPresence);
    };
  }, [queryClient]);
}
