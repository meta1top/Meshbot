# 共享 layout 持久化外壳（dock 切页不 remount）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把共享外壳的持久骨架（rail + topbar + dock + resize）提到 Next.js `app/(shell)/layout.tsx`，page 只渲染会变的内容（PageShell：侧栏 + 内容卡），切 page 时 dock 不 remount、不闪。

**Architecture:** route group `app/(shell)/` 共享 `layout.tsx` 持久骨架；`AppShellLayout` 拆成「layout 骨架」+「`PageShell` 内容组件」；dock 宽度 measure 的 `sidebarRef` 经 `ShellRefsContext` 从 layout 下发给 PageShell（跨层）。

**Tech Stack:** Next.js App Router（static export）/ Jotai / React Context。

## Global Constraints

- route group `(shell)` 不进 URL —— `/messages`、`/skills` 等路径**保持不变**。
- 只迁移**用外壳**的 6 个 page：`messages`、`messages/new`、`more`、`schedule`、`settings/org`、`skills`。`login`/`register`/根 `page.tsx`/`session` **不动**（不用外壳）。
- 持久层全留 layout：`assistantPanelWidthAtom`/`previewPanelWidthAtom`/`assistantPanelTypeAtom`/`previewArtifactAtom`/`assistantPanelOpenAtom`/`sidebarDrawerOpenAtom` 仍全局，layout 读写。
- dock 宽度上限语义不变：助手 ≤50%、预览 ≤90%，`avail = 内容区容器宽 − 侧栏宽`。
- `static export`（`output: "export"`）：用 `useSearchParams` 的组件需在 `<Suspense>` 边界内。
- 这是**原子重构**：Task 2 一次性切换（layout + ToolPage + 移 page + 删 AppShellLayout），中间态会断，不可拆开提交。
- 中文 JSDoc；不在 `if` 前一行放注释；中文提交。

---

## File Structure

**新建**：
- `apps/web-agent/src/components/layouts/shell-refs-context.tsx` —— `ShellRefsContext`（下发 `sidebarRef`）。
- `apps/web-agent/src/components/layouts/page-shell.tsx` —— `PageShell`（侧栏 + 内容卡，page 内容容器）。
- `apps/web-agent/src/app/(shell)/layout.tsx` —— 持久骨架（rail + topbar + dock + resize）。

**移动（git mv，URL 不变）**：`app/{messages,messages/new,more,schedule,settings/org,skills}` → `app/(shell)/…`。

**改**：6 个 page（messages/messages-new 改用 PageShell；其余用 ToolPage 的内容不变）、`components/layouts/tool-page.tsx`（基于 PageShell）。

**删**：`components/layouts/app-shell-layout.tsx`。

---

## Task 1: ShellRefsContext + PageShell（新组件，不破坏现有）

**Files:** Create `apps/web-agent/src/components/layouts/shell-refs-context.tsx`、`apps/web-agent/src/components/layouts/page-shell.tsx`

**Interfaces:**
- Produces `ShellRefsContext` / `useShellRefs(): { sidebarRef: RefObject<HTMLElement | null> }`。
- Produces `PageShell`（props：`sidebar?: ReactNode | null`、`header?: ReactNode`、`scrollContainerRef?: RefObject<HTMLDivElement | null>`、`children: ReactNode`、`className?: string`）。

> 本任务只新增组件，不改 AppShellLayout / ToolPage / page，现有功能不受影响（typecheck 验证编译即可）。

- [ ] **Step 1: ShellRefsContext** — 创建 `shell-refs-context.tsx`：

```tsx
"use client";

import { createContext, type RefObject, useContext } from "react";

/** layout 下发给 PageShell 的共享 ref：侧栏元素（dock 宽度 measure 要减它）。 */
interface ShellRefs {
  sidebarRef: RefObject<HTMLElement | null>;
}

export const ShellRefsContext = createContext<ShellRefs | null>(null);

/** 读取 layout 下发的 refs；必须在 (shell)/layout 内使用。 */
export function useShellRefs(): ShellRefs {
  const ctx = useContext(ShellRefsContext);
  if (!ctx) {
    throw new Error("useShellRefs 必须在 ShellLayout 内使用");
  }
  return ctx;
}
```

