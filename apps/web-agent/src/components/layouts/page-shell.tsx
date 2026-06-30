"use client";

import { cn } from "@meshbot/design";
import { useAtom } from "jotai";
import { useTranslations } from "next-intl";
import type { ReactNode, RefObject } from "react";
import { sidebarDrawerOpenAtom } from "@/atoms/assistant-panel";
import { useShellRefs } from "./shell-refs-context";

interface PageShellProps {
  /** 子导航侧栏；null/undefined = 不渲染侧栏。 */
  sidebar?: ReactNode | null;
  /** 内容卡顶部固定栏（贴卡片顶边，不随滚动）。 */
  header?: ReactNode;
  /** 暴露滚动容器 ref（分页锚定等 page 内部用）。 */
  scrollContainerRef?: RefObject<HTMLDivElement | null>;
  className?: string;
  /** 覆盖内容包裹层默认内边距（p-4 lg:px-6）；文件浏览器式贴边页传 "p-0"。 */
  contentClassName?: string;
  children: ReactNode;
}

/**
 * page 内容外壳：侧栏（响应式抽屉）+ 内容卡（header + 滚动容器 + 内容）。
 * 渲染在 (shell)/layout 的内容区容器内（dock/resize 是它的兄弟，由 layout 渲染）。
 */
export function PageShell({
  sidebar,
  header,
  scrollContainerRef,
  className,
  contentClassName,
  children,
}: PageShellProps) {
  const t = useTranslations("appShell");
  const { sidebarRef } = useShellRefs();
  const [sidebarDrawerOpen, setSidebarDrawerOpen] = useAtom(
    sidebarDrawerOpenAtom,
  );

  return (
    <>
      {sidebar && sidebarDrawerOpen && (
        <button
          type="button"
          aria-label={t("rail.messages")}
          onClick={() => setSidebarDrawerOpen(false)}
          className="absolute top-0 right-1.5 bottom-1.5 left-0 z-30 rounded-(--shell-radius) bg-black/50 md:hidden"
        />
      )}
      {sidebar && (
        <aside
          ref={sidebarRef}
          className={cn(
            "z-40 flex flex-col w-[240px] shrink-0 overflow-hidden bg-(--shell-sidebar) transition-transform duration-200",
            "absolute top-0 bottom-1.5 left-0 rounded-(--shell-radius) shadow-2xl",
            sidebarDrawerOpen ? "translate-x-0" : "-translate-x-full",
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
