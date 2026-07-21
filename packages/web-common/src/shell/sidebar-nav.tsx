"use client";

import { cn } from "@meshbot/design";
import { ChevronDown, Plus } from "lucide-react";
import { useState } from "react";
import {
  isNavNodeActive,
  type NavGroup,
  type NavNode,
  type SidebarNavProps,
} from "./nav-model";
import { SidebarRow, type SidebarRowProps } from "./sidebar-row";
import { SidebarSkeleton } from "./sidebar-skeleton";

export type { NavGroup, NavNode, SidebarNavProps } from "./nav-model";
export { isNavNodeActive } from "./nav-model";

function NavItem({
  node,
  depth,
  props,
}: {
  node: NavNode;
  depth: number;
  props: SidebarNavProps;
}) {
  const hasChildren = !!node.children?.length;
  // 受控展开态：传了 node.open 就以它为准，局部 state 只在非受控场景下参与
  // （见 NavNode.open 的 JSDoc）。useState 仍无条件调用——不能按 controlled
  // 分支跳过，否则同一节点在受控/非受控间切换会踩 Hooks 调用顺序规则。
  const controlled = node.open !== undefined;
  const [localOpen, setLocalOpen] = useState(
    node.defaultOpen ?? isNavNodeActive(node, props.activeKey),
  );
  const open = controlled ? node.open === true : localOpen;
  const defaults: SidebarRowProps = {
    icon: hasChildren ? (
      <ChevronDown
        className={cn("transition-transform", open ? "" : "-rotate-90")}
      />
    ) : node.chevronPlaceholder ? (
      // 恒折叠、不可点的占位 chevron——只对齐左缘，不参与 open/toggle 逻辑
      // （hasChildren 为假时下面的 onClick 本来就不会走 toggle 分支）。
      <ChevronDown className="-rotate-90 opacity-40" />
    ) : (
      node.icon
    ),
    label: node.label,
    active: node.key === props.activeKey,
    depth,
    trailing: props.renderTrailing?.(node) ?? node.trailing,
    actions: props.itemActions?.(node),
    onClick: () => {
      if (hasChildren) {
        const next = !open;
        // 受控时局部 state 不参与——下一次渲染的 open 完全来自调用方回传的
        // node.open，这里 setLocalOpen 只会写一个没人读的死 state。
        if (!controlled) setLocalOpen(next);
        props.onToggle?.(node, next);
        if (next) props.onExpand?.(node);
        return;
      }
      if (node.href) {
        node.onClick?.();
      } else if (node.onClick) {
        node.onClick();
      } else {
        props.onSelect?.(node);
      }
    },
  };
  return (
    <>
      {props.renderRow ? (
        props.renderRow(node, defaults)
      ) : (
        <SidebarRow {...defaults} />
      )}
      {hasChildren && open && (
        <div className="space-y-0.5">
          {node.children?.map((c) => (
            <NavItem key={c.key} node={c} depth={depth + 1} props={props} />
          ))}
        </div>
      )}
    </>
  );
}

function Group({ group, props }: { group: NavGroup; props: SidebarNavProps }) {
  const [open, setOpen] = useState(group.defaultOpen ?? true);
  const body = (
    <div className="mt-0.5 space-y-0.5">
      {group.items.map((n) => (
        <NavItem key={n.key} node={n} depth={0} props={props} />
      ))}
    </div>
  );
  if (!group.title) return body;
  return (
    <div className="mb-1.5">
      <div className="group flex h-6 items-center gap-1 px-2 text-[11px] font-semibold tracking-wide text-(--shell-sidebar-fg)/50">
        {group.collapsible ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="flex items-center gap-1 transition-colors hover:text-(--shell-sidebar-fg)/75"
          >
            <ChevronDown
              className={cn(
                "h-3 w-3 transition-transform",
                open ? "" : "-rotate-90",
              )}
            />
            <span>{group.title}</span>
          </button>
        ) : (
          <span>{group.title}</span>
        )}
        {group.onAdd && (
          <button
            type="button"
            onClick={group.onAdd}
            title={group.addLabel}
            className="ml-auto opacity-0 transition-opacity hover:text-(--shell-sidebar-fg)/80 group-hover:opacity-100"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {(!group.collapsible || open) && body}
    </div>
  );
}

/** 数据驱动的多组 / 递归多级侧栏导航。 */
export function SidebarNav(props: SidebarNavProps) {
  if (props.loading) return <SidebarSkeleton />;
  return (
    <div className="space-y-0.5">
      {props.groups.map((g) => (
        <Group key={g.key} group={g} props={props} />
      ))}
    </div>
  );
}
