# 共享侧栏导航抽象 实施 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `packages/web-common/src/shell/` 建一套数据驱动、支持多组/递归多级的通用侧栏导航组件（`SidebarNav` / `SidebarRow` / `RailNav`），并把 web-agent 的一级 rail + 六个二级 sidebar 迁到它上面，消灭各处手抄的选中态样式与重复的 rail 组件。

**Architecture:** 声明式数据模型（`NavGroup[]` / 递归 `NavNode`）+ render-prop 逃生口（`renderTrailing` / `itemActions` / `renderRow`）。`SidebarNav` 内部用共享行 `SidebarRow` 渲染；动态 section（会话树/会话行）也直接组合 `SidebarRow`，业务数据/轮询/菜单逻辑仍留在各 section。`RailNav` 用 `orientation` 合并原横/竖两个 rail 组件。

**Tech Stack:** React 19 + Next 16 + Tailwind v4 + `@meshbot/design`（`cn`）+ next-intl + lucide-react。`packages/web-common`（前端共享包，`@meshbot/web-common/shell` 子路径导出）。

**Spec:** `docs/superpowers/specs/2026-07-08-shared-sidebar-nav-design.md`

## Global Constraints

- 所有 label 走各 section 的 `useTranslations`，组件只收 `ReactNode`；**禁止裸字符串**（i18n-page 规范）。
- **零回归**：每个 section 迁移后视觉（高度/间距/图标尺寸/选中态）与交互（改名/删除/未读/在线/展开/远程按需）必须与迁移前一致。
- **零破坏**：`SidebarNavItem` / `SidebarSection` / `RailNavItem` / `RailIconStrip` 现有调用点在迁移完成前保持可用（新组件建好后，旧原语保留为薄别名或原样，直到对应调用点迁完）。
- **不引入新测试栈**：仓库无 React 组件测试栈（无 RTL/jsdom/`.spec.tsx`，根 jest 排除 `packages/`）。验证 = 纯逻辑走 jest `.spec.ts`（`pnpm --filter @meshbot/web-common test`）+ 跑 web-agent 视觉/交互对齐核验。**不新增 @testing-library / jsdom**。
- 样式必须复用现有 CSS 变量（`--shell-content` / `--shell-sidebar-fg` / `--shell-sidebar-hover` / `--shell-accent` / `--shell-radius`），照抄现原语的 class，保证像素一致。
- 组件用 `"use client"`；`cn` 从 `@meshbot/design` 导入。
- 本次只改 web-agent；web-main 不动。
- 提交中文 conventional commits，结尾 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。

## 文件结构

`packages/web-common/src/shell/`：
- Create `sidebar-row.tsx` — 共享行（`SidebarRow`），从 `sidebar-nav-item.tsx` 升级而来（加 `depth`/`actions`/`href`）。
- Create `sidebar-nav.tsx` — 数据驱动递归多组多级导航（`SidebarNav` + `NavNode`/`NavGroup` 类型 + 纯逻辑 `isNavNodeActive`）。
- Create `sidebar-nav.spec.ts` — `isNavNodeActive` 等纯逻辑单测。
- Create `rail-nav.tsx` — 合并 rail（`RailNav` + `orientation`）。
- Modify `sidebar-nav-item.tsx` — 改为 re-export `SidebarRow` 的薄别名（保调用点）。
- Modify `rail-icon-strip.tsx` / `rail-nav-item.tsx` — 改为基于 `RailNav` 的薄别名（保调用点）。
- Modify `index.tsx` — 导出新组件与类型。

web-agent（`apps/web-agent/src/`）：
- Modify `components/drive/drive-sidebar.tsx`、`components/shell/more-sidebar.tsx`、`components/skills/skills-sidebar.tsx` → 用 `SidebarNav`。
- Modify `components/shell/workspace-sidebar.tsx` → rail 用 `RailNav`。
- Modify `components/shell/messages-sidebar.tsx` → `SidebarNav` + `renderTrailing`。
- Modify `components/home/recent-sessions-sidebar.tsx`、`components/sidebar/session-list-item.tsx` → 组合 `SidebarRow`。
- Modify `components/shell/assistant-sidebar.tsx`、`components/shell/device-node.tsx` → `SidebarNav` 递归 + `onExpand`/`itemActions`；`device-node` 组合 `SidebarRow`。

**验证前置（所有含"跑 web-agent"的步骤）**：dev 全家桶可能已在主检出占用 :3001。在本 worktree 用独立端口跑：`PORT=3011 pnpm dev:web-agent`（或 turbo 传参），浏览器开对应端口核验，别和主检出的 dev 抢端口。

