"use client";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@meshbot/design";
import { useAtom } from "jotai";
import { useTranslations } from "next-intl";
import {
  globalAlertMessageAtom,
  globalConfirmAtom,
} from "@/atoms/global-alert";

/**
 * 全局告知类弹窗宿主：常驻挂在 `(shell)/layout.tsx`，渲染
 * `globalAlertMessageAtom` 里的当前消息——替代原生 `window.alert`。
 *
 * 这些提示（会话已在其他设备被删除、网络错误、运行中不能发送/删除/编辑等）
 * 都是「告知类」：用户只能确认，不存在取消分支，因此只渲染单按钮
 * `AlertDialog`（没有 `AlertDialogCancel`）。`use-global-events.ts` 这类 hook
 * 无法直接渲染组件，写这个 atom 即可弹出。
 */
export function GlobalAlertHost() {
  const t = useTranslations("common");
  const [message, setMessage] = useAtom(globalAlertMessageAtom);
  const [confirmState, setConfirmState] = useAtom(globalConfirmAtom);

  /** 关闭确认弹窗并结掉 Promise。取消 / 遮罩点击 / Esc 一律按「否」。 */
  const settleConfirm = (ok: boolean) => {
    confirmState?.resolve(ok);
    setConfirmState(null);
  };

  return (
    <>
      <AlertDialog
        open={message !== null}
        onOpenChange={(open) => {
          if (!open) setMessage(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("alertTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{message}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setMessage(null)}>
              {t("gotIt")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 确认类（有取消分支）：原生 window.confirm 的替代，见 useGlobalConfirm。 */}
      <AlertDialog
        open={confirmState !== null}
        onOpenChange={(open) => {
          // 遮罩点击 / Esc 关闭也要结掉 Promise，否则调用方永远 await。
          if (!open) settleConfirm(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("alertTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmState?.message}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => settleConfirm(false)}>
              {t("cancel")}
            </AlertDialogCancel>
            <AlertDialogAction onClick={() => settleConfirm(true)}>
              {t("confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
