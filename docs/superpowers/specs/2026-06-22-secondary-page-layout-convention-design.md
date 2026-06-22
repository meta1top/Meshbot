# 二级页统一布局规范（ToolPage）设计

> 适用范围：web-agent 的二级页面（技能 skills、计划任务 schedule、更多 more、组织设置 settings/org）。
> 不含：登录/注册（AuthShell 体系）、IM 会话页（专用会话布局）、首页 `/`（重定向到 `/messages`）。

## 背景与问题

当前各二级页内容区各写各的，不成体系。量化现状：

| 页面 | 容器宽度 | 内边距 | 对齐 | 头部形态 | 子导航 |
|------|---------|--------|------|---------|--------|
| skills | `max-w-2xl`(672) | 靠 shell | 居中 | 裸 `<h1>` | 自有 SkillsSidebar |
| schedule | `max-w-2xl`(672) | **自加 `p-4`（与 shell 重复）** | 居中 | `<h1>` + 按钮 | MoreSidebar（区默认） |
| more | `max-w-[620px]` | **自加 `px-6 py-6`** | **左对齐** | 无 | MoreSidebar |
| settings/org | `max-w-[680px]` | **自加 `p-6`** | 居中 | 无 | `sidebar={null}` |

问题根因：**没有共享的「页面外壳 + 页面头部」约定**，每页自行拼 `mx-auto max-w-* p-*` 包裹层 + 自定义 h1，于是出现 3 种宽度（620/672/680）、内边距重复、对齐不一、头部三种形态。

子导航侧（SkillsSidebar / MoreSidebar / MessagesSidebar）已统一：都用 `SidebarSection` + 同款 `rowBase` + `h-11` 头部 + `--shell-sidebar` 底色，本规范**不改子导航**。

## 决策（已确认）

1. **内容区模型：全部全宽（Slack 式）**。所有二级页内容区铺满主区宽度，不再用居中窄列；统一头部 + 可选标签行。
2. **以一个 `<ToolPage>` 包装组件落地**（方案 B）。页面写成声明式壳，头部/宽度/内边距全部由 ToolPage 锁定，新页只能照着写。
3. **页面头部** = 左侧标题 + 右侧操作区 + 可选 `⋯` 溢出菜单 + 可选标签/筛选行。
4. **左侧子导航保持现状**；skills 的视图切换仍由其子导航承担。
5. 覆盖 4 个页面：skills、schedule、more、settings/org，一次迁完。

## 组件架构

新增 **两个**组件（位于 `apps/web-agent/src/components/layouts/`）：

### `<PageHeader>`

钉在内容区顶部、全宽、不随内容滚动的页头条。通过 AppShellLayout 已有的 `header` 槽位渲染（与会话页标题栏同机制，位于滚动容器之外）。

```tsx
interface PageHeaderProps {
  title: ReactNode;       // 左侧标题
  actions?: ReactNode;    // 右侧操作区（按钮、⋯ 菜单等）
  tabs?: ReactNode;       // 可选：标题行下方的标签/筛选行
}
```

布局（CSS 要点）：

```tsx
<div className="shrink-0 border-b border-border bg-(--shell-content)">
  <div className="flex min-h-[52px] items-center justify-between gap-3 px-4 lg:px-6 py-2.5">
    <h1 className="min-w-0 truncate text-lg font-semibold text-foreground">{title}</h1>
    {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
  </div>
  {tabs && <div className="flex items-center gap-1 px-4 lg:px-6 pb-2">{tabs}</div>}
</div>
```

- 水平内边距 `px-4 lg:px-6`，**与内容体一致**，保证标题与内容左缘对齐。
- 标题 `text-lg font-semibold`、`truncate` 防溢出。

### `<ToolPage>`

二级页统一外壳。组合 AppShellLayout + PageHeader，并把内容体渲染进 AppShellLayout 既有的全宽 + 标准内边距包裹层。

