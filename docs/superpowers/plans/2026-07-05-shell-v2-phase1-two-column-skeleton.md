# Shell v2 · Phase 1 两栏壳骨架 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 web-agent 的「深窄 rail + 每页独立子栏」两列，合并成**一条浅色宽 `WorkspaceSidebar`**（方案 C：顶部 6 区图标条 + 下方当前区子栏 + 底部用户/主题）。右区/顶栏暂留（Phase 2 处理）。

**Architecture:** 一级图标条持久（layout），二级子栏仍由每页 `PageShell sidebar={…}` 提供——但不再渲染成独立 aside，而是 **portal 进 `WorkspaceSidebar` 的插槽**。这样 skills/drive 的页面本地 state（`activeView/onSelect`）原样不动，各区页面几乎零改。参考 spec `docs/superpowers/specs/2026-07-05-two-column-shell-redesign-design.md` §5/§10/§12。

**Tech Stack:** Next.js 15 App Router · Tailwind v4 · jotai · React `createPortal` · `@meshbot/web-common/shell` · `@meshbot/design`。

## Global Constraints

- **仅 web-agent，仅左栏合并**。**不动**：右区 `RightZone`/`atoms/right-zone.ts`（Phase 2）、`ShellTopBar`（暂留）、各区页面的业务逻辑与数据、后端。
- **不破坏功能**：8 个 `(shell)` 页面（assistant/messages/messages·new/skills/drive/more/schedule/flows）迁移后都要照常渲染；skills/drive 的页面内视图切换、随手问/产物(右区按需开)仍工作。
- **视觉**：整条侧栏浅暖 `bg-(--shell-sidebar)` + `text-(--shell-sidebar-fg)`；当前区图标焦橙 `--shell-accent` 高亮；选中子项白卡 `bg-(--shell-content) shadow-sm`（复用 `SidebarNavItem`）。焦橙克制。
- **收敛漂移**：skills/drive 子栏历史 `text-white` + `h-11` → 统一 `text-(--shell-sidebar-fg)` + `h-13`（与其余对齐）。
- **rail 三样搬家**：`BrandLogo`、主题切换、`UserMenu`（org 切换 + 登出）从 `workspace-rail` 移进 `WorkspaceSidebar`（顶部品牌 / 底部主题+用户）。
- commit：中文 conventional，结尾 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`；**禁 `--no-verify`**。
- 验证：无前端组件测试；每任务 = `pnpm --filter web-agent typecheck` + `pnpm --filter web-agent build` + 人工冒烟。

---

## 前置事实（实现者须知）

- `areaFromPath(pathname)` → `@/lib/area-from-path`，返回 `"assistant"|"messages"|"skills"|"drive"|"flows"|"settings"|"other"`（`/more`·`/schedule`→settings）。当前只有 `workspace-rail` 消费。
- `PageShell`（`components/layouts/page-shell.tsx`）是薄容器 → 共享 `PageShellView`（`@meshbot/web-common/shell`）。**PageShellView 被 web-agent 独用**（web-main 不用它）。其 `sidebar` prop 现渲染成 240px `<aside bg-(--shell-sidebar)>`——本 Phase 要让它不再渲染 aside（改由插槽承接）。
- `ToolPage`（`components/layouts/tool-page.tsx`）= `PageShell` + 注入 `PageHeader`。skills/drive/more/schedule 走它。
- 5 个区子栏：`components/shell/{assistant,messages,more}-sidebar.tsx`、`components/skills/skills-sidebar.tsx`、`components/drive/drive-sidebar.tsx`。各自根 `<div class="flex h-full flex-col bg-(--shell-sidebar) …"> + header + body`。flows/schedule 无子栏。
- `workspace-rail.tsx`：`w-[68px] bg-(--shell-chrome)`；BrandLogo(:92) + 6 RailNavItem(:93-130) + 主题切换(:132-147) + UserMenu(:148-207，`useOrgs`/`switchOrg`/`useLogout`/`useCloudWebUrl`)。
- layout `(shell)/layout.tsx`：`ShellInner` 里 `<WorkspaceRail/>`(:97) + 内容 div(:98-102) + 右 aside `<RightZone/>`(:120-131) + resize。

---

## Task 1: `RailIconStrip` 共享叶子（一级图标条）

**Files:**
- Create: `packages/web-common/src/shell/rail-icon-strip.tsx`
- Modify: `packages/web-common/src/shell/index.ts`

**Interfaces:**
- Produces: `RailIconStrip` — 纯展示横向图标条。
  ```ts
  interface RailIconItem { key: string; icon: ReactNode; label: string; active?: boolean; onClick?: () => void; }
  interface RailIconStripProps { items: RailIconItem[]; className?: string; }
  ```

- [ ] **Step 1: 写组件**

`packages/web-common/src/shell/rail-icon-strip.tsx`：

```tsx
"use client";

