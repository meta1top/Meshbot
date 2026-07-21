"use client";

import { useAtom } from "jotai";
import { useCallback } from "react";
import { globalConfirmAtom } from "@/atoms/global-alert";

/**
 * 原生 `window.confirm` 的替代：返回一个 `(message) => Promise<boolean>`，
 * 弹出挂在 `(shell)/layout.tsx` 的 shadcn `AlertDialog`，用户点确认/取消后
 * resolve。
 *
 * 覆盖旧调用时**先把旧 Promise 以 `false` 结掉**：直接丢弃的话旧调用方会永远
 * await，那条异步分支既不报错也不继续，属于最难查的一类挂起。
 */
export function useGlobalConfirm(): (message: string) => Promise<boolean> {
  const [current, setCurrent] = useAtom(globalConfirmAtom);
  return useCallback(
    (message: string) =>
      new Promise<boolean>((resolve) => {
        current?.resolve(false);
        setCurrent({ message, resolve });
      }),
    [current, setCurrent],
  );
}
