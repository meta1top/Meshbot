import { atom } from "jotai";

/**
 * 全局告知类弹窗（原生 `window.alert` 的替代承载）——只存当前要展示的一条
 * 消息文本，调用方已用各自 namespace 的 `t()` 解析好，这里不关心 i18n key。
 * `null` = 不展示任何弹窗。
 *
 * 非渲染上下文（如 `use-global-events.ts` 这类 hook 的 socket 回调）不能直接
 * 渲染 UI，写这个 atom 即可让挂在 `(shell)/layout.tsx` 的 `GlobalAlertHost`
 * 弹出对应的 shadcn `AlertDialog`。
 *
 * 同一时刻只展示一条：新调用直接覆盖旧的，不排队。会话删除提示的本机/远程
 * 两条路径理论互斥（`isActiveSessionDeletedByEvent` 的 active session 不可能
 * 同时是本机会话又是远程会话），即便意外同时触发，覆盖语义也足够，不需要
 * 额外去重逻辑。
 */
export const globalAlertMessageAtom = atom<string | null>(null);
