"use client";

import type { ReactNode } from "react";

export interface SidebarHeaderProps {
  /** 标题（走各页 useTranslations，不传裸字符串）。 */
  title: ReactNode;
  /** 右侧动作（新建按钮等），可选。 */
  action?: ReactNode;
}

/**
 * 二级 sidebar 顶部统一标题栏：标题 + 可选右侧动作。
 * 高度/字重在此单点定义（h-10），各 section sidebar 共用,消除各写各的高度差。
 */
export function SidebarHeader({ title, action }: SidebarHeaderProps) {
  return (
    <div className="flex h-10 shrink-0 items-center justify-between px-3">
      <span className="text-[15px] font-extrabold">{title}</span>
      {action}
    </div>
  );
}