- [ ] **Step 2: PageShell** — 创建 `page-shell.tsx`（侧栏 + 内容卡，从 AppShellLayout 的内容部分抽出；侧栏 ref 挂 context 下发的 sidebarRef；侧栏遮罩在此）：

```tsx
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
  children,
}: PageShellProps) {
  const t = useTranslations("appShell");
  const { sidebarRef } = useShellRefs();
  const [sidebarDrawerOpen, setSidebarDrawerOpen] = useAtom(sidebarDrawerOpenAtom);

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
            "z-40 flex flex-col w-[260px] shrink-0 overflow-hidden bg-(--shell-sidebar) transition-transform duration-200",
            "absolute top-0 bottom-1.5 left-0 rounded-(--shell-radius) shadow-2xl",
            sidebarDrawerOpen ? "translate-x-0" : "-translate-x-full",
            "md:static md:z-auto md:w-[240px] md:translate-x-0 md:rounded-r-none md:shadow-none md:transition-none",
          )}
        >
          {sidebar}
        </aside>
      )}
      <section className="relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-(--shell-radius) bg-(--shell-content)">
        {header}
        <div
          ref={scrollContainerRef}
          className={cn("flex min-h-0 flex-1 flex-col overflow-y-auto", className)}
        >
          <div className="flex w-full flex-1 flex-col p-4 lg:px-6">{children}</div>
        </div>
      </section>
    </>
  );
}
```

> 注：上面 `<section>` / `<aside>` 的 className 必须与现 `app-shell-layout.tsx` 对应元素**逐字一致**（实现时打开 app-shell-layout.tsx 第 204-242 行核对侧栏 aside、内容卡 section、滚动容器 div 的 class，原样搬，勿改样式）。

- [ ] **Step 3: typecheck + 提交**

```bash
pnpm turbo typecheck --filter=@meshbot/web-agent
npx biome check --write apps/web-agent/src/components/layouts/shell-refs-context.tsx apps/web-agent/src/components/layouts/page-shell.tsx
git add apps/web-agent/src/components/layouts/shell-refs-context.tsx apps/web-agent/src/components/layouts/page-shell.tsx
git commit -m "feat(web-agent): ShellRefsContext + PageShell（page 内容外壳）"
```

---

## Task 2: 原子切换 —— (shell)/layout + ToolPage + 移 page + 删 AppShellLayout

**Files:**
- Create `apps/web-agent/src/app/(shell)/layout.tsx`
- Move `app/{messages,messages/new,more,schedule,settings/org,skills}` → `app/(shell)/…`
- Modify `apps/web-agent/src/app/(shell)/messages/page.tsx`、`apps/web-agent/src/app/(shell)/messages/new/page.tsx`（AppShellLayout → PageShell）、`components/layouts/tool-page.tsx`（基于 PageShell）
- Delete `apps/web-agent/src/components/layouts/app-shell-layout.tsx`

**Interfaces:** Consumes `PageShell`/`useShellRefs`/`ShellRefsContext`（Task 1）。

> **原子任务**：以下步骤必须一次做完再提交（中间态路由会断）。

- [ ] **Step 1: (shell)/layout.tsx** — 创建持久骨架。把 `app-shell-layout.tsx` 的**骨架部分**搬来：state（assistantWidth/previewWidth/isResizing/panelType/previewArtifact/isPreview/effectiveWidth/availW/panelOpen）+ contentRef + sidebarRef + measure effect + app-shell-mode effect + esc effect + 侧栏抽屉 auto-close effect + startPanelResize + useGlobalEvents；render 为 main + DragRegion + ShellTopBar + flex（WorkspaceRail + 内容区容器`ref=contentRef`{children}+ resize handle + dock 遮罩 + dock aside）。用 `ShellRefsContext.Provider value={{ sidebarRef }}` 包裹。

