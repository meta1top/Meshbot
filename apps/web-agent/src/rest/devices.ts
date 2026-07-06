"use client";

import type { DeviceView } from "@meshbot/types";
import { apiClient } from "@meshbot/web-common";

/** 该账号云端注册设备列表（经本地 server-agent 代理，含 isCurrent 标本机）。 */
export async function fetchDevices(): Promise<DeviceView[]> {
  const { data } = await apiClient.get<DeviceView[]>("/api/devices");
  return data;
}

/** 查某设备在线态。 */
export async function fetchDeviceOnline(deviceId: string): Promise<boolean> {
  const { data } = await apiClient.get<{ online: boolean }>(
    `/api/devices/${deviceId}/online`,
  );
  return data.online;
}
