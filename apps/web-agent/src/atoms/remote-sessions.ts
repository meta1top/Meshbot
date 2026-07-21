"use client";

import type { SessionSummary } from "@meshbot/types-agent";
import {
  applySessionListEvent,
  type SessionListEvent,
} from "@meshbot/web-common/session/session-list-events";
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
    // 进 loading 保留旧 sessions（不清空）：`reloadTrackedRemoteSessionsAtom`
    // 在每次 socket 重连都会 force 重拉已加载过的远程 Agent（见其 JSDoc），
    // 若这里清成 []，断线重连一次列表就闪烁清空再重填，期间到达的镜像事件
    // 也会被合并进这个 [] 随后被 REST 响应整体覆盖丢弃。旧值只在新快照
    // （下方 loaded/error 分支）到达时才被替换。
    set(remoteSessionsAtom, (m) => ({
      ...m,
      [agentId]: { status: "loading", sessions: cur?.sessions ?? [] },
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

/**
 * 应用远程 Agent 的会话生命周期镜像事件（Agent 级观察通道，T19）到该 Agent
 * 的会话列表——由 `use-global-events.ts` 的 `onRemoteAgentSessionEvent` 调用。
 *
 * **只在已加载过该远程 Agent 时生效**（`cur` 存在）：未展开/未进入过的远程
 * Agent 在 `remoteSessionsAtom` 里连 key 都没有，此时收到镜像帧直接忽略——不
 * 凭空造一份状态。这与 `applySessionListEvent` 本身「不认识的会话原样返回」
 * 是同一种保守取舍（宁可漏更新，不无中生有），也避免了一种真实竞态：若在
 * `status:"loading"` 期间合并事件，随后 `loadRemoteSessionsAtom` 的 REST
 * 响应会整体覆盖 `sessions`（见其实现），并不会丢数据（服务端权威快照本就
 * 该包含该事件），但仍以查表短路的方式保持逻辑简单，不在此处叠加特判。
 *
 * 复用 `@meshbot/web-common/session` 的 `applySessionListEvent` 做归并（D9
 * 「上层处理逻辑一份」——不与本机 `atoms/sessions.ts` 的
 * `applySessionListEventToArray` 分叉出第二份实现）。
 */
export const applyRemoteSessionListEventAtom = atom(
  null,
  (get, set, params: { agentId: string; evt: SessionListEvent }) => {
    const cur = get(remoteSessionsAtom)[params.agentId];
    if (!cur) return;
    const next = applySessionListEvent(cur.sessions, params.evt);
    if (next === cur.sessions) return;
    set(remoteSessionsAtom, (m) => ({
      ...m,
      [params.agentId]: { ...cur, sessions: next },
    }));
  },
);

/**
 * 重连兜底（`use-global-events.ts` 的 `onConnect` 调用）：把当前已经加载过
 * （loaded/loading/error，即 map 里已有 key）的远程 Agent 会话列表强制重拉
 * 一遍。断线期间 Agent 级观察通道的镜像帧会丢，仅凭 `applyRemoteSessionListEventAtom`
 * 的增量合并补不回来——照既有 `onConnect` 那三条 `invalidateQueries` 的同一
 * 兜底理由（见该文件 JSDoc）。不主动加载用户从未展开过的远程 Agent（map 里
 * 没有对应 key 就不在这份重拉清单里）。
 */
export const reloadTrackedRemoteSessionsAtom = atom(null, (get, set) => {
  const agentIds = Object.keys(get(remoteSessionsAtom));
  for (const agentId of agentIds) {
    void set(loadRemoteSessionsAtom, agentId, true);
  }
});
