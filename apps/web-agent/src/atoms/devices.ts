"use client";

import type { DeviceView } from "@meshbot/types";
import { atom } from "jotai";
import { fetchDeviceOnline, fetchDevices } from "@/rest/devices";

export type DevicesStatus = "idle" | "loading" | "loaded" | "error";

/** 该账号所有注册设备（本机 isCurrent=true 排最前）。 */
export const devicesAtom = atom<DeviceView[]>([]);
export const devicesStatusAtom = atom<DevicesStatus>("idle");
/** deviceId → 在线态（首屏并发探测填充）。 */
export const deviceOnlineAtom = atom<Record<string, boolean>>({});

/** 载入设备列表 + 并发探测在线态；guard：已加载/加载中不重复拉。 */
export const loadDevicesAtom = atom(null, async (get, set) => {
  if (get(devicesStatusAtom) !== "idle") return;
  set(devicesStatusAtom, "loading");
  try {
    const devices = await fetchDevices();
    // 本机排最前，其余按名称
    const sorted = [...devices].sort((a, b) =>
      a.isCurrent === b.isCurrent
        ? a.name.localeCompare(b.name)
        : a.isCurrent
          ? -1
          : 1,
    );
    set(devicesAtom, sorted);
    set(devicesStatusAtom, "loaded");
    // 在线态并发探测（失败按离线处理，不阻塞列表）
    const entries = await Promise.all(
      sorted
        .filter((d) => !d.revokedAt)
        .map(async (d) => {
          try {
            return [d.id, await fetchDeviceOnline(d.id)] as const;
          } catch {
            return [d.id, false] as const;
          }
        }),
    );
    set(deviceOnlineAtom, Object.fromEntries(entries));
  } catch {
    set(devicesStatusAtom, "error");
  }
});
