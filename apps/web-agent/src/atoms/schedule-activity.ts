"use client";

import { atom } from "jotai";

/** 有「定时任务刚触发」未查看的助手会话 id 集合（侧栏红点用）。 */
export const scheduleActivityAtom = atom<Set<string>>(new Set<string>());

/** 标记某会话有定时活动。 */
export const addScheduleActivityAtom = atom(
  null,
  (get, set, sessionId: string) => {
    const next = new Set(get(scheduleActivityAtom));
    next.add(sessionId);
    set(scheduleActivityAtom, next);
  },
);

/** 清除某会话的定时活动标记（打开该会话时调用）。 */
export const clearScheduleActivityAtom = atom(
  null,
  (get, set, sessionId: string) => {
    const cur = get(scheduleActivityAtom);
    if (!cur.has(sessionId)) return;
    const next = new Set(cur);
    next.delete(sessionId);
    set(scheduleActivityAtom, next);
  },
);
