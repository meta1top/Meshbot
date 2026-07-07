"use client";

import type { SessionSummary } from "@meshbot/types-agent";
import { atom } from "jotai";
import { fetchRemoteSessions } from "@/rest/remote-devices";

type RemoteState = {
  status: "idle" | "loading" | "loaded" | "error";
  sessions: SessionSummary[];
};

/**
 * deviceId → 该远程设备的会话加载态。独立于 sessionsAtom（本机会话），
 * 按设备缓存，不污染本地会话列表。
 */
export const remoteSessionsAtom = atom<Record<string, RemoteState>>({});

/** 按需加载某远程设备会话列表；已 loaded/loading 直接跳过（避免重复拉取）。 */
export const loadRemoteSessionsAtom = atom(
  null,
  async (get, set, deviceId: string) => {
    const cur = get(remoteSessionsAtom)[deviceId];
    if (cur && cur.status !== "idle" && cur.status !== "error") return;
    set(remoteSessionsAtom, (m) => ({
      ...m,
      [deviceId]: { status: "loading", sessions: [] },
    }));
    try {
      const sessions = await fetchRemoteSessions(deviceId);
      set(remoteSessionsAtom, (m) => ({
        ...m,
        [deviceId]: { status: "loaded", sessions },
      }));
    } catch {
      set(remoteSessionsAtom, (m) => ({
        ...m,
        [deviceId]: { status: "error", sessions: [] },
      }));
    }
  },
);
