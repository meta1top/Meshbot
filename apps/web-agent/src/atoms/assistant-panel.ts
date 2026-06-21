import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";

/** 顶栏 ✦ 控制的随手问面板开关（全局）。 */
export const assistantPanelOpenAtom = atom(false);

/** 窄屏（< md）下消息侧栏抽屉开关；顶栏汉堡控制，点会话/切路由自动收起。 */
export const sidebarDrawerOpenAtom = atom(false);

/** 面板当前随手问会话 id；null = 尚未开始（首条消息惰性创建）。 */
export const currentQuickSessionIdAtom = atom<string | null>(null);

/** 随手问面板宽度（px）：左缘可拖拽调整，localStorage 持久化，下次打开记住。 */
export const assistantPanelWidthAtom = atomWithStorage(
  "meshbot.assistantPanelWidth",
  340,
);
