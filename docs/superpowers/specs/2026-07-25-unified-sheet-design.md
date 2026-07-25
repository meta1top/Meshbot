# 统一右侧 Sheet（UnifiedSheet）设计

日期：2026-07-25
范围：`packages/web-common/src/shell/` 新增 UnifiedSheet 底座 + 三个场景迁移（Agent 编辑 / 产物预览 / 助手 dock）+ web-main 远程会话视图顺迁 + Agent 编辑 sheet tab 化

## 一、背景与问题

右侧弹出面板现存两套互不相干的底层：

| | shadcn `Sheet`（Radix Dialog） | `ResizableSheet`（web-common 自研） |
|---|---|---|
| 使用方 | Agent 编辑、models 页、model-setup-gate | 产物预览、助手 dock、web-main 远程会话 |
| 遮罩 | 有，点外/ESC 即关 | 无 |
| 宽度 | 固定 `sm:max-w-md` | 左缘拖宽 |
| 标题栏 | SheetHeader（静态） | 各使用方自绘 chrome |

用户报告的问题：
1. **标题区能拖动（Electron 窗口拖拽）时按钮偶发不可点**——已知病根：面板常驻 DOM 靠 transform 滑入时 Electron 不重算 draggable regions，按钮的 `app-no-drag`「洞」停留在收起态快照（`artifact-split-pane.tsx` 与 `(shell)/layout.tsx` 注释均有记录，各自打了局部补丁：条件挂载 / 按钮移出拖动容器）
2. 三个场景标题区行为、拖动区、按钮操作区各不一致
3. 表单类 sheet 点外即关，误触丢表单内容
4. 编辑表单内容堆一列，需要 tab 分区
5. 标题 border 无法隐藏，有 tab 时标题+tab 不成整体

## 二、已确认的决策

- **单底座 + 全参数化**：以 ResizableSheet 为基础升级为 UnifiedSheet；遮罩（modal）、点外/ESC 关闭（dismissible）、**可拖宽（resizable）**、标题 border（headerBorder）全部参数控制
- **tab 口径**：本期只重组现有内容——「基本信息 / MCP」两个 tab；技能 tab 是新功能（/skills 页能力搬进 sheet），单独排期
- 迁移范围：Agent 编辑 / 产物预览 / 助手 dock + web-main 远程会话顺迁；models 页与 model-setup-gate 的 shadcn Sheet 不在本期

## 三、UnifiedSheet API（packages/web-common/src/shell/unified-sheet.tsx）

```ts
interface UnifiedSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 行为参数 */
  resizable?: boolean;        // 默认 true；false 时无左缘手柄，宽度固定
  modal?: boolean;            // 默认 false；true 渲染半透明遮罩（bg-black/40）
  dismissible?: boolean;      // 默认 true；点外（modal 时点遮罩）/ESC 是否直接关闭
  onDismissAttempt?: () => void; // dismissible=false 时点外/ESC 回调（表单接 dirty 确认）
  /** 标题栏 */
  title?: ReactNode;
  headerActions?: ReactNode;  // 动作槽，结构上在拖动容器之外
  headerBorder?: boolean;     // 默认 true；有 headerTabs 时调用方设 false
  headerTabs?: ReactNode;     // 紧贴标题栏下方的 tab 条插槽
  /** 宽度（沿用 ResizableSheet 语义与实现铁律） */
  width?: number | null;
  onWidthChange?: (w: number) => void;
  minWidth?: number;          // 默认 480
  maxVwRatio?: number;        // 默认 0.92
  defaultWidth?: string;      // 默认 "30vw"
  className?: string;
  children: ReactNode;
}
```

### 标题栏结构（Electron 拖动坑的结构性修复）

标题栏固定 `h-13`，三区：

