import { atom } from "jotai";

/** 顶栏 ✦ 控制的随手问面板开关（全局）。 */
export const assistantPanelOpenAtom = atom(false);

/** 面板当前随手问会话 id；null = 尚未开始（首条消息惰性创建）。 */
export const currentQuickSessionIdAtom = atom<string | null>(null);