```tsx
interface ToolPageProps {
  title: ReactNode;
  actions?: ReactNode;
  tabs?: ReactNode;
  /** 子导航：undefined=按区自动选；null=不渲染（设置页用）。透传给 AppShellLayout.sidebar */
  sidebar?: ReactNode | null;
  scrollContainerRef?: React.RefObject<HTMLDivElement | null>;
  children: ReactNode;
}

export function ToolPage({ title, actions, tabs, sidebar, scrollContainerRef, children }: ToolPageProps) {
  return (
    <AppShellLayout
      sidebar={sidebar}
      scrollContainerRef={scrollContainerRef}
      header={<PageHeader title={title} actions={actions} tabs={tabs} />}
    >
      {children}
    </AppShellLayout>
  );
}
```

### 内容容器：复用 AppShellLayout 既有包裹层，不再新增组件

AppShellLayout 内容区已有：

```tsx
<div className="flex w-full flex-1 flex-col p-4 lg:px-6">{children}</div>
```

这本身就是「全宽 + 标准内边距」的容器。因此**不需要单独的 PageContainer 组件**——规范就是：

- 页面通过 ToolPage 渲染内容，**内容直接作为 children**；
- **禁止**页面再套 `mx-auto` / `max-w-*` / 额外 `p-*`（这正是双重内边距与多宽度的来源）；
- 需要纵向分段间距时，内容内部自行 `flex flex-col gap-*`；
- 表单类页面：页容器全宽，但**表单字段/卡片可自带合理内宽**（内容级，不在页容器层做居中窄列）。

## 各页迁移映射

| 页面 | ToolPage.title | ToolPage.actions | ToolPage.tabs | sidebar | children（去掉旧 `mx-auto max-w-* p-*`） |
|------|---------------|------------------|---------------|---------|------|
| **skills** | 当前视图名（已安装/MeshBot/ClawHub/GitHub，随 activeView 动态） | 视图相关（如已安装视图可放上传入口；可选） | 市场视图的搜索框可入 tabs 槽 | `<SkillsSidebar/>` | 各视图内容（已装列表 / 市场列表 / GitHub 表单），全宽 |
| **schedule** | `t("title")` 计划任务 | `<button>+新建/取消</button>`（切 formOpen） | — | 省略（区默认 MoreSidebar） | 新建表单（开时）+ 任务列表，全宽 |
| **more** | 使用情况/概览标题 | 时间范围切换（all/30d/7d）可入 actions 或 tabs | 同左 | 省略（MoreSidebar） | 统计卡 + 热力图，全宽左对齐填满（去 `max-w-[620px]`） |
| **settings/org** | `t("membersTitle")` 等 | 可选（如邀请入口） | — | `null`（无子导航） | 成员列表 + 邀请表单，全宽 |

迁移即：把各页 `<AppShellLayout ...><div className="mx-auto max-w-* p-*">…</div></AppShellLayout>` 改为 `<ToolPage title=… actions=… sidebar=…>…</ToolPage>`，并删除旧的宽度/内边距包裹层与裸 h1。

## 边界与不变量

- ToolPage 只负责内容区外壳；rail / 子导航 / 抽屉响应式（md/xl）仍由 AppShellLayout 承担，不动。
- 页头走 `header` 槽位 → 钉顶不随滚动；内容滚动区与现状一致（`scrollContainerRef` 透传）。
- 所有用户可见文案走 next-intl（既有 i18n 规范）；迁移若需新键，zh/en 同步补齐。

## 测试 / 验收

- **单测**（jest，web-agent）：
  - `PageHeader`：渲染 title；给 actions/tabs 时渲染对应槽位，不给时不渲染。
  - `ToolPage`：把 PageHeader 注入 AppShellLayout 的 header；children 原样渲染；`sidebar` 透传（含 `null`）。
- **目视验收**：`pnpm dev:web-agent`，逐一打开 skills / schedule / more / settings/org，确认：
  - 四页头部一致（同高、标题与内容左缘对齐、操作区右对齐）；
  - 内容区全宽、无双重内边距、无残留居中窄列；
  - 子导航与抽屉响应式行为不变。

## 不在本次范围

- 登录/注册页（AuthShellLayout，另一套）。
- IM 会话页（messages 的会话视图，专用 header + body）。
- 子导航视觉重构（已统一，不动）。
- `/assistant` 孤立页的去留（单独决策）。