```tsx
"use client";

import { cn } from "@meshbot/design";
import { useAtom, useAtomValue } from "jotai";
import { usePathname, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  assistantPanelOpenAtom,
  assistantPanelTypeAtom,
  assistantPanelWidthAtom,
  previewArtifactAtom,
  previewPanelWidthAtom,
  sidebarDrawerOpenAtom,
} from "@/atoms/assistant-panel";
import { AssistantDock } from "@/components/im/assistant-dock";
import { DragRegion } from "@/components/drag-region";
import { ShellTopBar } from "@/components/shell/shell-top-bar";
import { WorkspaceRail } from "@/components/shell/workspace-rail";
import { useGlobalEvents } from "@/hooks/use-global-events";
import { ShellRefsContext } from "@/components/layouts/shell-refs-context";

function ShellInner({ children }: { children: ReactNode }) {
  const t = useTranslations("appShell");
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [panelOpen, setPanelOpen] = useAtom(assistantPanelOpenAtom);
  const [, setSidebarDrawerOpen] = useAtom(sidebarDrawerOpenAtom);
  useGlobalEvents();
  const [assistantWidth, setAssistantWidth] = useAtom(assistantPanelWidthAtom);
  const [previewWidth, setPreviewWidth] = useAtom(previewPanelWidthAtom);
  const [isResizing, setIsResizing] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const [availW, setAvailW] = useState(0);
  const panelType = useAtomValue(assistantPanelTypeAtom);
  const previewArtifact = useAtomValue(previewArtifactAtom);
  const isPreview = panelType === "preview" && !!previewArtifact;
  const effectiveWidth = isPreview
    ? previewWidth > 0
      ? `${previewWidth}px`
      : availW > 0
        ? `${Math.round(availW * 0.5)}px`
        : "50vw"
    : `${assistantWidth}px`;

  useEffect(() => {
    const update = () => {
      const c = contentRef.current?.clientWidth ?? 0;
      const s = sidebarRef.current?.clientWidth ?? 0;
      setAvailW(c - s);
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  const startPanelResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsResizing(true);
      const startX = e.clientX;
      const cw = contentRef.current?.clientWidth ?? window.innerWidth;
      const sw = sidebarRef.current?.clientWidth ?? 0;
      const avail = cw - sw;
      const maxW = isPreview
        ? Math.round(avail * 0.9)
        : Math.round(avail * 0.5);
      const startW = isPreview
        ? previewWidth > 0
          ? previewWidth
          : Math.round(avail * 0.5)
        : assistantWidth;
      const onMove = (ev: MouseEvent) => {
        const next = Math.min(
          Math.max(startW + (startX - ev.clientX), 300),
          maxW,
        );
        if (isPreview) {
          setPreviewWidth(next);
        } else {
          setAssistantWidth(next);
        }
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.userSelect = "";
        setIsResizing(false);
      };
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [isPreview, assistantWidth, previewWidth, setAssistantWidth, setPreviewWidth],
  );

  useEffect(() => {
    document.body.classList.add("app-shell-mode");
    return () => document.body.classList.remove("app-shell-mode");
  }, []);

  const sp = searchParams.toString();
  // biome-ignore lint/correctness/useExhaustiveDependencies: 仅在 pathname / query 变化时收起
  useEffect(() => {
    setSidebarDrawerOpen(false);
  }, [pathname, sp, setSidebarDrawerOpen]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setSidebarDrawerOpen(false);
      setPanelOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setSidebarDrawerOpen, setPanelOpen]);

  return (
    <ShellRefsContext.Provider value={{ sidebarRef }}>
      <main className="titlebar-safe flex h-screen flex-col bg-(--shell-chrome) text-foreground">
        <DragRegion />
        <ShellTopBar />
        <div className="flex min-h-0 flex-1">
          <WorkspaceRail />
          <div
            ref={contentRef}
            className="relative flex min-h-0 flex-1 overflow-hidden pr-1.5 pb-1.5"
          >
            {children}
            {panelOpen && (
              <div
                aria-hidden
                onMouseDown={startPanelResize}
                className="group hidden w-2 shrink-0 cursor-col-resize xl:flex xl:items-center"
              >
                <div className="mx-auto h-12 w-1 rounded-full bg-white/20 transition-colors group-hover:bg-(--shell-accent)" />
              </div>
            )}
            {panelOpen && (
              <button
                type="button"
                aria-label={t("assistant")}
                onClick={() => setPanelOpen(false)}
                className="absolute top-0 right-1.5 bottom-1.5 left-0 z-30 rounded-(--shell-radius) bg-black/50 xl:hidden"
              />
            )}
            <aside
              style={{ width: effectiveWidth }}
              className={cn(
                "z-40 flex shrink-0 overflow-hidden bg-(--shell-content)",
                "absolute top-0 bottom-1.5 right-0 max-w-[88vw] rounded-(--shell-radius) shadow-2xl transition-transform duration-200",
                panelOpen ? "translate-x-0" : "translate-x-full",
                "xl:static xl:z-auto xl:max-w-none xl:translate-x-0 xl:rounded-(--shell-radius) xl:shadow-none xl:transition-none",
                !panelOpen && "xl:hidden",
              )}
            >
              <AssistantDock />
            </aside>
            {isResizing && <div className="fixed inset-0 z-50 cursor-col-resize" />}
          </div>
        </div>
      </main>
    </ShellRefsContext.Provider>
  );
}

/** (shell) 段共享布局：持久骨架（rail/topbar/dock/resize），切 page 不 remount。 */
export default function ShellLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={null}>
      <ShellInner>{children}</ShellInner>
    </Suspense>
  );
}
```

