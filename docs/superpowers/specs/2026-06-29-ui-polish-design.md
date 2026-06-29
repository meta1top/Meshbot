# UI 精致化（紧凑专业型）设计

> 状态：已通过 brainstorm（3 决策已定），待评审 → writing-plans
> 日期：2026-06-29
> 关联：web-agent 全部页面 + `packages/design` 设计系统。
> 背景：用户反馈整体 UI 不精致——标题栏高低不一、按钮偏大、间距偏松、表格/输入框/卡片不统一。审计确认根源是**设计系统缺规范**（无字号/间距 token、三套按钮并行、缺 Table/Dialog 组件、各页硬编码自由发挥），而非单页问题。

## 1. 目标 / 范围

把 web-agent 整体 UI 提升到**紧凑专业型**（Linear/Notion 风）：13px 基准字号、全面收紧间距/按钮/行高、克制留白、小圆角、统一规范。

**推进方式（决策③）**：**先做 2 个标杆页验证手感**，用户在真实 app 里确认密度/精致度，满意后再全量铺其它页。避免全改完方向不对返工。

**本期范围（标杆轮）**：
- ✅ 设计 token：字号刻度、控件高度刻度、卡片/圆角规范（落到 `packages/design`）。
- ✅ 核心组件改造：Button（修 size bug + 统一）、Input（统一高度）、Card（统一 padding）、**新增 Table 组件**、标题栏统一。
- ✅ 标杆页 1：**网盘**（`drive/page.tsx` + `drive-file-list.tsx`）——文件浏览器化（视觉精致）。
- ✅ 标杆页 2：**技能页**（`skills/page.tsx` + 卡片/sidebar/tab）。
- ❌ **非目标（标杆轮）**：其它页面全量套用（更多/定时/组织/消息/会话——标杆验证通过后另起一轮）；网盘多选 + 右键菜单 + 批量操作（决策②：先只做视觉精致）；新增 Dialog/Tabs 组件（本轮先 Table，弹窗/tab 沿用现状，全量轮再统一）；深色/浅色配色调整（仅密度/排版，不动颜色语义）。

## 2. 设计 token（紧凑专业刻度）

落到 `packages/design`（tailwind theme extend + CSS 变量），替代散落的 `text-[NNpx]` 硬编码。

### 字号刻度
| token | px | 用途 |
|-------|----|----|
| `text-xs` | 11 | 辅助/标签/时间戳 |
| `text-sm` | 12 | 次要信息/表头 |
| `text-base` | **13** | **正文基准**（列表项、表单、卡片正文） |
| `text-md` | 14 | 强调/按钮文字 |
| `text-lg` | 15 | 区块标题/页面标题栏 |
| `text-xl` | 18 | 大标题（少用，如空态主标题） |

### 控件高度刻度
| token | px | 用途 |
|-------|----|----|
| 控件 sm | 28 | 紧凑按钮、工具栏按钮、表格内按钮 |
| 控件 default | 32 | 表单按钮、输入框、下拉 |
| 标题栏 | **44** | 所有页面标题栏统一（收紧普通页 52px，对齐会话页 h-11） |
| 表格行 | 30 | 网盘/列表行（现 ~40px） |

### 间距 / 圆角
- 间距：沿用 Tailwind 4px 基准刻度，但**约定收紧用法**——卡片内 `p-3`、列表项 `px-3 py-1.5`、区块 `gap-2`/`gap-1.5`，淘汰 `p-6`/`py-2.5` 等松散值。
- 圆角：统一 `rounded-md`（控件/卡片）、`rounded-lg`（弹窗/大卡片）；淘汰各处随意的 `rounded`/`rounded-xl`。

## 3. 核心组件改造（`packages/design`）

- **Button**：
  - 修 `apple/button.tsx` 的 **size 失效 bug**（现强制 `h-10` 覆盖，`size` 只改宽不改高）。
  - 统一尺寸：`sm` 28px、`default` 32px；字号 13（sm）/14（default）；紧凑内边距（sm `px-2.5`、default `px-3`）。
  - 淘汰各页裸 `<button>`（schedule/cron-form/技能卡 等）→ 全改用 Button 组件。
