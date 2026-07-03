import type { DeviceView } from "@meshbot/types";
import {
  type UseQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { mainApi } from "@/lib/api";

/**
 * 设备管理 hooks（web-main `/settings/devices` 页用）。列表含已吊销设备
 * （前端区分展示），吊销走用户 JWT（非设备 token）。
 */

const DEVICES_QUERY_KEY = ["main", "devices"] as const;

/** 我的设备列表（含已吊销）。 */
export function useDevices(): UseQueryResult<DeviceView[]> {
  return useQuery({
    queryKey: DEVICES_QUERY_KEY,
    queryFn: async () => (await mainApi.get<DeviceView[]>("/api/devices")).data,
  });
}

/** 吊销本人设备。成功后 invalidate 设备列表。 */
export function useRevokeDevice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (deviceId: string) =>
      (await mainApi.delete<{ ok: true }>(`/api/devices/${deviceId}`)).data,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: DEVICES_QUERY_KEY });
    },
  });
}