> 实现时打开 `app-shell-layout.tsx` 逐行核对：aside（dock）、resize handle、dock 遮罩的 className 必须**逐字一致**（样式不变）。layout **不** import `artifactFullscreenAtom`（那是 shell-top-bar 自管，layout 用不到）。biome `--write` 后确认 import 顺序与无未用项。`<ShellInner>` 用 `useSearchParams` 故包 `<Suspense>`。

- [ ] **Step 2: ToolPage 基于 PageShell** — 改 `tool-page.tsx`：

```tsx
"use client";

import type { ReactNode, RefObject } from "react";
import { PageHeader } from "@/components/layouts/page-header";
import { PageShell } from "@/components/layouts/page-shell";

interface ToolPageProps {
  title: ReactNode;
  actions?: ReactNode;
  tabs?: ReactNode;
  sidebar?: ReactNode | null;
  scrollContainerRef?: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}

/** 二级页统一外壳：PageShell + PageHeader。页面只写声明式壳（标题 + 操作 + 内容）。 */
export function ToolPage({
  title,
  actions,
  tabs,
  sidebar,
  scrollContainerRef,
  children,
}: ToolPageProps) {
  return (
    <PageShell
      sidebar={sidebar}
      scrollContainerRef={scrollContainerRef}
      header={<PageHeader title={title} actions={actions} tabs={tabs} />}
    >
      {children}
    </PageShell>
  );
}
```

- [ ] **Step 3: 移 6 个 page 到 (shell)**（git mv，URL 不变）：

```bash
cd apps/web-agent/src/app
mkdir -p "(shell)"
git mv messages "(shell)/messages"
git mv more "(shell)/more"
git mv schedule "(shell)/schedule"
git mv settings "(shell)/settings"
git mv skills "(shell)/skills"
```

（`messages/new` 随 `messages` 一起移。）

