"use client";

import { createContext, type RefObject, useContext } from "react";

/** layout 下发给 PageShell 的共享 ref：侧栏元素（dock 宽度 measure 要减它）。 */
interface ShellRefs {
  sidebarRef: RefObject<HTMLElement | null>;
}

export const ShellRefsContext = createContext<ShellRefs | null>(null);

/** 读取 layout 下发的 refs；必须在 (shell)/layout 内使用。 */
export function useShellRefs(): ShellRefs {
  const ctx = useContext(ShellRefsContext);
  if (!ctx) {
    throw new Error("useShellRefs 必须在 ShellLayout 内使用");
  }
  return ctx;
}
