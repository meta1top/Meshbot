import {
  type UseQueryResult,
  useMutation,
  useQuery,
} from "@tanstack/react-query";
import { mainApi } from "@/lib/api";

/**
 * `GET /api/device-auth/requests/:id` 响应体（已解 envelope）。
 * `status`：pending（待确认）/ approved（已批准待兑换）/ consumed（已被本地
 * Agent 兑换完成）——授权确认页只对 pending 渲染确认卡片。
 */
export interface DeviceAuthRequestView {
  id: string;
  deviceName: string;
  platform: string;
  status: "pending" | "approved" | "consumed";
}

/**
 * 拉取待授权的设备请求信息（`/authorize?request=` 页面用）。
 * `requestId` 为空（缺 query）时不发请求。不存在 / 过期后端分别抛 2025 / 2026，
 * 交由调用方按 `ApiError.code` 分流文案，此处不重试。
 */
export function useDeviceAuthRequest(
  requestId: string | null,
): UseQueryResult<DeviceAuthRequestView> {
  return useQuery({
    queryKey: ["main", "device-auth", "request", requestId],
    queryFn: async () =>
      (
        await mainApi.get<DeviceAuthRequestView>(
          `/api/device-auth/requests/${requestId}`,
        )
      ).data,
    enabled: requestId != null,
    retry: false,
  });
}

/** `POST /api/device-auth/approve` 响应体。 */
export interface ApproveDeviceResult {
  /** 一次性授权码，供本地 Agent 兑换用，展示时需按等宽字体呈现 + 支持复制。 */
  userCode: string;
  /** 本地回调地址；非空时页面尝试 loopback 重定向，`start` 未提供时为 null（兜底走手动粘贴）。 */
  redirectUri: string | null;
}

/** 批准设备授权请求。成功即生成一次性 userCode，非 pending 状态会抛 2025（如重复点击）。 */
export function useApproveDevice() {
  return useMutation({
    mutationFn: async (requestId: string) =>
      (
        await mainApi.post<ApproveDeviceResult>("/api/device-auth/approve", {
          requestId,
        })
      ).data,
  });
}
