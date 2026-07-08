# 共享侧栏导航抽象（SidebarNav / SidebarRow / RailNav）设计

- 日期：2026-07-08
- 范围：把 web-agent 左侧「一级 rail + 二级 sidebar」里重复的**导航骨架**抽象成一套数据驱动、支持多组/递归多级的通用组件，建在 `packages/web-common/src/shell/`，本次只迁 web-agent；web-main 保持现状（组件建成后可后续采用）。
- 不含：各 section 的业务数据获取 / 在线态轮询 / 右键菜单等逻辑（留在 section）；web-main 迁移；drive 主区文件浏览。

## 1. 背景与现状

web-agent 左侧是两段式：`WorkspaceSidebar`（264px）顶部一条 `RailIconStrip`（一级 5 区）+ 一个 portal 插槽，各页面用 `PageShell` 把自己的二级 sidebar `createPortal` 进插槽（无中心化 sidebar registry）。

**已有共享原语**（`packages/web-common/src/shell/`）：`SidebarNavItem`（叶子行，无 children）、`SidebarSection`（单层可折叠，children=ReactNode，无 level/indent，实际从未嵌套用）、`RailNavItem`（竖排）、`RailIconStrip`（横排）、`SidebarSkeleton`。

**现状问题**（现状调研证据）：
- `SidebarNavItem` / `SidebarSection` **只支持两级**（分组 → 扁平项），item 无 `children`，无数据驱动树。
- `RailNavItem`（竖排）与 `RailIconStrip`（横排）是同职责两个组件，一层重复。
- 动态 section 各自**手抄了一份与 `SidebarNavItem` 相同的选中态样式**，未复用：
  - `apps/web-agent/src/components/shell/device-node.tsx`（设备→会话树）
  - `apps/web-agent/src/components/sidebar/session-list-item.tsx`（会话行 + 内联改名 + 三点菜单 + 删除确认）
  - `apps/web-agent/src/components/home/recent-sessions-sidebar.tsx`（最近会话，连原语都不用）
  - （web-main `apps/web-main/src/app/(shell)/settings/layout.tsx` 的 `SettingsNav` 同样手抄——本次不改，记录为后续采用点）
- 各二级 sidebar 各写各的导航骨架：`more-sidebar` / `skills-sidebar` / `drive-sidebar`（纯/半静态导航）、`messages-sidebar`（私信/频道两组 + 未读/在线）、`assistant-sidebar`（设备→会话两级树 + 轮询 + 远程按需）。

## 2. 关键决策（已确认）

| 维度 | 决策 |
|------|------|
| 抽象层次 | **导航骨架层**：抽数据驱动的多组/多级导航；动态业务内容通过 render-prop 复用行样式/选中态，不把业务逻辑收进组件 |
| 嵌套深度 | **递归 N 级**（item.children 任意深，按 depth 缩进） |
| 应用范围 | **本次只做 web-agent**；组件建在 web-common 供两端共享，web-main 以后采用（SettingsNav / rail 是现成替换点） |
| API 路线 | **声明式数据模型（NavGroup[] / NavNode）+ render-prop 逃生口**（非复合组件写法） |

## 3. 架构与组件

三个组件，均在 `packages/web-common/src/shell/`：

### 3.1 `SidebarNav`（新）—— 数据驱动的多组 / 递归多级导航

数据模型：
```ts
export interface NavNode {
  key: string;                 // 唯一键，用于 activeKey 命中 / 折叠态记账
  label: ReactNode;
  icon?: ReactNode;
  href?: string;               // href 与 onClick 二选一
  onClick?: () => void;
  trailing?: ReactNode;        // 默认 trailing（简单 badge）
  children?: NavNode[];        // 递归 → N 级树
  defaultOpen?: boolean;       // 有 children 时的初始展开态
}

export interface NavGroup {
  key: string;
  title?: ReactNode;           // 分组标题；无则不渲染标题行
  collapsible?: boolean;       // 标题可折叠（默认 false）
  defaultOpen?: boolean;
  onAdd?: () => void;          // 分组标题右侧“+”，对齐现 SidebarSection.onAdd
  addLabel?: string;
  items: NavNode[];
}
```

