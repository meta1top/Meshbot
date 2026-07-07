"use client";

import type { DeviceView } from "@meshbot/types";
import { atom } from "jotai";
import { fetchDeviceOnline, fetchDevices } from "@/rest/devices";

export type DevicesStatus = "idle" | "loading" | "loaded" | "error";

/** 该账号所有注册设备（本机 isCurrent=true 排最前）。 */
export const devicesAtom = atom<DeviceView[]>([]);
export const devicesStatusAtom = atom<DevicesStatus>("idle");
/** deviceId → 在线态（首屏探测填充 + WS presence 实时更新）。 */
export const deviceOnlineAtom = atom<Record<string, boolean>>({});

/** 拉设备列表并按「本机置顶、其余按名称」排序。 */
async function fetchSortedDevices(): Promise<DeviceView[]> {
  const devices = await fetchDevices();
  return [...devices].sort((a, b) =>
    a.isCurrent === b.isCurrent
      ? a.name.localeCompare(b.name)
      : a.isCurrent
        ? -1
        : 1,
  );
}

/** 并发探测在线态（失败按离线处理，不阻塞列表）。 */
async function probeOnline(
  devices: DeviceView[],
): Promise<Record<string, boolean>> {
  const entries = await Promise.all(
    devices
      .filter((d) => !d.revokedAt)
      .map(async (d) => {
        try {
          return [d.id, await fetchDeviceOnline(d.id)] as const;
        } catch {
          return [d.id, false] as const;
        }
      }),
  );
  return Object.fromEntries(entries);
}

/** 首屏载入设备列表 + 并发探测在线态；guard：已加载/加载中不重复拉。 */
export const loadDevicesAtom = atom(null, async (get, set) => {
  if (get(devicesStatusAtom) !== "idle") return;
  set(devicesStatusAtom, "loading");
  try {
    const sorted = await fetchSortedDevices();
    set(devicesAtom, sorted);
    set(devicesStatusAtom, "loaded");
    set(deviceOnlineAtom, await probeOnline(sorted));
  } catch {
    set(devicesStatusAtom, "error");
  }
});

/**
 * 重新拉设备列表 + 探测在线态（无 guard，供「新设备出现」时刷新）。
 * 探测结果并入现有在线态；失败则保持上次成功结果，不清空列表。
 */
export const refreshDevicesAtom = atom(null, async (_get, set) => {
  try {
    const sorted = await fetchSortedDevices();
    set(devicesAtom, sorted);
    set(devicesStatusAtom, "loaded");
    const online = await probeOnline(sorted);
    set(deviceOnlineAtom, (prev) => ({ ...prev, ...online }));
  } catch {
    // 刷新失败保持现有列表/在线态
  }
});

/**
 * WS 设备 presence（userId="agent:<deviceId>"）→ 实时更新在线点。
 * 若该 deviceId 不在当前列表（新授权设备上线）→ 刷新设备列表把它拉进来。
 * 非设备 presence（普通用户 userId）忽略。
 */
export const applyDevicePresenceAtom = atom(
  null,
  (get, set, p: { userId: string; online: boolean }) => {
    const prefix = "agent:";
    if (!p.userId.startsWith(prefix)) return;
    const deviceId = p.userId.slice(prefix.length);
    set(deviceOnlineAtom, (prev) => ({ ...prev, [deviceId]: p.online }));
    const known = get(devicesAtom).some((d) => d.id === deviceId);
    if (!known && p.online) void set(refreshDevicesAtom);
  },
);
