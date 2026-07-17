"use client";

import type { SessionSummary } from "@meshbot/types-agent";
import { atom } from "jotai";
import { fetchRemoteSessions } from "@/rest/remote-agent-sessions";

type RemoteState = {
  status: "idle" | "loading" | "loaded" | "error";
  sessions: SessionSummary[];
};

/**
 * cloudAgentId → 该远程 Agent 的会话加载态。独立于 sessionsAtom（本机会话），
 * 按 Agent 缓存，不污染本地会话列表。
 */
export const remoteSessionsAtom = atom<Record<string, RemoteState>>({});

/**
 * 按需加载某远程 Agent 会话列表；已 loaded/loading 默认跳过（避免重复拉取）。
 * force=true 时 loaded 也重拉（loading 仍跳过）——对端数据可被对端自身修改
 * （如在 B 上切换会话模型），进入远程会话页时需要新鲜快照。
 */
export const loadRemoteSessionsAtom = atom(
  null,
  async (get, set, agentId: string, force = false) => {
    const cur = get(remoteSessionsAtom)[agentId];
    if (cur?.status === "loading") return;
    if (!force && cur && cur.status !== "idle" && cur.status !== "error")
      return;
    set(remoteSessionsAtom, (m) => ({
      ...m,
      [agentId]: { status: "loading", sessions: [] },
    }));
    try {
      const sessions = await fetchRemoteSessions(agentId);
      set(remoteSessionsAtom, (m) => ({
        ...m,
        [agentId]: { status: "loaded", sessions },
      }));
    } catch {
      set(remoteSessionsAtom, (m) => ({
        ...m,
        [agentId]: { status: "error", sessions: [] },
      }));
    }
  },
);
