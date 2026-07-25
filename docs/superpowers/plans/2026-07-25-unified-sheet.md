# 统一右侧 Sheet（UnifiedSheet）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新建 UnifiedSheet 单底座（遮罩/点外关闭/可拖宽/标题 border 全参数化），迁移 Agent 编辑、产物预览、助手 dock、web-main 远程会话四个场景，编辑 sheet tab 化。

**Architecture:** UnifiedSheet 基于 ResizableSheet 实现升级（保留「拖宽写 DOM 不 setState、aside 无 transition」铁律），统一标题栏三区结构（拖动区 / 标题 / 动作槽在拖动容器外）+ 条件挂载，结构性修死 Electron draggable region 吞点击。tab 用轻量自绘 SheetTabBar（不引 Radix Tabs，keep-mounted 需求下更简单）。

**Tech Stack:** React 19 · jest + @testing-library（web-common 已有测试基建）· react-hook-form（dirty 检测）

**Spec:** `docs/superpowers/specs/2026-07-25-unified-sheet-design.md`

## Global Constraints

- UnifiedSheet API 以 spec §三为准（props 逐字）；默认值：`resizable=true` `modal=false` `dismissible=true` `headerBorder=true` `minWidth=480` `maxVwRatio=0.92` `defaultWidth="30vw"`
- 标题栏恒 `h-13`；动作槽必须是拖动容器的**兄弟节点**（不靠 app-no-drag 凿洞）；`open=false` 时 aside 整体不渲染
- aside 禁 transition-duration；拖宽过程写 DOM、松手才回调 `onWidthChange` 一次
- 圆角走档位类（禁硬编码 px，[[visual-unification]] 约定）；扁平容器 0 / 悬浮 6 / 控件 2
- 禁原生 window.confirm；dirty 确认用 web-agent 现有 `ConfirmDialog`
- 用户可见字符串走 next-intl（web-common 组件用 labels props 透传，惯例同 ToolCallBlockLabels）
- 提交信息中文 conventional commits + Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>；每任务改完跑 `pnpm format`
- 工作分支 `feat/unified-sheet`（已建）

---

### Task 1: UnifiedSheet + SheetTabBar（web-common，TDD）

**Files:**
- Create: `packages/web-common/src/shell/unified-sheet.tsx`
- Create: `packages/web-common/src/shell/sheet-tab-bar.tsx`
- Test: `packages/web-common/src/shell/unified-sheet.spec.tsx`
- Modify: `packages/web-common/src/shell/index.ts`（追加两个导出；**不删** ResizableSheet 导出）

**Interfaces:**
- Produces: `UnifiedSheet(props: UnifiedSheetProps)`（spec §三逐字）；`SheetTabBar({ items: {key,label,disabled?,disabledHint?}[], active: string, onChange(key) })`

- [ ] **Step 1: 写失败的测试**（`unified-sheet.spec.tsx`，jsdom + @testing-library/react，相对导入）

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { UnifiedSheet } from "./unified-sheet";

const base = { open: true, onOpenChange: jest.fn(), title: "标题" };

