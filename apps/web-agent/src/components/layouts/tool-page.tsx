"use client";

import type { ReactNode, RefObject } from "react";
import { PageHeader } from "@/components/layouts/page-header";
import { PageShell } from "@/components/layouts/page-shell";

interface ToolPageProps {
  /** 页头标题。 */
  title: ReactNode;
  /** 页头右侧操作区。 */
  actions?: ReactNode;
  /** 页头标题行下方的可选标签/筛选行。 */
  tabs?: ReactNode;
  /** 子导航：传入则渲染，null/undefined 不渲染。透传给 PageShell.sidebar。 */
  sidebar?: ReactNode | null;
  /** 透传滚动容器 ref（与 PageShell 一致）。 */
  scrollContainerRef?: RefObject<HTMLDivElement | null>;
  /** 覆盖内容包裹层默认内边距（透传 PageShell.contentClassName）。 */
  contentClassName?: string;
  /**
   * 内容体：直接渲染进 PageShell 既有的「全宽 + 标准内边距」包裹层。
   * 禁止再套 mx-auto、max-w-N、额外 p-N（重复内边距 + 多宽度的来源）；
   * 需要纵向分段间距时内部自行 flex flex-col gap-N。
   */
  children: ReactNode;
}

/**
 * 二级页统一外壳：组合 PageShell + PageHeader，内容体走 PageShell 既有的
 * 全宽 + 标准内边距包裹层。页面只写声明式壳（标题 + 操作 + 可选标签 + 内容），
 * 宽度、内边距、页头形态全部由本组件锁定，消除各页自拼包裹层的乱象。
 *
 * 持久骨架（rail / dock / resize）由 (shell)/layout 承担，本组件只管页面内容。
 */
export function ToolPage({
  title,
  actions,
  tabs,
  sidebar,
  scrollContainerRef,
  contentClassName,
  children,
}: ToolPageProps) {
  return (
    <PageShell
      sidebar={sidebar}
      scrollContainerRef={scrollContainerRef}
      contentClassName={contentClassName}
      header={<PageHeader title={title} actions={actions} tabs={tabs} />}
    >
      {children}
    </PageShell>
  );
}
