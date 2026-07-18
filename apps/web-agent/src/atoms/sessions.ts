"use client";

import type { SessionStatus, SessionSummary } from "@meshbot/types-agent";
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

/** 排序：updatedAt desc（置顶功能已移除）。 */
export function sortSessions(arr: SessionSummary[]): SessionSummary[] {
  return [...arr].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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

/**
 * 删除：等接口成功再从 list 移除（不做乐观更新）。
 *
 * 原因：调用方 SessionListItem 持有 dialog 的 deleting state；若乐观先移除，
 * SessionListItem 会立刻卸载，dialog 跟着销毁，用户看不到 loading + 失败回退
 * 等中间态。delete 是 destructive + 不可逆操作，慢一点（等服务端确认）比
 * 「闪一下」更可信。
 */
export const deleteSessionAtom = atom(null, async (get, set, id: string) => {
  if (!get(sessionsAtom).some((s) => s.id === id)) return;
  await deleteSessionApi(id);
  set(
    sessionsAtom,
    get(sessionsAtom).filter((s) => s.id !== id),
  );
});

/**
 * 按 id 局部 patch 会话运行状态；id 不在列表里则原样返回（引用不变）。
 *
 * 「存在才改」是硬要求：全局总线会广播所有会话的状态变更，其中随手问 quick /
 * 子 agent 会话本就不在侧栏列表里，插进去会凭空多出行。
 */
export function patchSessionStatus(
  arr: SessionSummary[],
  id: string,
  status: SessionStatus,
): SessionSummary[] {
  if (!arr.some((s) => s.id === id)) return arr;
  return arr.map((s) => (s.id === id ? { ...s, status } : s));
}

/**
 * 按 id 局部 patch session status（socket session.status_changed 收到时调）。
 * 侧栏「运行中」绿点靠它熄灭 —— sessionsAtom 首屏之后从不重拉。
 */
export const updateSessionStatusAtom = atom(
  null,
  (get, set, params: { id: string; status: SessionStatus }) => {
    const arr = get(sessionsAtom);
    const next = patchSessionStatus(arr, params.id, params.status);
    if (next === arr) return;
    set(sessionsAtom, next);
  },
);

/**
 * 按 id 局部 patch session title + titleGenerated=true。
 * socket session.title_updated 收到 + 未来「重生成标题」入口共用。
 */
export const updateSessionTitleAtom = atom(
  null,
  (get, set, params: { id: string; title: string }) => {
    const arr = get(sessionsAtom);
    if (!arr.some((s) => s.id === params.id)) return;
    set(
      sessionsAtom,
      sortSessions(
        arr.map((s) =>
          s.id === params.id
            ? { ...s, title: params.title, titleGenerated: true }
            : s,
        ),
      ),
    );
  },
);
