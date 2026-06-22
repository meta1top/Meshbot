# SP0：「更多」hub 化 + 定时任务并入 + 导航 Slack 左对齐 设计

## 背景与范围

原始需求第 3 点:把总量统计/定时任务/技能管理并入「更多」、整体 Slack 风格左对齐。其中:
- **总量统计**(使用情况)已迁入 `/more`(历史完成)。
- **技能** 经讨论**保持统一**在 rail(`/skills` 一处含市场浏览 + 已装管理),**不拆、不进更多**。
- 故 SP0 实际只剩:**定时任务并入「更多」** + **「更多」做成带左侧子导航的 hub** + **Slack 左对齐微调**。

**rail 完全不变**:消息 / 技能 / 更多。本期纯 web-agent 前端,无后端/数据改动。

## 目标结构

```
rail（不变）          「更多」区（新增左侧子导航，Slack 左对齐）
─────────             ──────────────────────────────────────
💬 消息               📊 使用情况   /more     （现有 stats 页）
🧩 技能（不动）       ⏰ 定时任务   /schedule （路由保留，从消息侧栏迁来）
⋯  更多        ───►
```

## 改动清单

### 1. 新建 MoreSidebar（「更多」区左侧子导航）
- 新建 `apps/web-agent/src/components/shell/more-sidebar.tsx`,Slack 左对齐风格,沿用 `messages-sidebar` 的外观容器(`bg-(--shell-sidebar)`、顶部 11 高标题栏)。
- 两个导航项:**使用情况**(→ `/more`,图标 `BarChart3`/`Activity`)、**定时任务**(→ `/schedule`,图标 `Clock`)。当前路由高亮(`pathname === "/more"` / `pathname.startsWith("/schedule")` → `bg-(--shell-accent) text-white`)。
- 复用现有 nav 项样式(同 messages-sidebar 底部定时任务按钮的 class 范式)。

### 2. AppShellLayout：「更多」区接 MoreSidebar
- `app-shell-layout.tsx` 的 `autoSidebar`:`area === "more"` 分支从 `<PlaceholderSidebar title={t("rail.more")} />` 改为 `<MoreSidebar />`。
- `PlaceholderSidebar` 若不再被其他处引用则删除(check:dead)。

### 3. areaFromPath:/schedule 归「更多」区
- `lib/area-from-path.ts`:把 `/schedule` 从「messages」分支移到「more」分支(`/more`、`/schedule` → `"more"`)。
- 更新 `lib/area-from-path.test.ts`:`/schedule` → `"more"` 的用例(改原断言)。

### 4. 定时任务从消息侧栏移除
- `components/shell/messages-sidebar.tsx`:删除底部「定时任务入口」按钮(行 170-183)及随之不再使用的 import(`Clock`、可能的 `router`/`pathname` 若仅此处用——按实际清理)。

### 5. /more 使用情况 Slack 左对齐微调
- `app/more/page.tsx`:内容容器左对齐(标题/区间切换/指标卡左对齐,去掉居中),与 Slack 风格一致。保持现有 stats 数据逻辑不动,仅排版。

## 数据流 / 风险

- 纯路由区域归属 + 侧栏渲染变更,无新接口。`/schedule` 页本身不动(已确认它用 `<AppShellLayout>` 不自传 `sidebar`,走 autoSidebar;remap 区域到「more」后即自动解析为 MoreSidebar)。
- 已确认 `PlaceholderSidebar` 仅 app-shell-layout 引用、`Clock` 在 messages-sidebar 仅定时任务按钮用——替换/删除后随手清理。
- Shell 级全局事件(未读/定时任务徽标)挂在 AppShellLayout,与本改动无关,不受影响。
- 移除消息侧栏定时任务入口后,定时任务唯一入口在「更多」——符合需求。

## 测试

- `area-from-path.test.ts`:`/schedule` → `"more"`、`/more` → `"more"` 用例(纯函数,先红后绿)。
- 其余(MoreSidebar、layout 接线、messages-sidebar 删除、/more 排版)经 `pnpm --filter @meshbot/web-agent typecheck` + biome + `pnpm check`(尤其 check:dead 确认 PlaceholderSidebar 清理)验证(本仓 web 组件无 RTL,沿用既有现实)。

## 非目标

- 技能拆分 / 技能管理进更多(已决定不做)。
- SP2(对话式技能工具)。
- 后端任何改动。