import { cn } from "@meshbot/design";
import type { ReactNode } from "react";

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

/**
 * 一级区域图标条（横向）：一排图标 + 极小标签，当前区焦橙高亮。
 * 放在 WorkspaceSidebar 顶部，点击切区（onClick 由容器接路由）。
 */
export function RailIconStrip({ items, className }: RailIconStripProps) {
  return (
    <nav
      className={cn(
        "grid gap-1 px-2 [grid-template-columns:repeat(6,minmax(0,1fr))]",
        className,
      )}
    >
      {items.map((it) => (
        <button
          key={it.key}
          type="button"
          onClick={it.onClick}
          title={it.label}
          className={cn(
            "flex flex-col items-center gap-1 rounded-lg py-2 text-[9.5px] font-semibold transition-colors [&_svg]:h-5 [&_svg]:w-5",
            it.active
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
```

- [ ] **Step 2: barrel 导出**

`packages/web-common/src/shell/index.ts` 加（字母序，`RailIconStrip` 在 `RailNavItem` 前）：

```ts
export { RailIconStrip, type RailIconStripProps } from "./rail-icon-strip";
```

- [ ] **Step 3: typecheck + commit**

Run: `pnpm --filter @meshbot/web-common typecheck` → exit 0
Commit: `feat(web-common): 一级区域图标条 RailIconStrip`

---

## Task 2: sidebar 插槽 + `WorkspaceSidebar` 容器

**Files:**
- Create: `apps/web-agent/src/components/shell/sidebar-slot-context.tsx`
- Create: `apps/web-agent/src/components/shell/workspace-sidebar.tsx`

**Interfaces:**
- Consumes: `RailIconStrip`（Task 1）、`BrandLogo`、`areaFromPath`、rail 现有的 org/logout/theme 逻辑。
- Produces:
  - `SidebarSlotContext`（`HTMLElement | null`）+ `useSidebarSlot()`
  - `WorkspaceSidebar({ sublistSlotRef }: { sublistSlotRef: (el: HTMLElement | null) => void })`

- [ ] **Step 1: 插槽 context**

`apps/web-agent/src/components/shell/sidebar-slot-context.tsx`：

```tsx
"use client";

import { createContext, useContext } from "react";

/** 当前区子栏要 portal 进的 DOM 插槽（WorkspaceSidebar 内）。null=尚未挂载。 */
export const SidebarSlotContext = createContext<HTMLElement | null>(null);

/** 页面侧读取插槽，把自己的子栏 portal 进去。 */
export function useSidebarSlot(): HTMLElement | null {
  return useContext(SidebarSlotContext);
}
```

- [ ] **Step 2: `WorkspaceSidebar`**

`apps/web-agent/src/components/shell/workspace-sidebar.tsx`——整条浅色左栏：品牌 + 「新建任务」CTA + `RailIconStrip`(6 区，接 `areaFromPath`+router) + **子栏插槽 div**（`ref={sublistSlotRef}`）+ 底部（主题切换 + `UserMenu` + 空间）。org 切换 / 登出 / 主题逻辑**从 `workspace-rail.tsx` 原样搬来**（`useOrgs`/`switchOrg`/`useLogout`/`useCloudWebUrl`/`useTheme` + `handleSwitchOrg`/`handleLogout` + `switchingRef`）。

关键结构（图标用 lucide，与 spec/rail 对齐：Bot/MessageSquare/Blocks/Folder/Workflow/Settings）：

```tsx
"use client";

import { /* DropdownMenu… */ } from "@meshbot/design";
import { useTheme } from "@meshbot/web-common/react";
import { BrandLogo, RailIconStrip } from "@meshbot/web-common/shell";
import { /* useQueryClient */ } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { Blocks, Bot, /*…*/ Folder, MessageSquare, Moon, Plus, Settings, Sun, Workflow } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
// …auth/org imports 同 workspace-rail

export function WorkspaceSidebar({
  sublistSlotRef,
}: {
  sublistSlotRef: (el: HTMLElement | null) => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const t = useTranslations("appShell");
  const { theme, toggleTheme } = useTheme();
  const area = areaFromPath(pathname);
  // …（org/logout state + handlers：从 workspace-rail 逐字搬）

  const items = [
    { key: "assistant", icon: <Bot />, label: t("rail.assistant"), active: area === "assistant", onClick: () => router.push("/assistant") },
    { key: "messages", icon: <MessageSquare />, label: t("rail.messages"), active: area === "messages", onClick: () => router.push("/messages") },
    { key: "skills", icon: <Blocks />, label: t("rail.skills"), active: area === "skills", onClick: () => router.push("/skills") },
    { key: "drive", icon: <Folder />, label: t("rail.drive"), active: area === "drive", onClick: () => router.push("/drive") },
    { key: "flows", icon: <Workflow />, label: t("rail.flows"), active: area === "flows", onClick: () => router.push("/flows") },
    { key: "settings", icon: <Settings />, label: t("rail.settings"), active: area === "settings", onClick: () => router.push("/more") },
  ];

  return (
    <aside className="flex h-full w-[264px] shrink-0 flex-col bg-(--shell-sidebar) text-(--shell-sidebar-fg)">
      {/* 品牌 */}
      <div className="flex items-center gap-2 px-4 pt-3 pb-2">
        <BrandLogo size="sm" withWordmark />
      </div>
      {/* 新建任务 CTA */}
      <button
        type="button"
        onClick={() => router.push("/")}
        className="mx-3 mb-2 flex h-9 items-center gap-2 rounded-lg bg-(--shell-chrome) px-3 text-[13px] font-bold text-white [&_svg]:h-4 [&_svg]:w-4"
      >
        <Plus /> {t("newTask")}
      </button>
      {/* 一级图标条 */}
      <RailIconStrip items={items} />
      <div className="mx-3 my-1.5 h-px bg-(--shell-sidebar-border)" />
      {/* 二级子栏插槽（各页 portal 进来） */}
      <div ref={sublistSlotRef} className="flex min-h-0 flex-1 flex-col overflow-y-auto" />
      {/* 底部：主题 + 用户 */}
      <div className="mt-auto border-t border-(--shell-sidebar-border) px-2 py-2">
        {/* 主题切换 button（搬自 rail）+ UserMenu DropdownMenu（org 切换/登出，搬自 rail） */}
      </div>
    </aside>
  );
}
```

> 实现要点：底部主题按钮 + UserMenu 的 JSX/逻辑从 `workspace-rail.tsx:132-207` 搬来，改成横向布局（头像 + 名 + 主题/更多），颜色用 `--shell-sidebar-fg` 系列（勿写死 `text-white`，因底已浅）。`newTask` 是新 i18n key（见 Task 4 一并补）。

- [ ] **Step 3: typecheck + commit**

Run: `pnpm --filter web-agent typecheck` → exit 0（此时 WorkspaceSidebar 尚未被 layout 使用，仅确认自身编译）
Commit: `feat(web-agent): WorkspaceSidebar 左栏容器 + sidebar 插槽`

---

## Task 3: `PageShell` portal 进插槽 + 各区子栏去外壳

**Files:**
- Modify: `apps/web-agent/src/components/layouts/page-shell.tsx`
- Modify: `packages/web-common/src/shell/page-shell-view.tsx`（`sidebar` 变可选不渲染 aside——见下）
- Modify: `components/shell/{assistant,messages,more}-sidebar.tsx` + `components/skills/skills-sidebar.tsx` + `components/drive/drive-sidebar.tsx`

**Interfaces:**
- Consumes: `useSidebarSlot`（Task 2）、`createPortal`。

- [ ] **Step 1: 各区子栏去掉自带外壳**

5 个子栏根 `<div class="flex h-full flex-col bg-(--shell-sidebar) text-(--shell-sidebar-fg)">`（skills/drive 是 `text-white`）→ 改为 `<div class="flex h-full flex-col">`（去 `bg-(--shell-sidebar)` 与 `text-*`——由 WorkspaceSidebar 的浅底 + `-fg` 继承）。skills/drive 的 header `h-11` → `h-13`，其内写死的 `text-white` 一并去掉。**只动这层外壳与 header 高度/色，body（SidebarSection/NavItem）不动。**

- [ ] **Step 2: `PageShellView` 的 sidebar 不再渲染 aside**

web-agent 独用 PageShellView。改：当传入 `sidebar` 时**不再**渲染 240px `<aside>`（那套响应式抽屉逻辑整块删），仅渲染内容 `<section>`。`sidebar` 改为可选、且**忽略**（保留 prop 名以免改 8 处调用签名——实际渲染交给 Task 3 Step 3 的 portal）。抽屉相关 props（`drawerOpen/onCloseDrawer/closeLabel/sidebarRef`）随 aside 一并移除；`PageShellViewProps` 精简。

> 注：确认 web-main 不消费 PageShellView（P4b 已确认手写 layout）。若 grep 到 web-main 引用则停下上报。

- [ ] **Step 3: `PageShell` 把 sidebar portal 进插槽**

`page-shell.tsx`：读 `useSidebarSlot()`；若有 `props.sidebar` 且插槽存在，`createPortal(props.sidebar, slot)`；同时把精简后的 props（不含 sidebar/drawer 系列）透给 `PageShellView` 渲染内容。移除对 `sidebarDrawerOpenAtom`/`useShellRefs` 的依赖（抽屉已删）。

```tsx
"use client";
import { PageShellView } from "@meshbot/web-common/shell";
import { createPortal } from "react-dom";
import type { ReactNode, RefObject } from "react";
import { useSidebarSlot } from "@/components/shell/sidebar-slot-context";

interface PageShellProps {
  sidebar?: ReactNode | null;
  header?: ReactNode;
  scrollContainerRef?: RefObject<HTMLDivElement | null>;
  className?: string;
  contentClassName?: string;
  children: ReactNode;
}

export function PageShell({ sidebar, ...content }: PageShellProps) {
  const slot = useSidebarSlot();
  return (
    <>
      {sidebar && slot ? createPortal(sidebar, slot) : null}
      <PageShellView {...content} />
    </>
  );
}
```

- [ ] **Step 4: typecheck**

Run: `pnpm --filter web-agent typecheck` → exit 0（layout 尚未切，可能有未用 import 警告，Task 4 收）
Commit: `refactor(web-agent): PageShell 子栏改 portal 进插槽 + 子栏去自带外壳`

---

## Task 4: `(shell)/layout` 切 WorkspaceSidebar + 退休 rail + 冒烟

**Files:**
- Modify: `apps/web-agent/src/app/(shell)/layout.tsx`
- Modify: `apps/web-agent/messages/zh.json` + `en.json`（`appShell.newTask`）
- Delete: `apps/web-agent/src/components/shell/workspace-rail.tsx`（改由 WorkspaceSidebar 承接；`areaFromPath` re-export 若被外部依赖则保留在 `@/lib`）

- [ ] **Step 1: 加 i18n `appShell.newTask`**

zh：`"newTask": "新建任务"`；en：`"newTask": "New task"`（放 `appShell` 块；跑 `pnpm sync:locales --write` 确认 zh/en 对称）。

- [ ] **Step 2: layout 切两栏**

`(shell)/layout.tsx` 的 `ShellInner`：
- 引 `WorkspaceSidebar` + `SidebarSlotContext`；`const [slotEl, setSlotEl] = useState<HTMLElement | null>(null)`。
- `<WorkspaceRail/>`(:97) → `<WorkspaceSidebar sublistSlotRef={setSlotEl} />`。
- `{children}`(:102) 外包 `<SidebarSlotContext.Provider value={slotEl}>{children}</SidebarSlotContext.Provider>`。
- **保留** `ShellTopBar`、右 aside(`RightZone`)、resize、`ShellRefsContext`（后者若仅被删掉的抽屉用则可清，编译报错为准）。
- 顶层 `bg-(--shell-chrome)` 保留（暗底透在浮层四周）。

- [ ] **Step 3: 退休 workspace-rail**

删 `workspace-rail.tsx`。`areaFromPath` 已在 `@/lib/area-from-path`，若 `workspace-rail` 是其唯一 re-export 点，检查有无别处 `from "@/components/shell/workspace-rail"` 引 `areaFromPath`（`grep`），有则改成从 `@/lib/area-from-path` 引。

- [ ] **Step 4: typecheck + build + 冒烟**

Run: `pnpm --filter web-agent typecheck` → exit 0
Run: `pnpm --filter web-agent build` → 成功（8 页面全生成）
人工冒烟：起 dev，逐一验 assistant/messages/skills/drive/more/schedule/flows —— 左栏是一条浅色列（品牌 + 新建任务 + 6 图标条 + 当前区子栏 + 底部用户）；点图标切区、子栏跟着换；skills/drive 页内视图切换仍工作;随手问/产物(顶栏 ✦ 开右区)仍能开;暗色正常。

- [ ] **Step 5: Commit**

`feat(web-agent): (shell) 切两栏——WorkspaceSidebar 替代 rail，子栏并入左栏`

---

## 完成后（controller）

- 终审整 Phase（`review-package` MERGE_BASE HEAD → opus）。重点：portal 插槽时序（切区无残留/无闪）、skills/drive 页面 state 未回归、PageShellView 精简未误伤 web-main、rail 三样（品牌/主题/UserMenu）功能完好（org 切换/登出）。
- **本 Phase 不含**（记入下阶段）：右区落位（Phase 2）、ShellTopBar 去留、起手台首页（Phase 3）、web-main 拉齐 + MeshBot casing（Phase 4）。
- 走 PR 合 main（主保护）。