- **Input**：统一高度 32px、字号 13、`px-3`；淘汰裸 `<input>`（cron-form/网盘弹窗/重命名 等）。
- **Card**：统一默认 `p-3`（移除 `ui/card.tsx` 的 `p-6`，各页不再覆盖）；统一圆角 `rounded-md`。
- **新增 `Table` 组件**（`packages/design`，基于 shadcn table 模式）：`Table/TableHeader/TableBody/TableRow/TableHead/TableCell`——行高 30px、`text-base`、hover `bg-muted`、表头 `text-sm text-muted-foreground`、支持可排序列头（列头点击回调 + 升降序图标）。
- **标题栏统一**：`PageHeader` 收到 44px + `text-lg`(15px)；`SessionHeader`/`ImConversationHeader` 对齐同一高度/字号刻度（统一 44px，消除 52 vs 44 差异）。sidebar 宽度统一为 240px（消除 240 vs 260）。

## 4. 标杆页 1：网盘（文件浏览器视觉精致）

`drive/page.tsx` + `drive-file-list.tsx`：
- 用新 `Table` 组件重写文件列表：行高 30px、`text-base`、hover 高亮明显。
- **文件类型图标分色**：文件夹（amber）、文档/PDF（red/blue）、图片（green）、代码/文本（slate）、压缩包（purple）等——按 MIME/扩展名映射颜色 + 合适图标。
- 列宽均衡：名称列 flex 但设 `max-w`，大小/修改时间列右对齐固定宽，避免宽屏下名称列过宽。
- **列头可排序**：名称/大小/修改时间点击排序（升降序，纯前端排当前列表）。
- 工具栏（上传/新建文件夹）按钮收小（控件 sm）、面包屑/tab 收紧。
- 行操作 DropdownMenu 触发按钮收小。

## 5. 标杆页 2：技能页

`skills/page.tsx` + `installed-skill-card.tsx` + `market-skill-card.tsx` + SkillsSidebar：
- tab（已安装/市场来源）收紧、字号统一。
- 技能卡片：统一 `p-3`、字号刻度（标题 14、描述 12/13、元信息 11）、紧凑行距。
- 安装/卸载按钮 → Button 组件（控件 sm，淘汰裸 button + `text-[11px]`）。
- 搜索框 → Input 组件（32px）。
- sidebar 项收紧、字号统一。

## 6. 落地方式与影响面

- **token 不粗暴覆盖 Tailwind 默认**：不要把 `text-base` 从 16 改成 13（会让全仓所有 `text-base` 意外变样、波及未做的页面）。改用**新增刻度别名**（如 `text-[13px]` 收敛为语义类，或在组件/标杆页直接用具体刻度值），只影响显式采用新刻度的地方。
- **组件改造天然全局**：Button/Input/Card/PageHeader 是共用组件，改它们会**波及所有引用页**——这是预期收益（标题栏全局等高、按钮全局统一）。标杆页是在此之上额外做**页面级精致**（网盘图标分色/排序、技能卡片布局）。其它页若因组件尺寸变化出现轻微错位（如某处依赖旧 padding），记录下来留**全量轮**统一收，不在标杆轮逐一追。
- **真实渲染验证**（关键，沿用项目惯例：密度/对齐都靠真实渲染对比定，别凭数字猜）：改完在 app 里逐页对比。

## 7. 测试

- `pnpm turbo typecheck --filter=@meshbot/web-agent --filter=@meshbot/design` 全绿。
- `packages/design` 组件若有纯逻辑（如 Table 排序）加单测；视觉靠真实渲染人工验收。
- 标杆轮验收清单：标题栏等高、按钮统一尺寸、网盘行高 30px + 图标分色 + 排序、技能页卡片/按钮/搜索框收紧。

## 8. 后续（非本 spec）

标杆轮验收通过后，**全量轮**：把 token/组件套到剩余页面（更多/使用情况、定时任务、组织、消息/会话/IM），并视情况补 Dialog/Tabs 统一组件、网盘多选+右键菜单。
