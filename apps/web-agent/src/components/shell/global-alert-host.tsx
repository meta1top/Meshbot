"use client";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@meshbot/design";
import { useAtom } from "jotai";
import { useTranslations } from "next-intl";
import { globalAlertMessageAtom } from "@/atoms/global-alert";

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

  return (
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
  );
}
