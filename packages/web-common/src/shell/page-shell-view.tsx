"use client";

import { cn } from "@meshbot/design";
import type { ReactNode, RefObject } from "react";

export interface PageShellViewProps {
  /** 子导航侧栏;保留字段兼容调用签名,实际渲染交给调用方 portal 进 WorkspaceSidebar 插槽,本组件忽略。 */
  sidebar?: ReactNode | null;
  /** 内容卡顶部固定栏。 */
  header?: ReactNode;
  /** 暴露滚动容器 ref。 */
  scrollContainerRef?: RefObject<HTMLDivElement | null>;
  className?: string;
  /** 覆盖内容包裹层默认内边距(p-4 lg:px-6)。 */
  contentClassName?: string;
  children: ReactNode;
}

/**
 * page 内容外壳(纯展示):内容卡(header + 滚动容器 + 内容)。
 * 子栏不再由本组件渲染(见 `sidebar` 字段注释),已迁至 WorkspaceSidebar 插槽 portal。
 */
export function PageShellView({
  header,
  scrollContainerRef,
  className,
  contentClassName,
  children,
}: PageShellViewProps) {
  return (
    <section className="relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-(--shell-radius) bg-(--shell-content)">
      {header}
      <div
        ref={scrollContainerRef}
        className={cn(
          "flex min-h-0 flex-1 flex-col overflow-y-auto",
          className,
        )}
      >
        <div
          className={cn(
            "flex w-full flex-1 flex-col",
            contentClassName ?? "p-4 lg:px-6",
          )}
        >
          {children}
        </div>
      </div>
    </section>
  );
}
