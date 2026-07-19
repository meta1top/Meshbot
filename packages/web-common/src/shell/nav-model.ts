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
  /**
   * 无 children 时仍占一个 chevron 位（灰化、恒折叠、不可点）。
   * 用于离线远程 Agent：行不可展开，但左缘要和可展开的行对齐，否则整列参差。
   * 刻意与「给一个占位 children 撑 chevron」区分——后者会让占位子行渲染在
   * 调用方的灰化包裹之外，漏出未置灰、可 hover 的幽灵行。
   */
  chevronPlaceholder?: boolean;
  /**
   * 受控展开态。传了就以它为准（局部 state 不再参与），展开/收起完全由调用方
   * 通过 `SidebarNavProps.onToggle` 驱动。不传则沿用 `defaultOpen` + 局部 state
   * 的非受控行为（mount 时读一次），既有调用方零改动。
   */
  open?: boolean;
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
