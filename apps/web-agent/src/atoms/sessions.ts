"use client";

import type { SessionSummary } from "@meshbot/types-agent";
import { atom } from "jotai";
import {
  deleteSession as deleteSessionApi,
  listSessions,
  patchSession,
} from "@/rest/session";

export type SessionsStatus = "idle" | "loading" | "loaded" | "error";

/** 全局会话列表（已排序）。任何写都走 sortSessions 重排。 */
export const sessionsAtom = atom<SessionSummary[]>([]);

/** 首屏加载状态。loaded 后永不再回 loading；新增/改/删全走局部 patch。 */
export const sessionsStatusAtom = atom<SessionsStatus>("idle");

/** 派生：已固定。 */
export const pinnedSessionsAtom = atom((get) =>
  get(sessionsAtom).filter((s) => s.pinned),
);

/** 派生：未固定。 */
export const recentSessionsAtom = atom((get) =>
  get(sessionsAtom).filter((s) => !s.pinned),
);

/** 排序：pinned 优先；pinned 内 pinnedAt desc；其余 updatedAt desc。 */
function sortSessions(arr: SessionSummary[]): SessionSummary[] {
  return [...arr].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.pinned && b.pinned) {
      return (b.pinnedAt ?? "").localeCompare(a.pinnedAt ?? "");
    }
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

/** 首次加载（mount 时调）。已 loaded / loading 则 no-op。 */
export const loadSessionsAtom = atom(null, async (get, set) => {
  if (get(sessionsStatusAtom) !== "idle") return;
  set(sessionsStatusAtom, "loading");
  try {
    const arr = await listSessions();
    set(sessionsAtom, sortSessions(arr));
    set(sessionsStatusAtom, "loaded");
  } catch {
    set(sessionsStatusAtom, "error");
  }
});

/** 手动重试（错误态用）。无视当前 status，直接重拉。 */
export const reloadSessionsAtom = atom(null, async (_get, set) => {
  set(sessionsStatusAtom, "loading");
  try {
    const arr = await listSessions();
    set(sessionsAtom, sortSessions(arr));
    set(sessionsStatusAtom, "loaded");
  } catch {
    set(sessionsStatusAtom, "error");
  }
});

/** 新建会话后插入：直接 push + sort（push 比 unshift 更直观，反正都排）。 */
export const addSessionAtom = atom(
  null,
  (get, set, summary: SessionSummary) => {
    const arr = [...get(sessionsAtom), summary];
    set(sessionsAtom, sortSessions(arr));
  },
);

/**
 * 重命名（乐观）。空标题或与原值相同：直接 no-op 不发请求。
 * 失败回滚到原 title + 抛错给调用方（让 UI 弹 toast）。
 */
export const renameSessionAtom = atom(
  null,
  async (get, set, params: { id: string; title: string }) => {
    const arr = get(sessionsAtom);
    const idx = arr.findIndex((s) => s.id === params.id);
    if (idx < 0) return;
    const before = arr[idx];
    const trimmed = params.title.trim();
    if (!trimmed || trimmed === before.title) return;
    const next = [...arr];
    next[idx] = { ...before, title: trimmed };
    set(sessionsAtom, sortSessions(next));
    try {
      const updated = await patchSession(params.id, { title: trimmed });
      const after = get(sessionsAtom).map((s) =>
        s.id === params.id ? updated : s,
      );
      set(sessionsAtom, sortSessions(after));
    } catch (err) {
      const rollback = get(sessionsAtom).map((s) =>
        s.id === params.id ? before : s,
      );
      set(sessionsAtom, sortSessions(rollback));
      throw err;
    }
  },
);

/** Pin / unpin（乐观）。失败回滚。 */
export const togglePinAtom = atom(
  null,
  async (get, set, params: { id: string; pinned: boolean }) => {
    const arr = get(sessionsAtom);
    const idx = arr.findIndex((s) => s.id === params.id);
    if (idx < 0) return;
    const before = arr[idx];
    const next = [...arr];
    next[idx] = {
      ...before,
      pinned: params.pinned,
      pinnedAt: params.pinned ? new Date().toISOString() : null,
    };
    set(sessionsAtom, sortSessions(next));
    try {
      const updated = await patchSession(params.id, { pinned: params.pinned });
      const after = get(sessionsAtom).map((s) =>
        s.id === params.id ? updated : s,
      );
      set(sessionsAtom, sortSessions(after));
    } catch (err) {
      const rollback = get(sessionsAtom).map((s) =>
        s.id === params.id ? before : s,
      );
      set(sessionsAtom, sortSessions(rollback));
      throw err;
    }
  },
);

/** 删除（乐观）。失败回插原位。 */
export const deleteSessionAtom = atom(null, async (get, set, id: string) => {
  const arr = get(sessionsAtom);
  const target = arr.find((s) => s.id === id);
  if (!target) return;
  set(
    sessionsAtom,
    arr.filter((s) => s.id !== id),
  );
  try {
    await deleteSessionApi(id);
  } catch (err) {
    set(sessionsAtom, sortSessions([...get(sessionsAtom), target]));
    throw err;
  }
});
