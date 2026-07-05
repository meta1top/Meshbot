"use client";

import { cn } from "@meshbot/design";
import type { ReactNode, RefObject } from "react";

export interface PageShellViewProps {
  /** 子导航侧栏;null/undefined = 不渲染侧栏。 */
  sidebar?: ReactNode | null;
  /** 内容卡顶部固定栏。 */
  header?: ReactNode;
  /** 暴露滚动容器 ref。 */
  scrollContainerRef?: RefObject<HTMLDivElement | null>;
  className?: string;
  /** 覆盖内容包裹层默认内边距(p-4 lg:px-6)。 */
  contentClassName?: string;
  children: ReactNode;
  /** 侧栏元素 ref(dock 宽度 measure 用),容器经 context 取到后注入。 */
  sidebarRef?: RefObject<HTMLElement | null>;
  /** 窄屏抽屉是否打开(容器连 atom 注入)。 */
  drawerOpen: boolean;
  /** 关闭抽屉(点遮罩)。 */
  onCloseDrawer: () => void;
  /** 遮罩关闭按钮 aria-label(容器注入,i18n 解耦)。 */
  closeLabel: string;
}

/**
 * page 内容外壳(纯展示):侧栏(响应式抽屉)+ 内容卡(header + 滚动容器 + 内容)。
 * 数据(抽屉开关 / sidebarRef / i18n)由各 app 的薄容器注入。
 */
export function PageShellView({
  sidebar,
  header,
  scrollContainerRef,
  className,
  contentClassName,
  children,
  sidebarRef,
  drawerOpen,
  onCloseDrawer,
  closeLabel,
}: PageShellViewProps) {
  return (
    <>
      {sidebar && drawerOpen && (
        <button
          type="button"
          aria-label={closeLabel}
          onClick={onCloseDrawer}
          className="absolute top-0 right-1.5 bottom-1.5 left-0 z-30 rounded-(--shell-radius) bg-black/50 md:hidden"
        />
      )}
      {sidebar && (
        <aside
          ref={sidebarRef}
          className={cn(
            "z-40 flex flex-col w-[240px] shrink-0 overflow-hidden bg-(--shell-sidebar) transition-transform duration-200",
            "absolute top-0 bottom-1.5 left-0 rounded-(--shell-radius) shadow-2xl",
            drawerOpen ? "translate-x-0" : "-translate-x-full",
            "md:static md:z-auto md:w-[240px] md:translate-x-0 md:rounded-r-none md:shadow-none md:transition-none",
          )}
        >
          {sidebar}
        </aside>
      )}
      <section
        className={cn(
          "relative flex min-w-0 flex-1 flex-col overflow-hidden bg-(--shell-content)",
          sidebar
            ? "rounded-(--shell-radius) md:rounded-l-none"
            : "rounded-(--shell-radius)",
        )}
      >
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
    </>
  );
}
