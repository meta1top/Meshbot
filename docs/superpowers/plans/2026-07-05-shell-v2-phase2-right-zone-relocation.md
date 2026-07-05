# Shell v2 · Phase 2 右区落位 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 拆掉常驻右列（RightZone），把它承载的三样各自落位：**产物预览 → 中区分栏**（对话 | 产物，可拖宽/可关）、**随手问 → 右下角浮动气泡（FAB）**（点击展开浮动面板）、**频道成员 → 会话头已有控件**（私有频道 header 内已含成员/添加/退出）。同时清掉 ShellTopBar 的 ✦ 触发与 Phase 1 遗留的窄屏死汉堡。

**Architecture:** 复用现有 `AssistantDock(chromeless)` 作 FAB 面板内容、`ArtifactBody` 作产物正文；复用 layout 现有 resize/aside 机制承接产物分栏（改由 `previewArtifactAtom` 门控、不再是 tab 容器）。三个新家先各自建好（不接线、可编译），最后一次性层换 + 删 RightZone/atoms。参考 spec `2026-07-05-two-column-shell-redesign-design.md` §7。

**Tech Stack:** Next.js 15 · Tailwind v4 · jotai · React。

## Global Constraints

- **仅 web-agent，仅右区**。不动左栏（Phase 1 已完成的 WorkspaceSidebar）、不动区页面业务数据、不碰后端、不碰 web-main。
- **不破坏功能**：产物预览、随手问、私有频道成员/添加/退出（会话头已有）迁移后都要工作；任意会话/区切换正常。
- **视觉**：产物分栏 = 中区右侧一块白卡（`bg-(--shell-content)`），可拖宽、可关；随手问 FAB = 内容区右下角焦橙气泡（`bg-(--shell-accent)`），点击展开锚定右下的浮动面板（可关回气泡）。焦橙克制。
- **成员落法**：会话头 `ImConversationHeader` 的 `PrivateChannelControls`（私有频道成员 popover/添加/退出）**保留不动**;删 RightZone 会连带去掉「公开频道」的 members tab —— 公开频道成员列表是次要面，**本期接受移除**（记 follow-up，需要再补 header 版）。
- commit：中文 conventional，结尾 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`；**禁 `--no-verify`**。
- 验证：每任务 `pnpm --filter web-agent typecheck`（+ Task 3 `build`）+ 人工冒烟。

---

## 前置事实（post-Phase-1 现状，实现者须知）

- **layout**（`apps/web-agent/src/app/(shell)/layout.tsx`，已 Phase 1 改）：`ShellInner` 里 —— `DragRegion` + `ShellTopBar` + `<div flex flex-1>`(`WorkspaceSidebar` + 内容 `<div ref=contentRef relative flex flex-1 pr-1.5 pb-1.5>`)。内容 div 内:`SidebarSlotContext.Provider`(children) + **resize 手柄**(`panelOpen` 时，:90-98) + 窄屏遮罩(:99-106) + 右 `<aside width=assistantWidth>`挂 `<RightZone/>`(:107-118) + resize overlay(:119-121)。`panelOpen`=`assistantPanelOpenAtom`,`assistantWidth`=`assistantPanelWidthAtom`;ESC 关 panel(:68-75)。
- **RightZone**（`components/shell/right-zone.tsx`）：tab 条(`availableContextTabsAtom`:artifact + members-if-channel) + 钉 ✦quick;body 三选一 `AssistantDock chromeless` / `ArtifactBodyPane`(同文件 :84-143) / `MembersPanel`。
- **atoms/right-zone.ts**：`RightTab`/`selectedContextTabAtom`/`availableContextTabsAtom`/`effectiveRightTabAtom`——**整文件 Phase 2 删**。
- **atoms/assistant-panel.ts**：保留 `assistantPanelOpenAtom`(FAB 开关)/`assistantPanelWidthAtom`(产物分栏宽)/`previewArtifactAtom`(产物)/`quickAssistantNameAtom`(FAB 标题)/`currentQuickSessionIdAtom`(dock);**删** `assistantPanelTypeAtom`(legacy DockTabs 用)、`sidebarDrawerOpenAtom`(死汉堡);`artifactFullscreenAtom` 若仅 ShellTopBar ✦ 用则删。
- **ShellTopBar**（`components/shell/shell-top-bar.tsx`）：✦ 按钮(:72-93,toggle panelOpen+设 quick tab) **删**;窄屏汉堡(:37-45,toggle `sidebarDrawerOpenAtom`)**删**;前进/后退/搜索占位/帮助 保留。
- **成员**：`ImConversationHeader`(`components/im/im-conversation-header.tsx`)已含 `PrivateChannelControls`(私有频道:成员数+`MembersPopover`+添加+退出)——**保留**。`MembersPanel`(`components/im/members-panel.tsx`)仅 RightZone 用,随 RightZone 删。
- `AssistantDock`(`components/im/assistant-dock.tsx`)有 `chromeless` prop(跳过自带 h-13 头);`DockTabs`(`components/im/dock-tabs.tsx`)是 legacy 死代码(仅 AssistantDock 非 chromeless 头用,而 chromeless 跳过)——核对无消费后删。

---

## Task 1: `ArtifactSplitPane`（产物中区分栏正文，抽独立）

**Files:**
- Create: `apps/web-agent/src/components/artifact/artifact-split-pane.tsx`

**Interfaces:**
- Produces: `ArtifactSplitPane`（无 props）——读 `previewArtifactAtom`,渲染 工具栏(标题/下载/关闭) + `ArtifactBody`;关闭清 `previewArtifactAtom`。

- [ ] **Step 1: 抽组件**

把 `right-zone.tsx` 里的 `ArtifactBodyPane`(:84-143)抽成独立文件 `artifact-split-pane.tsx`,改名 `ArtifactSplitPane`,**去掉对 `selectedContextTabAtom` 的依赖**(该 atom 要删)——关闭只 `setPreviewArtifact(null)`。空态文案沿用 `rightZone.artifactEmpty`/`artifactUntitled`/`artifactDownload`/`artifactClose`(i18n key 保持)。代码同 ArtifactBodyPane,只删 `setSelectedContextTab` 那行 + 其 import。

```tsx
"use client";
import { useAtomValue, useSetAtom } from "jotai";
import { Download, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { previewArtifactAtom } from "@/atoms/assistant-panel";
import { ArtifactBody, downloadArtifact } from "@/components/artifact/artifact-body";

/** 产物中区分栏正文：工具栏(标题/下载/关闭) + ArtifactBody。关闭清 previewArtifactAtom。 */
export function ArtifactSplitPane() {
  const t = useTranslations("rightZone");
  const artifact = useAtomValue(previewArtifactAtom);
  const setPreviewArtifact = useSetAtom(previewArtifactAtom);
  if (!artifact) {
    return (
      <div className="flex h-full items-center justify-center text-[12px] text-muted-foreground">
        {t("artifactEmpty")}
      </div>
    );
  }
  const title = artifact.title ?? artifact.name ?? artifact.path?.split("/").pop() ?? t("artifactUntitled");
  return (
    <div className="flex h-full flex-col bg-(--shell-content)">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">{title}</span>
        <button type="button" title={t("artifactDownload")} onClick={() => void downloadArtifact({ path: artifact.path, url: artifact.url, name: title })} className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"><Download className="h-3.5 w-3.5" /></button>
        <button type="button" title={t("artifactClose")} onClick={() => setPreviewArtifact(null)} className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"><X className="h-3.5 w-3.5" /></button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <ArtifactBody path={artifact.path} url={artifact.url} name={artifact.name} />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: typecheck + commit**

Run: `pnpm --filter web-agent typecheck` → exit 0（组件未被使用,但导出、编译通过）
Commit: `feat(web-agent): 产物中区分栏正文 ArtifactSplitPane（抽自 RightZone）`

---

## Task 2: `QuickAssistantFab`（随手问右下角气泡 + 浮动面板）

**Files:**
- Create: `apps/web-agent/src/components/im/quick-assistant-fab.tsx`

**Interfaces:**
- Consumes: `assistantPanelOpenAtom`（开关）、`quickAssistantNameAtom`（面板标题）、`AssistantDock`（chromeless 面板内容）。
- Produces: `QuickAssistantFab`（无 props）——收起态=右下角焦橙气泡;展开态=锚定右下的浮动面板(头部标题+关闭 + `AssistantDock chromeless`)。

- [ ] **Step 1: 写组件**

`quick-assistant-fab.tsx`:

```tsx
"use client";
import { useAtom, useAtomValue } from "jotai";
import { Sparkles, X } from "lucide-react";
import { assistantPanelOpenAtom, quickAssistantNameAtom } from "@/atoms/assistant-panel";
import { AssistantDock } from "@/components/im/assistant-dock";

/** 随手问：右下角浮动气泡,点击展开成锚定右下的浮动面板(内容=AssistantDock chromeless)。 */
export function QuickAssistantFab() {
  const [open, setOpen] = useAtom(assistantPanelOpenAtom);
  const name = useAtomValue(quickAssistantNameAtom);
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={name}
        title={name}
        className="absolute right-4 bottom-4 z-30 flex h-12 w-12 items-center justify-center rounded-full bg-(--shell-accent) text-white shadow-lg shadow-(--shell-accent)/30 transition-transform hover:scale-105"
      >
        <Sparkles className="h-5 w-5" />
      </button>
    );
  }
  return (
    <div className="absolute right-4 bottom-4 z-40 flex h-[560px] max-h-[calc(100%-2rem)] w-[380px] max-w-[calc(100%-2rem)] flex-col overflow-hidden rounded-(--shell-radius) border border-border bg-(--shell-content) shadow-2xl">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <Sparkles className="h-4 w-4 text-(--shell-accent)" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">{name}</span>
        <button type="button" onClick={() => setOpen(false)} aria-label="close" className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"><X className="h-4 w-4" /></button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <AssistantDock chromeless />
      </div>
    </div>
  );
}
```

> 注：气泡/面板都 `absolute`，须挂在 `position:relative` 的内容容器里（layout 的 `contentRef` div 已是 `relative`，Task 3 接线时放进去）。若 `AssistantDock` chromeless 尚有自带标题需求，保持现状即可（面板已提供头）。

- [ ] **Step 2: typecheck + commit**

Run: `pnpm --filter web-agent typecheck` → exit 0
Commit: `feat(web-agent): 随手问右下角浮动气泡 QuickAssistantFab`

---

## Task 3: 层换 + 清理（删 RightZone / atoms / ShellTopBar ✦ / 死汉堡）

**Files:**
- Modify: `apps/web-agent/src/app/(shell)/layout.tsx`
- Modify: `apps/web-agent/src/components/shell/shell-top-bar.tsx`
- Modify: `apps/web-agent/src/atoms/assistant-panel.ts`
- Delete: `apps/web-agent/src/components/shell/right-zone.tsx`、`apps/web-agent/src/atoms/right-zone.ts`、`apps/web-agent/src/components/im/members-panel.tsx`、`apps/web-agent/src/components/im/dock-tabs.tsx`（各删前 grep 确认无其它消费）

- [ ] **Step 1: layout 接产物分栏 + FAB**

`layout.tsx` 内容 div（`contentRef`）里：
- **产物分栏**：把现有 `<aside>`（:107-118）改为——门控从 `panelOpen` 改成 `previewArtifactAtom != null`；内容从 `<RightZone/>` 改成 `<ArtifactSplitPane/>`；宽度仍 `assistantPanelWidthAtom` + resize 手柄保留（手柄门控也改成"有产物时"）。`xl:` 静态并排、窄屏抽屉逻辑可保留（针对产物）。
- **随手问 FAB**：在内容 div 末尾加 `<QuickAssistantFab />`（它自带 absolute 右下，contentRef div 已 relative）。
- ESC（:68-75）：改成关产物或关 FAB（酌情——FAB 自身 open 态可留 ESC 关；产物 ESC 关亦可）。
- 引入 `previewArtifactAtom`；去掉不再用的 `assistantPanelOpenAtom`（若 FAB 自持则 layout 不再需要）、`RightZone` import。

- [ ] **Step 2: ShellTopBar 删 ✦ + 死汉堡**

`shell-top-bar.tsx`：删 ✦ 按钮（:72-93）+ 其 `panelOpen`/`setSelectedContextTab`/`artifactFullscreenAtom` 相关 import 与 state；删窄屏汉堡（:37-45）+ `sidebarDrawerOpenAtom` import/用法。保留前进/后退/搜索占位/帮助 + DragRegion 语义。

- [ ] **Step 3: 删 atoms + 组件**

- `atoms/assistant-panel.ts`：删 `assistantPanelTypeAtom`、`sidebarDrawerOpenAtom`；`artifactFullscreenAtom` 若删 ShellTopBar 后无消费则删（grep 确认）。
- 删文件 `right-zone.tsx` / `atoms/right-zone.ts` / `members-panel.tsx` / `dock-tabs.tsx`——**每个删前 `grep -rn` 全 web-agent 确认无残引**（`RightZone`/`selectedContextTabAtom`/`effectiveRightTabAtom`/`availableContextTabsAtom`/`MembersPanel`/`DockTabs`/`assistantPanelTypeAtom`）。有残引先清残引。

- [ ] **Step 4: typecheck + build + 冒烟**

Run: `pnpm --filter web-agent typecheck` → exit 0
Run: `pnpm --filter web-agent build` → 成功（8 页）
冒烟：agent 会话产出产物 → 中区右侧分栏出现、可拖宽、可关；右下角 ✦ 气泡 → 点击展开随手问面板、可关回气泡；私有频道 header 成员/添加/退出仍工作；顶栏无 ✦、无死汉堡；ESC 行为合理;暗色正常。

- [ ] **Step 5: Commit**

`refactor(web-agent): 右区落位——产物中区分栏 + 随手问 FAB，删 RightZone/右区 atoms/顶栏 ✦`

---

## 完成后（controller）

- 终审整 Phase（`review-package` MERGE_BASE HEAD → opus）。重点：产物 open/close/download 流路径完好（`previewArtifactAtom` 唯一清除点是 ArtifactSplitPane 关闭按钮）；随手问 FAB open/close 与 `AssistantDock` session 完好；删 atoms 后无残引 / 无死代码；私有频道成员未回归；ESC/resize 行为。
- **本 Phase 不含**（记下阶段）：起手台首页 `/`（Phase 3）、web-main 拉齐 + MeshBot casing（Phase 4）、公开频道成员 header 版（follow-up）、响应式左栏抽屉（spec §13）。
- 走 PR（或与 Phase 1/3 攒一起合，由用户定）。