Props：
```ts
export interface SidebarNavProps {
  groups: NavGroup[];
  activeKey?: string;                          // 命中 NavNode.key → 选中高亮
  onSelect?: (node: NavNode) => void;          // 无 href 时的点击回调
  loading?: boolean;                           // true → 渲染 SidebarSkeleton
  onToggle?: (node: NavNode, open: boolean) => void;  // 展开/折叠回调
  onExpand?: (node: NavNode) => void;          // 首次展开 → 供 section 做按需加载（如 assistant 远程会话）
  // —— 逃生口（动态 section 用）——
  renderTrailing?: (node: NavNode) => ReactNode;   // 覆盖某项的 trailing（未读/在线点）
  itemActions?: (node: NavNode) => ReactNode;      // 行右侧操作区（三点菜单 / 右键触发器）
  renderRow?: (node: NavNode, defaults: SidebarRowProps) => ReactNode;  // 整行覆盖（极端定制，如内联改名输入）
}
```

行为：
- 遍历 `groups` → 每组可选标题行（`collapsible` 时可折叠）→ 递归渲染 `items`；有 `children` 的 item 自带展开箭头，按 depth 逐级缩进。
- 折叠/展开态默认组件内部管理（uncontrolled，键为 `node.key`）；`onToggle`/`onExpand` 暴露给 section。
- `activeKey` 命中即高亮；点击有 `href` 走链接、否则调 `onSelect`。
- `loading` 为 true 渲染 `SidebarSkeleton`。
- 每行最终用 `SidebarRow` 渲染（除非 `renderRow` 覆盖）。

### 3.2 `SidebarRow`（从 `SidebarNavItem` 抽出/升级）—— 唯一的共享行

单一职责：一行导航项的视觉（图标 + 文案 + 选中高亮 + depth 缩进 + trailing 插槽 + 可选 actions 插槽）。
```ts
export interface SidebarRowProps {
  icon?: ReactNode;
  label: ReactNode;
  active?: boolean;
  depth?: number;              // 缩进级数（0 起）
  trailing?: ReactNode;
  actions?: ReactNode;         // 行右侧操作区（hover 显示）
  onClick?: () => void;
  href?: string;
}
```
- `SidebarNav` 内部用它渲染每一行。
- **动态 section 直接组合它**（`device-node`、`session-list-item`、`recent-sessions-sidebar`）——从而不再手抄选中态 class；行内改名输入、三点菜单、删除确认等仍由 section 自己在 `actions`/外层控制。
- `SidebarNavItem` 保留为 `SidebarRow` 的薄别名（现有 4 处调用点不破坏），或直接并入（实现时定，二选一保证零回归）。

### 3.3 `RailNav`（合并 `RailNavItem` + `RailIconStrip`）—— 一个一级 rail

```ts
export interface RailNavItemModel { key: string; icon: ReactNode; label: string; }
export interface RailNavProps {
  items: RailNavItemModel[];
  activeKey?: string;
  onSelect: (key: string) => void;
  orientation: "horizontal" | "vertical";   // 横排=web-agent 顶部条；竖排=web-main 窄 rail
  className?: string;
}
```
- web-agent 用 `orientation="horizontal"` 替换 `RailIconStrip`。
- 竖排形态覆盖 `RailNavItem` 语义，留给 web-main 以后用。
- `RailIconStrip` / `RailNavItem` 保留为薄别名或并入（保证现调用点零回归）。

## 4. web-agent 迁移（本次逐个）