```
┌─────────────────────────────────────────────┐
│ [标题文字容器 flex-1 drag-handle] [动作槽]   │ ← h-13，headerBorder 控制底线
│ [headerTabs 插槽（可选，自带底 border）]      │
└─────────────────────────────────────────────┘
```

- **动作槽渲染在拖动容器之外**（兄弟节点，非子节点凿洞）——仓库已验证的规避模式，固化进底座
- **条件挂载**：`open===false` 时整个 aside 不渲染（不用 transform 滑入常驻），迫使 Electron 重算 draggable regions——两个已知坑一次修死
- `drag-handle` / `app-no-drag` 类在 web-main（非 Electron）无副作用，无需分端
- `headerBorder=false` 时标题栏无底线，分隔由 headerTabs 的 tab 条底 border 承担；标题栏高度恒为 `h-13`，有无 tab 都不变

### 关闭行为矩阵

| dismissible | 点外/遮罩点击 | ESC |
|---|---|---|
| true（默认） | 关闭 | 关闭 |
| false | 触发 `onDismissAttempt` | 触发 `onDismissAttempt` |

表单场景的 `onDismissAttempt`：表单干净直接 `onOpenChange(false)`；脏则弹 shadcn 确认（禁原生 confirm，复用 `confirm-dialog.tsx` 惯例）——「放弃未保存的更改？」确认后关。

### 实现铁律（继承 ResizableSheet 头注释）

- aside 不得有 transition-duration（拖宽会抖）
- 拖宽过程直接写 DOM 宽度，松手才 `onWidthChange` 一次
- 拖宽手柄仍是左缘独立 8px button，与标题区无关

## 四、场景迁移

| 场景 | 参数组合 | 变化 |
|------|---------|------|
| Agent 新建/编辑 | `modal` + `dismissible=false` + `resizable` + tabs | 从固定 448px 变可拖宽；误触不再丢表单 |
| 产物预览（layout.tsx 装配） | 非 modal + resizable | 行为不变，换底座，自绘标题栏改用统一标题栏 |
| 助手 dock（quick-assistant-fab） | 非 modal + resizable | 同上；DockTabs 移入 headerTabs 插槽 |
| web-main remote-session-view | 非 modal + resizable | API 兼容顺迁 |

旧 `ResizableSheet` 在四处迁完后删除导出（check:dead 会盯）。

## 五、Agent 编辑 sheet tab 化

- `headerTabs` = shadcn Tabs：「基本信息」「MCP」；`headerBorder=false`
- 基本信息 tab：现有表单（name/avatar/description/systemPrompt/defaultModel/remoteEnabled），保存/删除仍在底部 footer
- MCP tab：现有 `McpEditor`（独立保存语义不变）
- **新建态 MCP tab 禁用**并给提示（无 agentId，端点挂 `/api/agents/:id/mcp`）——现状「新建态不显示 MCP 区」的语义平移
- tab 切换不丢另一 tab 的编辑中状态（tab 内容 keep-mounted，用 CSS 隐藏而非卸载）

## 六、测试与验收

风险分档：**中**（交互状态机、单端无并发）——实施 + 核心不变量变异抽查，不派独立 reviewer。

- jest 单测：dismiss 行为矩阵（dismissible × modal × dirty）、headerBorder/headerTabs 渲染分支、条件挂载（open=false 不渲染 aside）
- 变异抽查：改掉「动作槽在拖动容器外」的结构 → 断言测试能抓到
- 真机验收重点（对应原始 bug）：Electron 下反复开合三个面板，标题区按钮**首次点击**必须可点；表单脏时点外/ESC 出确认弹窗；tab 切换表单状态不丢
- `pnpm lint / typecheck / check / test / build` 全绿

## 七、明确不做

- 技能 tab（新功能，单独排期）
- models 页 / model-setup-gate 的 shadcn Sheet 迁移（后续批次）
- 拖宽手柄移动端适配（面板本为桌面态设计）
- shadcn Sheet 组件本身的删除（仍有两处使用方）
