"use client";

import { createContext, useContext } from "react";

/** 当前区子栏要 portal 进的 DOM 插槽（WorkspaceSidebar 内）。null=尚未挂载。 */
export const SidebarSlotContext = createContext<HTMLElement | null>(null);

/** 页面侧读取插槽，把自己的子栏 portal 进去。 */
export function useSidebarSlot(): HTMLElement | null {
  return useContext(SidebarSlotContext);
}