- [ ] **Step 4: messages page 改用 PageShell** — `app/(shell)/messages/page.tsx`：把 `import { AppShellLayout } from "@/components/layouts/app-shell-layout"` 改为 `import { PageShell } from "@/components/layouts/page-shell"`，JSX `<AppShellLayout scrollContainerRef={…} header={…}>…</AppShellLayout>` 改为 `<PageShell scrollContainerRef={…} header={…}>…</PageShell>`（props 同名，直接换标签 + import）。messages page 不传 sidebar，但它需要消息侧栏 —— **改为显式传** `sidebar={<MessagesSidebar />}`（import `MessagesSidebar`，因为去掉了 area-based 自动选）。先 `rg -n "MessagesSidebar" apps/web-agent/src/components/shell/` 确认路径。

- [ ] **Step 5: messages/new page 改用 PageShell** — `app/(shell)/messages/new/page.tsx`：`AppShellLayout` → `PageShell`（同 import + 标签替换；它原无 props，PageShell 无 sidebar/header 时只渲染内容卡）。

- [ ] **Step 6: 删 AppShellLayout** — `git rm apps/web-agent/src/components/layouts/app-shell-layout.tsx`。

- [ ] **Step 7: 收尾 import + 验证** — `rg -rn "app-shell-layout|AppShellLayout" apps/web-agent/src` 应为空（无残留引用）；`pnpm turbo typecheck --filter=@meshbot/web-agent` 全绿；`npx biome check --write` 改动文件。

- [ ] **Step 8: 提交**

```bash
git add -A apps/web-agent/src/app apps/web-agent/src/components/layouts
git commit -m "refactor(web-agent): 外壳骨架提到 (shell)/layout 持久化，dock 切页不 remount"
```

---

## Task 3: 集成验证（typecheck + jest + 手动）

- [ ] **Step 1: 全包 typecheck** — `pnpm typecheck`，全绿。
- [ ] **Step 2: 全量 jest** — `pnpm test`：2 个失败套件仍是预存在基线（session.e2e、use-global-events.spec），零新增。
- [ ] **Step 3: 静态围栏** — `pnpm check`，exit 0。
- [ ] **Step 4: 手动验证（必做，逐 page + 切页不闪）** — `pnpm dev:web-agent`（或在 desktop 壳）：
  - messages（IM 频道 + 助手会话）、skills、more、schedule、settings/org 各自正常显示、URL 不变。
  - **rail 切「消息↔技能↔更多」→ 右侧 dock 不闪、stream 不重连**（核心目标）。
  - 窄屏（< md）侧栏抽屉 + 遮罩；窄屏（< xl）dock 抽屉 + 遮罩。
  - dock resize：助手 ≤50%、预览 ≤90%，不挤没内容；助手↔预览切换宽度各自记忆。
  - 产物预览：present_file → 文件框 → dock 预览 → 全屏 / 下载 / tab 切换正常。

---

## Self-Review（已核对）

- **Spec 覆盖**：§2 route group + 移 6 page（Task 2 Step 3）；§3 layout 骨架（Task 2 Step 1）；§4 PageShell（Task 1 Step 2）；§5 dock measure context sidebarRef（Task 1 context + Task 2 layout sidebarRef + PageShell 挂载）；§4 ToolPage 基于 PageShell（Task 2 Step 2）；§4 sidebar 统一显式传（Task 2 Step 4 messages 显式 MessagesSidebar）；§7 删 AppShellLayout（Task 2 Step 6）；§8 测试（Task 3）。
- **原子性**：Task 2 标注一次做完（layout + ToolPage + 移 page + 改 messages + 删 AppShellLayout），中间态会断。
- **类型一致**：`ShellRefsContext`/`useShellRefs`（Task 1）→ layout Provider（Task 2 Step 1）+ PageShell 消费（Task 1 Step 2）；`PageShell` props（sidebar/header/scrollContainerRef/children）（Task 1）→ ToolPage（Task 2 Step 2）+ messages page（Task 2 Step 4）一致；`sidebarRef: RefObject<HTMLElement|null>` 在 context、layout、PageShell aside ref 三处一致。
- **占位符**：无 TBD；className「逐字核对 app-shell-layout」是真实搬运指令（非占位），因样式必须与原一致。
