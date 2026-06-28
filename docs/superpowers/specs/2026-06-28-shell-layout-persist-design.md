# 共享 layout 持久化外壳（dock 切页不 remount）设计

> 状态：已通过 brainstorm，待评审 → writing-plans
> 日期：2026-06-28
> 关联：[[artifact-preview]]（dock 承载预览）、[[usage-atom-per-session]]（dock 并发会话）

## 1. 目标 / 根因

**根因**：每个用外壳的 page（messages 直接用 `AppShellLayout`、skills/more/schedule/settings 经 `ToolPage` → `AppShellLayout`）都在**自己内部**渲染整个外壳。rail 导航切 page 时是两个不同 page 组件，React 把整个 `AppShellLayout`（含 `AssistantDock`）**卸载重挂** → dock 的 stream 重连、重渲，视觉晃一下。

**目标**：把共享外壳的**持久骨架（rail + topbar + dock + resize）**提到 Next.js `layout`（路由切换时 persist），page 只渲染**会变的内容（侧栏 + 内容卡）**。切 page 时 dock 不 remount、不闪。

## 2. 架构（route group + 共享 layout）

```
app/(shell)/layout.tsx        ← 持久骨架（rail + topbar + dock + resize + 内容容器）
app/(shell)/messages/page.tsx ← 只渲染内容（PageShell：侧栏 + 内容卡）
app/(shell)/skills/page.tsx
app/(shell)/more/page.tsx
app/(shell)/schedule/page.tsx
app/(shell)/settings/org/page.tsx
app/(shell)/messages/new/page.tsx
```

- **route group `(shell)`** 不进 URL，路径不变（`/messages` 仍是 `/messages`）。
- 6 个用外壳的 page 物理移入 `app/(shell)/`。
- **不动**：`login` / `register` / 根 `page.tsx` / `session`（本就不用外壳，保持 `app/` 根下）。

## 3. layout 持久骨架（`app/(shell)/layout.tsx`）

把 `AppShellLayout` 的**外层骨架**搬来，渲染：
- `<main className="titlebar-safe …">` + `<DragRegion/>` + `<ShellTopBar/>`。
- 主体 `<div flex>`：`<WorkspaceRail/>` + 内容区容器（`ref={contentRef}`，`relative flex flex-1 overflow-hidden pr-1.5 pb-1.5`）。
- 内容区容器内：`{children}`（page，渲染侧栏 + 内容卡）+ `<ResizeHandle/>`（dock 左缘把手）+ dock 遮罩（< xl）+ `<AssistantDock/>`（右侧 aside，width=effectiveWidth）。
- **persist**：rail / topbar / dock / resize / 容器骨架 + dock 宽度逻辑（assistantWidth/previewWidth atom + startPanelResize + isResizing 遮罩）全留在 layout。
- Esc 关抽屉、键盘事件、`useGlobalEvents` 等壳级逻辑留 layout。

**dock 切 page 不 remount** —— layout 在同段路由切换时持久。

## 4. `PageShell` 组件（page 内容）

把 `AppShellLayout` 的**内容部分**抽成 `PageShell`（`components/layouts/page-shell.tsx`）：
- 消息侧栏 `<aside>`（响应式：md+ 内联 / < md 抽屉 translate）+ 侧栏遮罩（< md）。
- 内容卡 `<section>`：`{header}`（贴顶固定栏）+ 滚动容器（`ref={scrollContainerRef}`）+ `{children}`（page 内容，`p-4 lg:px-6` 包裹）。
- props：`sidebar` / `header` / `scrollContainerRef` / `children` / `className`（与原 AppShellLayout 内容相关 props 一致）。
- 各 page：`<PageShell sidebar=… header=… scrollContainerRef=…>{content}</PageShell>`。
- `ToolPage` 改为基于 `PageShell`（`title` → `PageHeader`，其余透传），签名不变，调用方无感。
- sidebar 的 area 自动选（messages→MessagesSidebar、more→MoreSidebar）逻辑：messages/more 由各自 page 传 sidebar；skills/settings 显式传。**统一为「page 显式传 sidebar」**（去掉 AppShellLayout 的 area-based 自动选，因 sidebar 需 page state，本就该 page 传）。

## 5. dock 宽度 measure（Context 下发 sidebarRef）

dock 宽度上限 `avail = 内容区容器宽 − 侧栏宽`（现有逻辑：助手 ≤50%、预览 ≤90%）。重构后 `contentRef` 在 layout、侧栏在 page（PageShell），跨层：

- layout 建 `sidebarRef`（`useRef<HTMLElement>`），经 **React Context（`ShellRefsContext`）下发**给 PageShell。
- PageShell 把侧栏 `<aside ref={ctx.sidebarRef}>`。
- layout 的 `startPanelResize` / availW measure 读 `contentRef` + `sidebarRef`（context 同一 ref），语义不变。
- 侧栏不存在（如 settings `sidebar={null}`）时 `sidebarRef.current` 为 null → 减 0。

## 6. 数据流 / 持久

- rail 切 page → `(shell)/layout` persist（rail + dock 不动）→ `{children}`（PageShell）变 → 侧栏/内容重渲，dock 保持挂载、stream 不重连。
- 全局 atom（`sidebarDrawerOpenAtom` / `assistantPanelOpenAtom` / `assistantPanelWidthAtom` / `previewPanelWidthAtom` / `assistantPanelTypeAtom` / `previewArtifactAtom`）不变；topbar（layout）控制，PageShell/dock 读。

## 7. 边界 / 风险

- 不用外壳的 page（login/register/根/session）不进 `(shell)`，零影响。
- sidebar 响应式抽屉 + 遮罩 → PageShell（page）；dock 遮罩 → layout。
- scrollRef 在 page（PageShell 滚动容器），page 内部用（分页锚定等）。
- `AppShellLayout` 组件删除（拆为 layout 骨架 + PageShell）；其唯一职责拆清。
- **风险**：动 6 page + 布局拆分 + 响应式 + dock measure 跨层；逐 page 手动验证不可省。

## 8. 测试

- `pnpm turbo typecheck --filter=@meshbot/web-agent` 全绿。
- `pnpm test`（web-agent jest）无回归（布局重构无新单测；纯函数若动则测）。
- **手动验证（必做，逐 page）**：messages（IM + 助手会话）/ skills / more / schedule / settings/org 各自正常显示；**rail 切 page → 右侧 dock 不闪、stream 不重连**；窄屏侧栏抽屉 + 遮罩；dock resize（助手 ≤50% / 预览 ≤90%，不挤没内容）；dock 助手↔预览切换。
- 不需 boot（纯前端）。

## 9. 涉及文件（预估）

- 新建：`app/(shell)/layout.tsx`、`components/layouts/page-shell.tsx`、`components/layouts/shell-refs-context.tsx`（sidebarRef context）。
- 移动：`app/{messages,messages/new,more,schedule,settings/org,skills}/` → `app/(shell)/…`（git mv，page.tsx 内容改用 PageShell）。
- 改：6 个 page（AppShellLayout/ToolPage → PageShell）、`components/layouts/tool-page.tsx`（基于 PageShell）。
- 删：`components/layouts/app-shell-layout.tsx`（拆分后）。