describe("UnifiedSheet", () => {
  it("open=false 时不渲染 aside（条件挂载）", () => {
    const { container } = render(<UnifiedSheet {...base} open={false}>x</UnifiedSheet>);
    expect(container.querySelector("aside")).toBeNull();
  });
  it("动作槽是拖动容器的兄弟节点而非子节点", () => {
    render(<UnifiedSheet {...base} headerActions={<button type="button">act</button>}>x</UnifiedSheet>);
    const drag = document.querySelector(".drag-handle");
    expect(drag).not.toBeNull();
    expect(drag!.contains(screen.getByText("act"))).toBe(false);
  });
  it("dismissible=true 时 ESC 关闭", () => {
    const onOpenChange = jest.fn();
    render(<UnifiedSheet {...base} onOpenChange={onOpenChange}>x</UnifiedSheet>);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
  it("dismissible=false 时 ESC 触发 onDismissAttempt 而不关", () => {
    const onOpenChange = jest.fn();
    const onDismissAttempt = jest.fn();
    render(
      <UnifiedSheet {...base} onOpenChange={onOpenChange} dismissible={false} onDismissAttempt={onDismissAttempt}>x</UnifiedSheet>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onDismissAttempt).toHaveBeenCalled();
  });
  it("modal=true 渲染遮罩；点遮罩按 dismissible 分流", () => {
    const onOpenChange = jest.fn();
    const { rerender } = render(<UnifiedSheet {...base} modal onOpenChange={onOpenChange}>x</UnifiedSheet>);
    fireEvent.click(screen.getByTestId("sheet-overlay"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    const onDismissAttempt = jest.fn();
    rerender(
      <UnifiedSheet {...base} modal dismissible={false} onDismissAttempt={onDismissAttempt} onOpenChange={jest.fn()}>x</UnifiedSheet>,
    );
    fireEvent.click(screen.getByTestId("sheet-overlay"));
    expect(onDismissAttempt).toHaveBeenCalled();
  });
  it("modal=false 不渲染遮罩", () => {
    render(<UnifiedSheet {...base}>x</UnifiedSheet>);
    expect(screen.queryByTestId("sheet-overlay")).toBeNull();
  });
  it("headerBorder=false 时标题栏无底线类，headerTabs 渲染在标题栏下", () => {
    render(
      <UnifiedSheet {...base} headerBorder={false} headerTabs={<div data-testid="tabs" />}>x</UnifiedSheet>,
    );
    expect(document.querySelector(".drag-handle")!.parentElement!.className).not.toMatch(/border-b/);
    expect(screen.getByTestId("tabs")).toBeInTheDocument();
  });
  it("resizable=false 时无左缘手柄", () => {
    render(<UnifiedSheet {...base} resizable={false}>x</UnifiedSheet>);
    expect(screen.queryByLabelText("resize")).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @meshbot/web-common test -- unified-sheet`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `unified-sheet.tsx`**

以 `resizable-sheet.tsx` 为蓝本（复制其 startResize/rAF/全屏罩逻辑，注释一并带上），外层结构：

```tsx
// 结构骨架（宽度/拖宽逻辑照抄 ResizableSheet，此处省略号即照抄段）
export function UnifiedSheet({ open, onOpenChange, resizable = true, modal = false,
  dismissible = true, onDismissAttempt, title, headerActions, headerBorder = true,
  headerTabs, width, onWidthChange, minWidth = 480, maxVwRatio = 0.92,
  defaultWidth = "30vw", className, children }: UnifiedSheetProps) {
  const dismiss = useCallback(() => {
    if (dismissible) onOpenChange(false);
    else onDismissAttempt?.();
  }, [dismissible, onOpenChange, onDismissAttempt]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") dismiss(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, dismiss]);
  if (!open) return null; // 条件挂载：迫使 Electron 重算 draggable regions
  return (
    <>
      {modal && (
        <div data-testid="sheet-overlay" className="fixed inset-0 z-9999 bg-black/40"
          onClick={dismiss} aria-hidden />
      )}
      <aside role="dialog" aria-modal={modal || undefined}
        className={cn("absolute top-0 right-0 bottom-0 z-10000 flex flex-col border-l border-border bg-(--shell-content)", className)}
        style={/* 宽度逻辑照抄 ResizableSheet */}>
        {resizable && (/* 左缘 8px resize button，照抄 */)}
        {/* 标题栏：拖动区与动作槽为兄弟节点 */}
        <div className={cn("flex h-13 shrink-0 items-center", headerBorder && !headerTabs && "border-b border-border")}>
          <div className="drag-handle flex min-w-0 flex-1 items-center gap-2 self-stretch pl-4">
            {typeof title === "string"
              ? <span className="truncate text-[13px] font-semibold text-foreground">{title}</span>
              : title}
          </div>
          {headerActions && (
            <div className="flex shrink-0 items-center gap-1 pr-3">{headerActions}</div>
          )}
        </div>
        {headerTabs}
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      </aside>
    </>
  );
}
```

要点：`headerBorder && !headerTabs` ——有 tabs 时无论 headerBorder 传什么都由 tab 条承担底线（spec §三：headerBorder=false 配 tabs；实现上直接让 tabs 存在时标题不画线，调用方少一个易错项，在 JSDoc 里写明）。文件头 JSDoc 抄录 ResizableSheet 两条铁律 + 「动作槽兄弟节点」的 Electron 原因。

- [ ] **Step 4: 实现 `sheet-tab-bar.tsx`**

```tsx
export interface SheetTabItem { key: string; label: string; disabled?: boolean; disabledHint?: string; }
/** Sheet 标题栏下的轻量 tab 条：底 border 承担标题分隔线，选中项 2px 橙色下划线。 */
export function SheetTabBar({ items, active, onChange }: {
  items: SheetTabItem[]; active: string; onChange: (key: string) => void;
}) {
  return (
    <div className="flex shrink-0 items-end gap-1 border-b border-border px-4">
      {items.map((it) => (
        <button key={it.key} type="button" disabled={it.disabled} title={it.disabled ? it.disabledHint : undefined}
          onClick={() => onChange(it.key)}
          className={cn(
            "-mb-px border-b-2 px-2.5 pb-2 pt-1 text-[13px] font-medium transition-colors",
            active === it.key
              ? "border-(--shell-accent) text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground",
            it.disabled && "cursor-not-allowed opacity-40 hover:text-muted-foreground",
          )}>
          {it.label}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 5: index.ts 追加导出，跑测试到全绿**

Run: `pnpm --filter @meshbot/web-common test -- unified-sheet`　Expected: 8/8 PASS
Run: `pnpm format && pnpm typecheck`

- [ ] **Step 6: 变异抽查**（中档核心不变量）

把动作槽临时移入 drag 容器内 → 先 grep 打印确认变异落地 → 跑测试，「兄弟节点」用例必须变红 → 还原 → 全绿。

- [ ] **Step 7: Commit**　`feat(web-common): UnifiedSheet 统一右侧面板底座 + SheetTabBar`

---

### Task 2: Form 暴露 formApiRef（design 包小改）

**Files:**
- Modify: `packages/design/src/components/form/form.tsx:34-78`

**Interfaces:**
- Produces: `FormProps.formApiRef?: MutableRefObject<UseFormReturn<T> | null>`——调用方读 `formApiRef.current?.formState.isDirty`

- [ ] **Step 1: 实现**

`FormProps` 加 `formApiRef?: MutableRefObject<UseFormReturn<T> | null>`；`Form` 函数体 `useForm` 后：

```tsx
  if (formApiRef) formApiRef.current = form; // 渲染期同步赋值即可，无需 effect
```

（公开方法补中文 JSDoc：说明用途是外部读 formState/触发校验，不用于受控写入。）

- [ ] **Step 2: 验证 + Commit**

Run: `pnpm format && pnpm typecheck`（design 包无独立测试基建，消费方 Task 3 覆盖）
Commit: `feat(design): Form 增加 formApiRef——暴露 react-hook-form 实例供 dirty 检测`

---

### Task 3: Agent 编辑 sheet 迁移 + tab 化 + dirty 确认（依赖 Task 1/2）

**Files:**
- Modify: `apps/web-agent/src/components/agent/agent-editor-sheet.tsx`（shadcn Sheet → UnifiedSheet；结构重排）
- Modify: `apps/web-agent/messages/zh.json` / `en.json`（新增 key）

**Interfaces:**
- Consumes: `UnifiedSheet`、`SheetTabBar`、`Form.formApiRef`、`ConfirmDialog`（web-agent 现有，props: open/title/confirmText/cancelText/onConfirm/onCancel/destructive）

- [ ] **Step 1: 结构迁移**

删除 Sheet/SheetContent/SheetHeader/SheetFooter 引用，改为：

```tsx
const [tab, setTab] = useState<"basic" | "mcp">("basic");
const [discardOpen, setDiscardOpen] = useState(false);
const formApiRef = useRef<UseFormReturn<AgentEditorValues> | null>(null);
const requestClose = () => {
  if (formApiRef.current?.formState.isDirty) setDiscardOpen(true);
  else onOpenChange(false);
};
// open 变化时重置 tab 与确认态（每次打开回到基本信息 tab）
useEffect(() => { if (open) { setTab("basic"); setDiscardOpen(false); } }, [open]);

<UnifiedSheet
  open={open}
  onOpenChange={onOpenChange}
  modal
  dismissible={false}
  onDismissAttempt={requestClose}
  title={isCreate ? t("createTitle") : t("editTitle")}
  headerActions={
    <button type="button" aria-label={t("close")} onClick={requestClose}
      className="flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground">
      <X className="h-4 w-4" />
    </button>
  }
  headerTabs={
    <SheetTabBar
      items={[
        { key: "basic", label: t("tabBasic") },
        { key: "mcp", label: t("tabMcp"), disabled: isCreate, disabledHint: t("tabMcpDisabledHint") },
      ]}
      active={tab}
      onChange={(k) => setTab(k as "basic" | "mcp")}
    />
  }
  defaultWidth="28rem"
>
  {/* keep-mounted：CSS 隐藏而非卸载，切 tab 不丢编辑中状态 */}
  <div className={cn("flex min-h-0 flex-1 flex-col", tab !== "basic" && "hidden")}>
    {/* 现有 <Form ...> 整块移入，Form 上加 formApiRef={formApiRef}；底部保存/删除按钮区随之 */}
  </div>
  <div className={cn("min-h-0 flex-1 overflow-y-auto p-4", tab !== "mcp" && "hidden")}>
    {!isCreate && <McpEditor agentId={localAgentId} />}
  </div>
</UnifiedSheet>
<ConfirmDialog
  open={discardOpen}
  title={t("discardTitle")}
  description={t("discardDescription")}
  confirmText={t("discardConfirm")}
  cancelText={t("discardCancel")}
  destructive
  onConfirm={() => { setDiscardOpen(false); onOpenChange(false); }}
  onCancel={() => setDiscardOpen(false)}
/>
```

注意：原 SheetDescription 文案并入标题下或删除（title 区只留单行标题）；保存成功路径关闭前 `formApiRef.current?.reset(values)` 或直接 `onOpenChange(false)`（保存后表单不再算脏，不触发确认）。`isCreate` 用现组件已有的 agentId 判空逻辑。

- [ ] **Step 2: i18n key**

`agentEditor` namespace（沿用该组件现有 namespace，grep `useTranslations(` 确认）新增：`tabBasic`（基本信息/Basic）、`tabMcp`（MCP/MCP）、`tabMcpDisabledHint`（保存后可配置 MCP/Available after saving）、`discardTitle`（放弃未保存的更改？/Discard unsaved changes?）、`discardDescription`（关闭后编辑内容将丢失/Your edits will be lost）、`discardConfirm`（放弃/Discard）、`discardCancel`（继续编辑/Keep editing）。
Run: `pnpm sync:locales -- --write` 后填值，`pnpm sync:locales -- --check` missing=0。

- [ ] **Step 3: 验证 + Commit**

Run: `pnpm format && pnpm typecheck && pnpm --filter @meshbot/web-common test`
手动：`pnpm dev:server-agent + dev:web-agent` 开编辑器——改一个字段点遮罩 → 出确认；不改直接点遮罩 → 直接关；切 tab 再切回 → 输入保留。**验完杀进程（7727 铁律）。**
Commit: `feat(web-agent): Agent 编辑 sheet 迁移 UnifiedSheet——tab 化 + 脏表单关闭确认`

---

### Task 4: 产物预览 + 助手 dock 迁移（依赖 Task 1；与 Task 3 文件集不重叠，可并行）

**Files:**
- Modify: `apps/web-agent/src/app/(shell)/layout.tsx:31-70`（预览装配）
- Modify: `apps/web-agent/src/components/artifact/artifact-split-pane.tsx`（装配壳）
- Modify: `packages/web-common/src/session/artifact-split-pane.tsx`（拆标题栏：标题/按钮内容改为可独立导出的 slots，正文保留）
- Modify: `apps/web-agent/src/components/im/quick-assistant-fab.tsx:24-75`

**Interfaces:**
- Consumes: `UnifiedSheet`
- Produces: web-common `ArtifactSplitPane` 改为导出 `{ titleNode, actionsNode, body }` 或等价拆分（实施者按最小改动选形态，保证 web-main 侧调用点同步更新——grep `ArtifactSplitPane` 全部使用方）

- [ ] **Step 1: 预览迁移**

layout.tsx：`ResizableSheet` → `UnifiedSheet`，`open={hasArtifact}`、`onOpenChange={(o) => !o && setPreviewArtifact(null)}`、非 modal、resizable、`title`/`headerActions` 用 web-common 拆出的标题/按钮内容（下载、关闭按钮进 headerActions）。删 layout.tsx:31-38 的自装 ESC 监听（底座已管）。web-common artifact-split-pane 的自绘 `h-13 border-b` 标题栏删除，正文成为 children。原「按钮组刻意放 drag 容器外」的注释迁移到 UnifiedSheet（Task 1 已带）。

- [ ] **Step 2: dock 迁移**

quick-assistant-fab：`ResizableSheet` → `UnifiedSheet`（非 modal、resizable、`title` 为 Sparkles+名字、`headerActions` 关闭按钮、`className="app-no-drag"` 保留）。删自绘 `h-13` 头部与自装 ESC（:24-31）。`AssistantDock chromeless` 不变；DockTabs 若在展开态需要（预览共存场景），经 `headerTabs` 注入——按现状 `assistant-dock.tsx:139` 的条件平移。

- [ ] **Step 3: 验证 + Commit**

Run: `pnpm format && pnpm typecheck && pnpm build:web-agent`（build 后删 `apps/web-agent/.next`，别删 `out`）
手动目检：预览开合、拖宽、下载/关闭按钮首点可点；dock 开合、ESC、拖宽。
Commit: `refactor(web-agent): 产物预览与助手 dock 迁移 UnifiedSheet 统一标题栏`

---

### Task 5: web-main 顺迁 + 删除 ResizableSheet（依赖 Task 1/3/4 全部完成）

**Files:**
- Modify: `apps/web-main/src/components/assistant/remote-session-view.tsx:513`（ResizableSheet → UnifiedSheet，参数直映射：width/onWidthChange/defaultWidth 原样，title/headerActions 按该文件现有自绘头部拆入）
- Delete: `packages/web-common/src/shell/resizable-sheet.tsx`
- Modify: `packages/web-common/src/shell/index.ts`（删 ResizableSheet 导出）

- [ ] **Step 1: 迁移 + 删除**

先迁 remote-session-view（读其现有头部结构，标题/按钮拆入 title/headerActions），后全仓 grep `ResizableSheet` 确认零引用，再删文件与导出。

- [ ] **Step 2: 验证 + Commit**

Run: `pnpm format && pnpm typecheck && pnpm check:dead && pnpm --filter @meshbot/web-common test`
Expected: check:dead 零新增 finding（删导出后无死引用）。
Commit: `refactor(web-main): 远程会话视图迁移 UnifiedSheet，删除 ResizableSheet`

---

### Task 6: 收尾验收

- [ ] **Step 1: 全量围栏**

Run: `pnpm lint && pnpm typecheck && pnpm check && pnpm sync:locales -- --check && pnpm test && pnpm build`
基线参照：lint 预存在 error 在 server-agent spec 与 tools/browser；判回归先减基线。

- [ ] **Step 2: 真机验收清单（交用户）**

- Electron 下反复开合三个面板各 5 次，标题区按钮**首次点击**必须可点（原始 bug 回归项）
- 编辑表单：脏时点遮罩/ESC → 确认弹窗；确认放弃 → 关闭；继续编辑 → 留下；干净时点遮罩直接关
- tab：新建态 MCP 禁用带提示；编辑态切 tab 输入不丢；标题区高度有无 tab 一致、分隔线由 tab 条承担
- 预览/dock：拖宽、ESC、关闭按钮行为与迁移前一致
- web-main 远程会话面板行为不变

---

## Self-Review 记录

- Spec 覆盖：§三 API → Task 1；§四四场景 → Task 3/4/5；§五 tab 化 → Task 3；§六测试 → Task 1 单测 + Task 6；§七不做项未越界。headerBorder 语义实现为「有 tabs 时自动不画线」，比 spec 的手动传 false 更不易错，JSDoc 说明（偏差已记录，属实现优化）。
- 占位符：Task 3 Step 1 的「现有 <Form> 整块移入」指既有代码平移非新写；Task 4/5 对未逐行读过的头部拆分给了 grep 指令与形态约束。无 TBD。
- 类型一致性：formApiRef 在 Task 2 定义、Task 3 消费同名；SheetTabItem 的 disabled/disabledHint 与 Task 3 用法一致；onDismissAttempt 全文同名。
