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

/**
 * 全局确认弹窗（原生 `window.confirm` 的替代承载）。与 {@link globalAlertMessageAtom}
 * 的告知类不同，这里有**取消分支**，调用方要拿到用户的选择才能继续，所以带一个
 * `resolve` 回调把 Promise 桥接过来（`useGlobalConfirm` 负责建这个 Promise）。
 *
 * `null` = 不展示。同一时刻只允许一个：新调用会先以 `false` 结掉旧的那个 Promise
 * 再覆盖——绝不能直接丢弃，否则旧调用方会永远 await 下去（挂起的异步分支不会
 * 报错、只会静默不往下走，是最难查的一类）。
 */
export const globalConfirmAtom = atom<{
  message: string;
  resolve: (ok: boolean) => void;
} | null>(null);
