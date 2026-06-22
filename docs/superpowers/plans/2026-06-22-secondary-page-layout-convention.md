# 实施计划：二级页统一布局规范（ToolPage）

设计：`docs/superpowers/specs/2026-06-22-secondary-page-layout-convention-design.md`

目标：新增 `PageHeader` + `ToolPage` 两个布局组件，把 skills / schedule / more / settings/org
四个二级页迁移到 ToolPage，统一为「全宽内容 + 钉顶页头（标题/操作/可选标签）+ 标准内边距」，
消除当前 3 种宽度、双重内边距、三种头部形态。

依赖方向：组件落在 `apps/web-agent/src/components/layouts/`，复用既有 `AppShellLayout`（不改其结构）。

---

## Task 0 — 摸清测试基建（前置）

- 确认 web-agent 是否有 React 组件测试环境（jest + RTL）：`ls apps/web-agent/**/*.spec.tsx`、看 `apps/web-agent` 是否有 jest 配置 / `@testing-library/react` 依赖。
- 若有 → 各组件任务按 TDD 先写失败单测；若无 → 不为此引入测试栈，组件任务以 `pnpm typecheck` + 目视验收为硬门槛（在 Task 6 统一验收），并在 PR 说明里注明。

验收：明确后续 Task 用「单测 + 目视」还是「typecheck + 目视」。

## Task 1 — PageHeader 组件

文件：`apps/web-agent/src/components/layouts/page-header.tsx`

- props：`{ title: ReactNode; actions?: ReactNode; tabs?: ReactNode }`
- 结构按 spec：`shrink-0 border-b border-border bg-(--shell-content)` 外层；标题行
  `flex min-h-[52px] items-center justify-between gap-3 px-4 lg:px-6 py-2.5`，标题
  `min-w-0 truncate text-lg font-semibold text-foreground`；actions `flex shrink-0 items-center gap-2`；
  tabs 行 `flex items-center gap-1 px-4 lg:px-6 pb-2`（仅当传入）。
- （若 Task 0 有测试栈）单测：传 title 渲染；传/不传 actions、tabs 时对应槽位出现/消失。

验收：组件 typecheck 通过；（有测试栈则）单测绿。

## Task 2 — ToolPage 组件

文件：`apps/web-agent/src/components/layouts/tool-page.tsx`

- props：`{ title; actions?; tabs?; sidebar?: ReactNode | null; scrollContainerRef?; children }`
- 实现：渲染 `<AppShellLayout sidebar={sidebar} scrollContainerRef={scrollContainerRef}
  header={<PageHeader title actions tabs />}>{children}</AppShellLayout>`。
- `sidebar` 透传语义与 AppShellLayout 一致：`undefined`=按区自动；`null`=不渲染。
- （有测试栈）单测：header 槽位收到 PageHeader（含 title）；children 原样渲染；`sidebar=null` 透传。

验收：typecheck 通过；（有测试栈则）单测绿。

## Task 3 — 迁移 skills 页

文件：`apps/web-agent/src/app/skills/page.tsx`

- 用 `<ToolPage>` 替换 `<AppShellLayout sidebar={<SkillsSidebar/>}>` + `<div className="mx-auto w-full max-w-2xl">`。
- `title` 随 activeView 动态（已安装 / MeshBot / ClawHub / GitHub）——取当前视图标签；删去内容区裸 `<h1>`。
- `sidebar={<SkillsSidebar .../>}` 照旧。
- 市场视图搜索框：移入 `tabs` 槽（或内容顶部），保持全宽。
- 删除 `mx-auto max-w-2xl` 包裹层，内容直接作 children（全宽）。
- PublishSkillDialog 等浮层不变。

验收：技能页全宽、头部统一、四个视图正常切换；typecheck 通过。

## Task 4 — 迁移 schedule 页

文件：`apps/web-agent/src/app/schedule/page.tsx`

- `<ToolPage title={t("title")} actions={<新建/取消按钮>}>`；按钮切 `formOpen`。
- 删除 `<div className="mx-auto w-full max-w-2xl p-4">`（含与 shell 重复的 `p-4`）与 flex 头部行；标题/按钮移入 ToolPage。
- 子导航省略（区默认 MoreSidebar）。
- children：新建表单（formOpen 时）+ 任务列表，全宽。

验收：计划任务页全宽、无双重内边距、新建/列表正常；typecheck 通过。

## Task 5 — 迁移 more 页

文件：`apps/web-agent/src/app/more/page.tsx`

- `<ToolPage title=… >`；时间范围切换（all/30d/7d）移入 `actions` 或 `tabs` 槽。
- 删除 `<div className="w-full max-w-[620px] flex-1 px-6 py-6">`（左对齐窄列 + 自加内边距）；统计卡 + 热力图全宽填满。

验收：更多/使用情况页全宽、与其他页头部一致；typecheck 通过。

## Task 6 — 迁移 settings/org 页 + 统一验收

文件：`apps/web-agent/src/app/settings/org/page.tsx`

- `<ToolPage title={t("membersTitle"…)} sidebar={null}>`；删除 `mx-auto max-w-[680px] p-6` 包裹层。
- `noOrg` 分支同样走 ToolPage（或保留极简提示，但去掉自加 p-6）。
- 邀请表单/成员列表：页容器全宽，表单字段可自带合理内宽（内容级）。

统一目视验收（`pnpm dev:web-agent`）：
- skills / schedule / more / settings/org 四页头部同高、标题与内容左缘对齐、操作区右对齐；
- 内容区全宽、无残留 `mx-auto/max-w-*` 窄列、无双重内边距；
- 子导航与窄屏抽屉（md/xl）响应式行为不变。

## Task 7 — 收尾围栏

- `pnpm typecheck`、`pnpm lint`（biome）、`pnpm check`（静态围栏）全绿。
- i18n：迁移若引入新文案键，zh/en 同步补齐，`tsx scripts/sync-locales.ts -- --check` 通过。
- 提交（中文 conventional commits，可按 组件 / 各页迁移 拆分）。

---

## 备注 / 风险

- 不改 AppShellLayout 结构与子导航；ToolPage 只是其上的内容区模板，降低回归面。
- 全宽后 settings/org 等表单页若显空旷，靠内容级内宽收敛（不回退到页容器居中窄列——已决策全宽）。
- `/assistant` 孤立页去留、登录后落地是否还需调整，属另一议题，不在本计划。
