"use client";
import { PageShellView } from "@meshbot/web-common/shell";
import type { ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";
import { useSidebarSlot } from "@/components/shell/sidebar-slot-context";

interface PageShellProps {
  sidebar?: ReactNode | null;
  header?: ReactNode;
  scrollContainerRef?: RefObject<HTMLDivElement | null>;
  className?: string;
  contentClassName?: string;
  children: ReactNode;
}

/**
 * 内容壳容器:子栏不再自渲染,portal 进 WorkspaceSidebar 的子栏插槽;
 * 内容(header/滚动容器/children)透给共享 PageShellView 渲染。
 */
export function PageShell({ sidebar, ...content }: PageShellProps) {
  const slot = useSidebarSlot();
  return (
    <>
      {sidebar && slot ? createPortal(sidebar, slot) : null}
      <PageShellView {...content} />
    </>
  );
}