| section | 迁移方式 |
|---------|----------|
| `more-sidebar` | 构造 `NavGroup[]`（3 固定项）→ `SidebarNav` |
| `drive-sidebar` | 构造 `NavGroup[]`（我的/共享 2 项）→ `SidebarNav` |
| `skills-sidebar` | 构造 `NavGroup[]`（已安装 + 市场来源）→ `SidebarNav` |
| `messages-sidebar` | `SidebarNav`（私信/频道两组，数据来自 `conversationsAtom`）+ `renderTrailing` 挂未读 badge / 在线圆点 |
| `assistant-sidebar` | `SidebarNav` 递归模型（设备→会话，来自 device/session atoms）+ `itemActions`（会话改名/删除）+ `onExpand`（远程会话按需拉取）。**在线态轮询 / 远程拉取 / 数据装配仍在 section**；`device-node` 若仍需独立，改为组合 `SidebarRow` 而非手抄样式 |
| `home/recent-sessions-sidebar` + `session-list-item` | 改用 `SidebarRow`（消灭手抄 class）；内联改名 / 三点菜单（改名·固定·删除）/ 删除确认 / 定时活动小红点 走 `actions` 插槽，逻辑留 section |
| 一级 rail（`RailIconStrip` @ `workspace-sidebar.tsx`） | 换 `RailNav orientation="horizontal"` |

迁移原则：**逐个 section 迁、每个迁完做视觉对齐核对**（对照迁移前后像素/间距），一次一个可独立回归。

## 5. 明确不做（YAGNI / 边界）

- web-main 的 `SettingsNav` / rail 迁移（组件就绪后另案）。
- 把业务数据获取 / 在线态轮询 / 远程按需拉取 / 右键菜单业务逻辑收进通用组件（这些留在各 section，仅通过逃生口把「渲染」交给组件）。
- drive 主区的文件/文件夹浏览（不在 sidebar 层，不动）。
- 中心化「sidebar router/registry」（现 portal 机制不动）。
- 标题栏高度对齐（`PageHeader` h-11→h-13）是另一个独立小项，不在本 spec。

## 6. 测试

- `packages/web-common/src/shell/` 新增/改动组件加单测（web-common 用 web 侧测试栈）：
  - `SidebarNav`：多组渲染、递归 N 级树渲染与缩进、`activeKey` 高亮命中、折叠/展开 + `onToggle`/`onExpand` 回调、`loading`→骨架、`renderTrailing`/`itemActions`/`renderRow` 逃生口生效。
  - `SidebarRow`：选中态、depth 缩进、trailing/actions 插槽。
  - `RailNav`：横/竖排、activeKey、onSelect。
- 各 section 迁移：以「迁移前后视觉对齐 + 原有交互（改名/删除/未读/展开/远程拉取）不回归」为验收，非单测。

## 7. 验收标准

1. web-agent 六个二级 sidebar + 一级 rail 全部走 `SidebarNav` / `SidebarRow` / `RailNav`，`device-node` / `session-list-item` / `recent-sessions-sidebar` 不再手抄选中态 class。
2. 各 section 原有交互零回归：assistant 设备→会话树展开/远程按需拉取/在线态、messages 未读/在线、home/会话改名·删除·固定·活动小红点。
3. `RailIconStrip` / `RailNavItem` / `SidebarNavItem` 调用点零破坏（薄别名或全部改引用）。
4. web-common 组件单测通过；`pnpm typecheck` + 静态围栏全绿。

## 8. 风险与注意

- **视觉回归**是主要风险：抽象后各 section 行的像素/间距必须与迁移前一致，逐个迁移 + 逐个核对。
- **逃生口不要膨胀**：`renderRow` 整行覆盖是最后手段；优先 `renderTrailing` + `itemActions`。若某 section 用到 `renderRow` 说明它可能不该用 `SidebarNav` 而应直接组合 `SidebarRow`——以此为信号保持边界。
- `SidebarSection` 现有「单层折叠 + onAdd」语义要被 `NavGroup`（collapsible/onAdd）完整覆盖，避免丢功能。
- i18n：所有 label 仍走各 section 的 `useTranslations`，`SidebarNav` 只收 `ReactNode`，不引入裸字符串。
