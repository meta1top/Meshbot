"use client";

import type { ReactNode } from "react";

interface PageHeaderProps {
  /** 左侧标题。 */
  title: ReactNode;
  /** 右侧操作区（按钮、⋯ 菜单等）。 */
  actions?: ReactNode;
  /** 可选：标题行下方的标签/筛选行。 */
  tabs?: ReactNode;
}

/**
 * 二级页统一页头条：钉在内容区顶部、全宽、不随内容滚动。
 *
 * 经 PageShell 的 `header` 槽位渲染（滚动容器之外，与会话页标题栏同机制）。
 * 水平内边距与内容体一致（px-4 lg:px-6），保证标题与内容左缘对齐。
 */
export function PageHeader({ title, actions, tabs }: PageHeaderProps) {
  return (
    <div className="shrink-0 border-b border-border bg-(--shell-content)">
      <div className="flex min-h-[52px] items-center justify-between gap-3 px-4 py-2.5 lg:px-6">
        <h1 className="min-w-0 truncate text-lg font-semibold text-foreground">
          {title}
        </h1>
        {actions && (
          <div className="flex shrink-0 items-center gap-2">{actions}</div>
        )}
      </div>
      {tabs && (
        <div className="flex items-center gap-1 px-4 pb-2 lg:px-6">{tabs}</div>
      )}
    </div>
  );
}