---

### Task 1: `SidebarRow` 共享行（升级 SidebarNavItem）

**Files:**
- Create: `packages/web-common/src/shell/sidebar-row.tsx`
- Modify: `packages/web-common/src/shell/sidebar-nav-item.tsx`（改薄别名）
- Modify: `packages/web-common/src/shell/index.tsx`

**Interfaces:**
- Produces: `SidebarRow`（props: `icon?/label/active?/depth?/trailing?/actions?/onClick?/href?`）、`type SidebarRowProps`。`SidebarNavItem` 变为 `SidebarRow` 的别名（旧 props 子集）。

- [ ] **Step 1: 新建 `sidebar-row.tsx`**（照抄 `SidebarNavItem` 的 class，追加 depth 缩进 + actions 插槽 + href）

```tsx
"use client";

import { cn } from "@meshbot/design";
import type { ReactNode } from "react";

export interface SidebarRowProps {
  icon?: ReactNode;
  label: ReactNode;
  active?: boolean;
  /** 缩进级数（0 起）；每级左内边距递增，供多级树使用。 */
  depth?: number;
  /** 右侧附加内容（未读 badge / 在线点等，常驻）。 */
  trailing?: ReactNode;
  /** 右侧操作区（三点菜单等，hover 显示；与 trailing 可并存）。 */
  actions?: ReactNode;
  onClick?: () => void;
  /** 提供则渲染为链接语义（仍走 onClick 由容器接路由，这里仅占位以备将来）。 */
  href?: string;
}

/**
 * 统一侧栏行：图标 + 文字 + depth 缩进 + 可选 trailing/actions + 高亮态。
 * SidebarNav 内部逐行渲染它；带内联编辑/菜单的会话行也直接组合它（把编辑/菜单塞进
 * actions 或外层），从而复用同一套高度 h-7/间距/图标尺寸/高亮 class，消除各处手抄。
 */
export function SidebarRow({
  icon,
  label,
  active,
  depth = 0,
  trailing,
  actions,
  onClick,
}: SidebarRowProps) {
  return (
    <div
      className={cn(
        "group/row flex h-7 w-full items-center gap-2 rounded-md pr-2 text-left text-[13px] transition-colors [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:shrink-0",
        active
          ? "bg-(--shell-content) text-(--shell-sidebar-fg) shadow-sm"
          : "text-(--shell-sidebar-fg)/80 hover:bg-(--shell-sidebar-hover)",
      )}
      style={{ paddingLeft: `${8 + depth * 14}px` }}
    >
      <button
        type="button"
        onClick={onClick}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        {icon}
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </button>
      {trailing}
      {actions && (
        <span className="shrink-0 opacity-0 transition-opacity group-hover/row:opacity-100">
          {actions}
        </span>
      )}
    </div>
  );
}
```

> 注意：原 `SidebarNavItem` 是 `<button>` 整行；这里改成外层 `<div>` + 内层 `<button>`，以便 `actions` 里放独立按钮（三点菜单）不嵌套 button。depth=0 时 `paddingLeft:8px` == 原 `px-2`，视觉不变。

- [ ] **Step 2: `sidebar-nav-item.tsx` 改薄别名**（保原有 4 处调用零破坏）

```tsx
"use client";

import type { ReactNode } from "react";
import { SidebarRow } from "./sidebar-row";

interface Props {
  icon?: ReactNode;
  label: ReactNode;
  active?: boolean;
  onClick?: () => void;
  trailing?: ReactNode;
}

/** @deprecated 用 SidebarRow。保留为薄别名，迁移完成后删。 */
export function SidebarNavItem(props: Props) {
  return <SidebarRow {...props} />;
}
```

- [ ] **Step 3: `index.tsx` 导出 `SidebarRow`**

在导出块加：
```tsx
export { SidebarRow, type SidebarRowProps } from "./sidebar-row";
```

- [ ] **Step 4: 验证 typecheck + 现有调用点不破**

Run: `pnpm --filter @meshbot/web-common typecheck && pnpm --filter @meshbot/web-agent typecheck`
Expected: PASS（`SidebarNavItem` 仍可用，`SidebarRow` 可导入）。

- [ ] **Step 5: 提交**

