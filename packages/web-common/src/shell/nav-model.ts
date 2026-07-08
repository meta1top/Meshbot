import type { ReactNode } from "react";
import type { SidebarRowProps } from "./sidebar-row";

/**
 * 侧栏导航纯数据模型 + 纯逻辑，零运行时依赖（React / design 均为 `import type`，
 * isolatedModules 下编译期擦除）。抽出以便纯逻辑单测无需拉起组件依赖链。
 */

export interface NavNode {
  key: string;
  label: ReactNode;
  icon?: ReactNode;
  href?: string;
  onClick?: () => void;
  trailing?: ReactNode;
  children?: NavNode[];
  defaultOpen?: boolean;
}

export interface NavGroup {
  key: string;
  title?: ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
  onAdd?: () => void;
  addLabel?: string;
  items: NavNode[];
}

export interface SidebarNavProps {
  groups: NavGroup[];
  activeKey?: string;
  onSelect?: (node: NavNode) => void;
  loading?: boolean;
  onToggle?: (node: NavNode, open: boolean) => void;
  onExpand?: (node: NavNode) => void;
  renderTrailing?: (node: NavNode) => ReactNode;
  itemActions?: (node: NavNode) => ReactNode;
  renderRow?: (node: NavNode, defaults: SidebarRowProps) => ReactNode;
}

/** 纯逻辑：node 自身或任一子孙命中 activeKey。供父节点高亮/默认展开。 */
export function isNavNodeActive(node: NavNode, activeKey?: string): boolean {
  if (!activeKey) return false;
  if (node.key === activeKey) return true;
  return (node.children ?? []).some((c) => isNavNodeActive(c, activeKey));
}
