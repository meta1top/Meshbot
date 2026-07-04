import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { mainApi } from "@/lib/api";

/**
 * 设备 Agent 在线态 hook（Agent-DM 会话侧栏在线点首屏用）。
 * 仅取首屏快照，之后的实时变化靠 `ws/im` 的 presence 事件推送（Task 14）。
 */
export function useDeviceOnline(
  deviceId: string,
): UseQueryResult<{ online: boolean }> {
  return useQuery({
    queryKey: ["main", "devices", deviceId, "online"] as const,
    queryFn: async () =>
      (
        await mainApi.get<{ online: boolean }>(
          `/api/devices/${deviceId}/online`,
        )
      ).data,
    enabled: deviceId.length > 0,
  });
}