```bash
git add packages/web-common/src/shell/sidebar-row.tsx packages/web-common/src/shell/sidebar-nav-item.tsx packages/web-common/src/shell/index.tsx
git commit -m "feat(web-common): 抽出共享行 SidebarRow（升级 SidebarNavItem，加 depth/actions）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `RailNav` 合并 rail（RailNavItem + RailIconStrip）

**Files:**
- Create: `packages/web-common/src/shell/rail-nav.tsx`
- Modify: `packages/web-common/src/shell/rail-icon-strip.tsx`、`rail-nav-item.tsx`（薄别名）
- Modify: `packages/web-common/src/shell/index.tsx`

**Interfaces:**
- Produces: `RailNav`（props: `items: {key,icon,label}[]`、`activeKey?`、`onSelect(key)`、`orientation: "horizontal"|"vertical"`、`className?`）、`type RailNavItemModel`。

- [ ] **Step 1: 新建 `rail-nav.tsx`**（横排照抄 `RailIconStrip` 的 grid + class；竖排照抄 `RailNavItem` 的竖排 class）

```tsx
"use client";

import { cn } from "@meshbot/design";
import type { ReactNode } from "react";

export interface RailNavItemModel {
  key: string;
  icon: ReactNode;
  label: string;
}

export interface RailNavProps {
  items: RailNavItemModel[];
  activeKey?: string;
  onSelect: (key: string) => void;
  orientation: "horizontal" | "vertical";
  className?: string;
}

