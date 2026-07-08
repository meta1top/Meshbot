"use client";

import type { ReactNode } from "react";
import { SidebarRow } from "./sidebar-row";

interface Props {
  icon?: ReactNode;
  label: ReactNode;
  active?: boolean;
  onClick?: () => void;
  trailing?: ReactNode;
}

/** @deprecated 用 SidebarRow。保留为薄别名，迁移完成后删。 */
export function SidebarNavItem(props: Props) {
  return <SidebarRow {...props} />;
}
