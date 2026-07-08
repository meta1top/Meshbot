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
  const [open, setOpen] = useState(
    node.defaultOpen ?? isNavNodeActive(node, props.activeKey),
  );
  const defaults: SidebarRowProps = {
    icon: hasChildren ? (
      <ChevronDown
        className={cn("transition-transform", open ? "" : "-rotate-90")}
      />
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
        setOpen(next);
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