/** 一级区域 rail：横排（宽 sidebar 顶部条，web-agent）或竖排（窄 rail，web-main）。 */
export function RailNav({
  items,
  activeKey,
  onSelect,
  orientation,
  className,
}: RailNavProps) {
  if (orientation === "horizontal") {
    return (
      <nav
        className={cn("grid gap-1", className)}
        style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}
      >
        {items.map((it) => (
          <button
            key={it.key}
            type="button"
            onClick={() => onSelect(it.key)}
            title={it.label}
            className={cn(
              "flex flex-col items-center gap-1 rounded-lg py-2 text-[9.5px] font-semibold transition-colors [&_svg]:h-5 [&_svg]:w-5",
              it.key === activeKey
                ? "bg-(--shell-accent)/12 text-(--shell-accent)"
                : "text-(--shell-sidebar-fg)/65 hover:bg-(--shell-sidebar-hover) hover:text-(--shell-sidebar-fg)",
            )}
          >
            {it.icon}
            <span>{it.label}</span>
          </button>
        ))}
      </nav>
    );
  }
  return (
    <nav className={cn("flex flex-col gap-1", className)}>
      {items.map((it) => {
        const active = it.key === activeKey;
        return (
          <button
            key={it.key}
            type="button"
            onClick={() => onSelect(it.key)}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex w-full flex-col items-center gap-1 py-1 transition-colors",
              active ? "text-white" : "text-white/65 hover:text-white",
            )}
          >
            <span
              className={cn(
                "flex h-9 w-9 items-center justify-center rounded-(--shell-radius) transition-colors",
                active ? "bg-(--shell-accent)" : "hover:bg-white/10",
              )}
            >
              {it.icon}
            </span>
            <span className="text-[10px] leading-none">{it.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
```

- [ ] **Step 2: `rail-icon-strip.tsx` 改薄别名**（现用 `items:[{key,icon,label,active,onClick}]`，桥接到 `RailNav horizontal`）

```tsx
"use client";

import type { ReactNode } from "react";
import { RailNav } from "./rail-nav";

interface RailIconItem {
  key: string;
  icon: ReactNode;
  label: string;
  active?: boolean;
  onClick?: () => void;
}
export interface RailIconStripProps {
  items: RailIconItem[];
  className?: string;
}

/** @deprecated 用 RailNav orientation="horizontal"。薄别名保调用点。 */
export function RailIconStrip({ items, className }: RailIconStripProps) {
  const activeKey = items.find((i) => i.active)?.key;
  return (
    <RailNav
      orientation="horizontal"
      className={className}
      items={items.map(({ key, icon, label }) => ({ key, icon, label }))}
      activeKey={activeKey}
      onSelect={(key) => items.find((i) => i.key === key)?.onClick?.()}
    />
  );
}
```

- [ ] **Step 3: `rail-nav-item.tsx` 改薄别名**（竖排单项，桥接到单项 `RailNav vertical`）

```tsx
"use client";

import type { ReactNode } from "react";
import { RailNav } from "./rail-nav";

interface RailNavItemProps {
  icon: ReactNode;
  label: string;
  active?: boolean;
  onClick?: () => void;
}

/** @deprecated 用 RailNav orientation="vertical"。薄别名保调用点（web-main workspace-rail 用）。 */
export function RailNavItem({ icon, label, active, onClick }: RailNavItemProps) {
  return (
    <RailNav
      orientation="vertical"
      items={[{ key: "item", icon, label }]}
      activeKey={active ? "item" : undefined}
      onSelect={() => onClick?.()}
    />
  );
}
```

> 注：web-main `workspace-rail.tsx` 逐个渲染 `RailNavItem`——薄别名保证零破坏；本次不改 web-main。

- [ ] **Step 4: `index.tsx` 导出 `RailNav`**

```tsx
export { RailNav, type RailNavProps, type RailNavItemModel } from "./rail-nav";
```

- [ ] **Step 5: 验证 typecheck**

Run: `pnpm --filter @meshbot/web-common typecheck && pnpm --filter @meshbot/web-agent typecheck && pnpm --filter @meshbot/web-main typecheck`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add packages/web-common/src/shell/rail-nav.tsx packages/web-common/src/shell/rail-icon-strip.tsx packages/web-common/src/shell/rail-nav-item.tsx packages/web-common/src/shell/index.tsx
git commit -m "feat(web-common): 合并 rail 为 RailNav（orientation 横/竖），旧组件转薄别名

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `SidebarNav` 数据驱动递归多组多级导航

**Files:**
- Create: `packages/web-common/src/shell/sidebar-nav.tsx`
- Create: `packages/web-common/src/shell/sidebar-nav.spec.ts`
- Modify: `packages/web-common/src/shell/index.tsx`

**Interfaces:**
- Consumes: `SidebarRow`（Task 1）。
- Produces: `SidebarNav`、`type NavNode`、`type NavGroup`、纯函数 `isNavNodeActive(node, activeKey): boolean`（含递归子孙命中）。

- [ ] **Step 1: 先写纯逻辑失败测试 `sidebar-nav.spec.ts`**

```ts
import { isNavNodeActive, type NavNode } from "./sidebar-nav";

const tree: NavNode = {
  key: "device-1",
  label: "设备1",
  children: [
    { key: "s-1", label: "会话1" },
    { key: "s-2", label: "会话2" },
  ],
};

describe("isNavNodeActive", () => {
  it("自身 key 命中 → true", () => {
    expect(isNavNodeActive({ key: "a", label: "" }, "a")).toBe(true);
  });
  it("子孙 key 命中 → true（用于父节点高亮/展开）", () => {
    expect(isNavNodeActive(tree, "s-2")).toBe(true);
  });
  it("都不命中 → false", () => {
    expect(isNavNodeActive(tree, "s-9")).toBe(false);
  });
  it("activeKey 为空 → false", () => {
    expect(isNavNodeActive(tree, undefined)).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @meshbot/web-common test -- sidebar-nav`
Expected: FAIL（`isNavNodeActive` / 模块不存在）。

- [ ] **Step 3: 实现 `sidebar-nav.tsx`**

```tsx
"use client";

import type { ReactNode } from "react";
import { useState } from "react";
import { ChevronDown, Plus } from "lucide-react";
import { cn } from "@meshbot/design";
import { SidebarRow, type SidebarRowProps } from "./sidebar-row";
import { SidebarSkeleton } from "./sidebar-skeleton";

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
      if (node.href) node.onClick?.();
      else node.onClick?.() ?? props.onSelect?.(node);
    },
  };
  return (
    <>
      {props.renderRow ? props.renderRow(node, defaults) : <SidebarRow {...defaults} />}
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
            <ChevronDown className={cn("h-3 w-3 transition-transform", open ? "" : "-rotate-90")} />
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
```

> 注：`SidebarRow` 的 svg 统一 `h-3.5 w-3.5`，故 icon 里的 lucide 组件不用自带 size class（照抄现 `SidebarNavItem` 语义）。分组标题/折叠/onAdd 的 class 照抄 `SidebarSection`，保证与现有分组视觉一致。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @meshbot/web-common test -- sidebar-nav`
Expected: PASS（4 个用例）。

- [ ] **Step 5: `index.tsx` 导出 + typecheck**

加：
```tsx
export {
  SidebarNav,
  isNavNodeActive,
  type NavNode,
  type NavGroup,
  type SidebarNavProps,
} from "./sidebar-nav";
```
Run: `pnpm --filter @meshbot/web-common typecheck`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add packages/web-common/src/shell/sidebar-nav.tsx packages/web-common/src/shell/sidebar-nav.spec.ts packages/web-common/src/shell/index.tsx
git commit -m "feat(web-common): 新增数据驱动递归多组多级 SidebarNav + isNavNodeActive 单测

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: 迁移 `drive-sidebar`（最简，验证 SidebarNav）

**Files:** Modify `apps/web-agent/src/components/drive/drive-sidebar.tsx`

**Interfaces:** Consumes `SidebarNav`、`NavGroup`（Task 3）。

- [ ] **Step 1: 用 `SidebarNav` 重写 body**（保持外层 header + 容器 class 不变，仅把 `SidebarNavItem` 列表换成单组 `SidebarNav`）

```tsx
"use client";

import { SidebarNav, type NavGroup } from "@meshbot/web-common/shell";
import { HardDrive, Users } from "lucide-react";
import { useTranslations } from "next-intl";

export type DriveTab = "mine" | "shared";

interface Props {
  activeTab: DriveTab;
  onSelect: (tab: DriveTab) => void;
}

export function DriveSidebar({ activeTab, onSelect }: Props) {
  const t = useTranslations("drive");
  const groups: NavGroup[] = [
    {
      key: "tabs",
      items: [
        { key: "mine", label: t("tabMine"), icon: <HardDrive />, onClick: () => onSelect("mine") },
        { key: "shared", label: t("tabShared"), icon: <Users />, onClick: () => onSelect("shared") },
      ],
    },
  ];
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center px-3 text-[15px] font-extrabold">
        {t("title")}
      </div>
      <nav className="flex flex-col px-3 py-2">
        <SidebarNav groups={groups} activeKey={activeTab} />
      </nav>
    </div>
  );
}
```

- [ ] **Step 2: typecheck**

Run: `pnpm --filter @meshbot/web-agent typecheck`
Expected: PASS。

- [ ] **Step 3: 跑 web-agent 视觉/交互对齐核验**

Run（本 worktree，独立端口）：`PORT=3011 pnpm dev:web-agent`（等 Ready），浏览器开 `http://localhost:3011`，进「文件」区。
Expected：侧栏「我的文件 / 共享给我的」两项外观（h-7 行、图标、选中橙底 `--shell-content`）与改动前一致；点击切 tab 主区正常切换、选中态跟随。（对照 git 里改动前的视觉。）

- [ ] **Step 4: 提交**

```bash
git add apps/web-agent/src/components/drive/drive-sidebar.tsx
git commit -m "refactor(web-agent): drive-sidebar 迁移到 SidebarNav

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: 迁移 `more-sidebar`

**Files:** Modify `apps/web-agent/src/components/shell/more-sidebar.tsx`

**Interfaces:** Consumes `SidebarNav`、`NavGroup`。

- [ ] **Step 1: 用 `SidebarNav` 重写**（active 由 pathname 算 → 传 `activeKey`）

```tsx
"use client";

import { SidebarNav, type NavGroup } from "@meshbot/web-common/shell";
import { BarChart3, Clock, Workflow } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

export function MoreSidebar() {
  const t = useTranslations("settingsSidebar");
  const tRail = useTranslations("appShell");
  const router = useRouter();
  const pathname = usePathname();

  const activeKey = pathname.startsWith("/flows")
    ? "flows"
    : pathname.startsWith("/schedule")
      ? "scheduled"
      : pathname === "/more"
        ? "usage"
        : undefined;

  const groups: NavGroup[] = [
    {
      key: "more",
      items: [
        { key: "flows", label: tRail("rail.flows"), icon: <Workflow />, onClick: () => router.push("/flows") },
        { key: "usage", label: t("usage"), icon: <BarChart3 />, onClick: () => router.push("/more") },
        { key: "scheduled", label: t("scheduled"), icon: <Clock />, onClick: () => router.push("/schedule") },
      ],
    },
  ];

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center px-3 text-[15px] font-extrabold">
        {tRail("rail.more")}
      </div>
      <nav className="flex flex-col px-3 py-2">
        <SidebarNav groups={groups} activeKey={activeKey} />
      </nav>
    </div>
  );
}
```

> 图标去掉了原来的 `h-4 w-4`——`SidebarRow` 统一 `[&_svg]:h-3.5`，与其它已迁项一致（原 more 用 h-4 是偏差，迁后统一到 3.5；核验时确认可接受，若要保 4 则给 icon 显式尺寸）。

- [ ] **Step 2: typecheck + 跑 web-agent 核验「更多」区**（3 项、当前路由高亮、点击跳转）
Run: `pnpm --filter @meshbot/web-agent typecheck`；`PORT=3011 pnpm dev:web-agent` → 进「更多」。
Expected: 三项外观/高亮/跳转与改动前一致。

- [ ] **Step 3: 提交**
```bash
git add apps/web-agent/src/components/shell/more-sidebar.tsx
git commit -m "refactor(web-agent): more-sidebar 迁移到 SidebarNav

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: 迁移 `skills-sidebar`（带分组）

**Files:** Modify `apps/web-agent/src/components/skills/skills-sidebar.tsx`

**Interfaces:** Consumes `SidebarNav`、`NavGroup`。

- [ ] **Step 1: 用 `SidebarNav` 重写**（「已安装」单项无标题组 + 「市场来源」有标题组）

```tsx
"use client";

import type { SkillInstallSource } from "@meshbot/types-agent";
import { SidebarNav, type NavGroup } from "@meshbot/web-common/shell";
import { BookOpen, Package, Store } from "lucide-react";
import { useTranslations } from "next-intl";

type MarketView = Exclude<SkillInstallSource, "github">;
export type SkillsView = MarketView | "installed";

interface Props {
  activeView: SkillsView;
  onSelect: (view: SkillsView) => void;
}

export function SkillsSidebar({ activeView, onSelect }: Props) {
  const t = useTranslations("skills");
  const groups: NavGroup[] = [
    {
      key: "installed",
      items: [{ key: "installed", label: t("installed"), icon: <Package />, onClick: () => onSelect("installed") }],
    },
    {
      key: "market",
      title: t("market"),
      items: [
        { key: "system", label: t("sourceOurMarket"), icon: <Store />, onClick: () => onSelect("system") },
        { key: "clawhub", label: t("sourceClawhub"), icon: <BookOpen />, onClick: () => onSelect("clawhub") },
      ],
    },
  ];
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center px-3">
        <span className="text-[15px] font-extrabold">{t("title")}</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-2">
        <SidebarNav groups={groups} activeKey={activeView} onSelect={(n) => onSelect(n.key as SkillsView)} />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: typecheck + 跑 web-agent 核验「技能」区**（已安装单项 + 市场来源段标题 + 两来源切换）
Run: `pnpm --filter @meshbot/web-agent typecheck`；`PORT=3011 pnpm dev:web-agent` → 进「技能」。
Expected: 与改动前一致（含「市场来源」分组标题样式）。

- [ ] **Step 3: 提交**
```bash
git add apps/web-agent/src/components/skills/skills-sidebar.tsx
git commit -m "refactor(web-agent): skills-sidebar 迁移到 SidebarNav

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: 迁移一级 rail（workspace-sidebar → RailNav）

**Files:** Modify `apps/web-agent/src/components/shell/workspace-sidebar.tsx`

**Interfaces:** Consumes `RailNav`（Task 2）。

- [ ] **Step 1: 读现状**：`workspace-sidebar.tsx` 里 `items`（5 项 assistant/messages/skills/drive/more，各带 `key/icon/label/active/onClick`）+ `<RailIconStrip items={items} className="px-3" />`（约 :98-149）。

- [ ] **Step 2: 换成 `RailNav`**：import 从 `RailIconStrip` 改 `RailNav`；把 items 里的 `active`/`onClick` 抽出为 `activeKey`（当前 active 项的 key）+ `onSelect(key)`（映射回原 onClick）。items 只留 `{key,icon,label}`。

```tsx
// import { BrandLogo, RailNav } from "@meshbot/web-common/shell";
// 组装（保留原 5 项的 icon/label/路由 onClick 逻辑，只改传参形态）：
const activeKey = items.find((i) => i.active)?.key;
// ...
<RailNav
  orientation="horizontal"
  className="px-3"
  items={items.map(({ key, icon, label }) => ({ key, icon, label }))}
  activeKey={activeKey}
  onSelect={(key) => items.find((i) => i.key === key)?.onClick?.()}
/>
```
（若嫌绕，可直接把原 items 的 `onClick` 内联进一个 `onSelect` switch；保持路由行为不变即可。）

- [ ] **Step 3: typecheck + 跑 web-agent 核验一级切区**（5 图标横排、当前区橙高亮、点击切区）
Run: `pnpm --filter @meshbot/web-agent typecheck`；`PORT=3011 pnpm dev:web-agent`。
Expected: 顶部一级图标条外观/高亮/切区与改动前一致。

- [ ] **Step 4: 提交**
```bash
git add apps/web-agent/src/components/shell/workspace-sidebar.tsx
git commit -m "refactor(web-agent): 一级 rail 迁移到 RailNav

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: 迁移 `messages-sidebar`（SidebarNav + renderTrailing）

**Files:** Modify `apps/web-agent/src/components/shell/messages-sidebar.tsx`

**Interfaces:** Consumes `SidebarNav`、`NavGroup`、`renderTrailing`。

- [ ] **Step 1: 读现状**：现用 `SidebarSection`（私信/频道两组）+ `SidebarNavItem`（`trailing` 挂未读数）+ `SidebarSkeleton`，数据来自 `conversationsAtom`；在线圆点/未读 badge 是 section 业务态。

- [ ] **Step 2: 重写**：把 conversationsAtom 派生的两组数据构造成 `NavGroup[]`（`key/title` = 私信/频道，`items` 每项 `{key: conversationId, label: 名称, icon: 头像/在线圆点占位}`）。未读 badge / 在线圆点用 `renderTrailing={(node) => ...}` 从 atom 数据按 `node.key` 查出来渲染。`loading` → 传 `SidebarSkeleton`（`SidebarNav loading`）。选中态 `activeKey` = 当前会话 id，点击 `onSelect` 走原路由/选中逻辑。**conversationsAtom 订阅、未读计算、在线态来源全部留在本组件**，只把渲染交给 SidebarNav。

> 具体字段名以 `messages-sidebar.tsx` 现有实现为准（读文件后照搬数据来源）。保持两组标题（`SidebarSection` → `NavGroup.title`，`collapsible: true` 若原本可折叠）、未读/在线视觉不变。

- [ ] **Step 3: typecheck + 跑 web-agent 核验「消息」区**（私信/频道两组、未读 badge、在线圆点、选中、点击进会话）
Run: `pnpm --filter @meshbot/web-agent typecheck`；`PORT=3011 pnpm dev:web-agent` → 进「消息」。
Expected: 分组/未读/在线/选中/交互与改动前一致。

- [ ] **Step 4: 提交**
```bash
git add apps/web-agent/src/components/shell/messages-sidebar.tsx
git commit -m "refactor(web-agent): messages-sidebar 迁移到 SidebarNav（未读/在线走 renderTrailing）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: 迁移 `session-list-item` + `recent-sessions-sidebar`（组合 SidebarRow）

**Files:** Modify `apps/web-agent/src/components/sidebar/session-list-item.tsx`、`apps/web-agent/src/components/home/recent-sessions-sidebar.tsx`

**Interfaces:** Consumes `SidebarRow`（Task 1）。

- [ ] **Step 1: 读现状**：`session-list-item.tsx` 手写了与 `SidebarNavItem` 几乎相同的 class（`:106-111`），外加内联改名输入、三点菜单（改名/固定/删除）、删除确认弹窗、定时活动小红点；`recent-sessions-sidebar.tsx` 直接渲染 `SessionListItem`，单组，不用原语。

- [ ] **Step 2: 改 `session-list-item.tsx` 组合 `SidebarRow`**：删掉手抄的 rowBase class，改成 `<SidebarRow icon=... label=... active=... trailing={活动小红点} actions={三点菜单触发器} onClick=... />`。**内联改名态**（正在改名时渲染 `<input>` 而非普通行）用 `renderRow` 思路：改名态下不套 SidebarRow、渲染原来的 input 行（保留原逻辑）；非改名态套 SidebarRow。三点菜单 dropdown/删除确认弹窗逻辑原样保留，只是触发器放进 `actions`。

> 目标：消灭 `:106-111` 手抄 class，选中态/高度/间距改由 SidebarRow 统一；改名/菜单/删除/小红点行为零变化。

- [ ] **Step 3: 改 `recent-sessions-sidebar.tsx`**：继续渲染 `SessionListItem`（现在内部已用 SidebarRow），本文件通常无需大改；若它也手写了行 class 则一并去掉。sessionsAtom 订阅不变。

- [ ] **Step 4: typecheck + 跑 web-agent 核验「首页/会话列表」**：最近会话行外观（与其它侧栏行齐平）、hover 出三点菜单、改名（内联 input）、删除（确认弹窗）、固定、定时活动小红点全部照旧。
Run: `pnpm --filter @meshbot/web-agent typecheck`；`PORT=3011 pnpm dev:web-agent`。
Expected: 视觉对齐 + 上述交互零回归。

- [ ] **Step 5: 提交**
```bash
git add apps/web-agent/src/components/sidebar/session-list-item.tsx apps/web-agent/src/components/home/recent-sessions-sidebar.tsx
git commit -m "refactor(web-agent): 会话行组合 SidebarRow（消灭手抄选中态 class）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: 迁移 `assistant-sidebar`（设备→会话递归树）

**Files:** Modify `apps/web-agent/src/components/shell/assistant-sidebar.tsx`、`apps/web-agent/src/components/shell/device-node.tsx`

**Interfaces:** Consumes `SidebarNav`（`onExpand`/`itemActions`/`renderTrailing`）、`SidebarRow`。这是最硬的一个，最后做。

- [ ] **Step 1: 读现状**：`assistant-sidebar.tsx` 从 `devicesAtom` → 展开 `sessionsAtom`/`remoteSessionsAtom`，含在线态轮询、远程按需拉取；树节点用自写 `DeviceNode`（`device-node.tsx:28-114`，其行 class `:143-148` 手抄）。

- [ ] **Step 2: 构造 `NavGroup[]` 递归模型**：设备为一级 `NavNode`（`key: deviceId`，`children`: 该设备的会话 `NavNode[]`，`key: sessionId`）。会话项的改名/删除菜单 → `itemActions={(node)=>...}`；在线态/小红点 → `renderTrailing`；**远程会话按需拉取**接 `onExpand={(node)=> 若是设备节点则触发该设备 remoteSessions 拉取}`（替代原展开副作用）。在线态轮询、devicesAtom/sessionsAtom/remoteSessionsAtom 订阅与拉取逻辑**全部留在 assistant-sidebar.tsx**，只把「已装配好的树数据」喂给 SidebarNav。`loading` → `SidebarNav loading`。

- [ ] **Step 3: 处理 `device-node.tsx`**：优先直接删除、用 `SidebarNav` 的递归渲染取代；若设备节点行需要特殊内容（设备名 + 在线徽标 + 会话数）而 `renderTrailing`/`icon` 表达不了，则让 `device-node` 保留但**改为组合 `SidebarRow`**（去掉 `:143-148` 手抄 class），并通过 SidebarNav 的 `renderRow` 注入。以「不再手抄 class」为硬指标。

- [ ] **Step 4: typecheck + 跑 web-agent 深度核验「助手」区**：设备分组、展开设备→会话、远程设备首次展开触发远程会话拉取、在线态、会话改名/删除、选中当前会话——**逐项对照改动前**，这是回归风险最高的一个。
Run: `pnpm --filter @meshbot/web-agent typecheck`；`PORT=3011 pnpm dev:web-agent` → 进「助手」，用本机 + 一个远程设备各验一遍。
Expected: 树展开/远程按需/在线/改名删除/选中全部零回归。

- [ ] **Step 5: 提交**
```bash
git add apps/web-agent/src/components/shell/assistant-sidebar.tsx apps/web-agent/src/components/shell/device-node.tsx
git commit -m "refactor(web-agent): assistant 设备→会话树迁移到 SidebarNav 递归（数据/轮询留 section）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 收尾（迁移完成后）

- [ ] **可选清理**：确认 `SidebarNavItem` / `RailIconStrip` / `RailNavItem` 在 web-agent 内已无直接调用（仅 web-main 还用 `RailNavItem`），保留别名给 web-main；`SidebarSection` 若 web-agent 已无调用亦可标记 deprecated（web-main 未用）。**不删** web-main 仍依赖的别名。
- [ ] **全量围栏 + typecheck**：`pnpm --filter @meshbot/web-common test`（sidebar-nav 逻辑）、`pnpm typecheck`、`pnpm check`（静态围栏）、`pnpm --filter @meshbot/web-agent lint` 全绿。
- [ ] **web-agent 整体回扫**：六区 + 一级 rail 一次性点一遍，确认「一套布局」观感达成（这正是用户最初诉求）。

## 自检（对照 spec）

- spec §3.1 `SidebarNav`（数据模型 + props + 逃生口 + 递归）→ Task 3 ✅
- spec §3.2 `SidebarRow`（depth/actions，动态 section 组合）→ Task 1 + Task 9/10 ✅
- spec §3.3 `RailNav`（orientation 合并）→ Task 2 + Task 7 ✅
- spec §4 迁移表（drive/more/skills/messages/rail/home+session-list/assistant）→ Task 4–10 ✅
- spec §5 不做（web-main / 业务逻辑 / drive 主区 / registry / PageHeader 高度）→ 均未纳入 ✅
- spec §6 测试（纯逻辑单测 + 视觉/交互对齐）→ Task 3 单测 + 各迁移 Step「跑 web-agent 核验」✅（已按「无组件测试栈」现实调整，不硬造组件单测）
- spec §7 验收（全走新组件 + 零回归 + 别名零破坏 + 单测/typecheck/围栏绿）→ 收尾清单 ✅

命名/类型一致性：`SidebarRow`/`SidebarRowProps`、`SidebarNav`/`NavNode`/`NavGroup`/`SidebarNavProps`/`isNavNodeActive`、`RailNav`/`RailNavItemModel`/`RailNavProps` 在 Task 1/2/3 定义，Task 4–10 一致引用。
