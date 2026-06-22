# SP0：「更多」hub 化 + 定时任务并入 + 导航左对齐 实施计划

> **For agentic workers:** 小型前端重构,inline 批量执行 + 检查点。Steps 用 `- [ ]`。

**Goal:** 「更多」区做成带左侧子导航(使用情况 + 定时任务)的 hub;定时任务从消息侧栏迁入「更多」;导航 Slack 左对齐。rail 与技能不动。

**Architecture:** 纯 web-agent 前端。新增 MoreSidebar,AppShellLayout 的 more 区接它,areaFromPath 把 /schedule 归「more」,删消息侧栏定时任务入口,/more 内容左对齐。无后端改动。

**Tech Stack:** Next.js App Router、next-intl、Tailwind v4、lucide-react。

## Global Constraints
- 全简体中文文案;新增 t() 后 `pnpm sync:locales --write`(根脚本)补 stub。
- Slack 风格左对齐,沿用 `messages-sidebar` 容器范式(`bg-(--shell-sidebar)`、h-11 标题栏、nav 项 class)。
- 收尾:`pnpm --filter @meshbot/web-agent typecheck` + `pnpm test -- --roots apps/web-agent` + `pnpm check`(含 check:dead) + `pnpm exec biome check --write apps/web-agent/src`。
- 提交中文 conventional + `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` 尾。

---

### Task 1: areaFromPath 把 /schedule 归「更多」（TDD）

**Files:** Modify `apps/web-agent/src/lib/area-from-path.ts` + `.test.ts`

- [ ] **Step 1:** `.test.ts` 改/加用例:`expect(areaFromPath("/schedule")).toBe("more")`(原应为 "messages",改它)、保留 `/more` → "more"、`/messages` → "messages"、`/skills` → "skills"。运行确认 /schedule 用例失败。
- [ ] **Step 2:** `area-from-path.ts`:从「messages」分支移除 `pathname.startsWith("/schedule")`;在「more」分支改为 `if (pathname.startsWith("/more") || pathname.startsWith("/schedule")) return "more";`。
- [ ] **Step 3:** `pnpm test -- --roots apps/web-agent --testPathPatterns area-from-path` 全绿。

---

### Task 2: 新建 MoreSidebar + AppShellLayout 接线 + 删 PlaceholderSidebar

**Files:** Create `apps/web-agent/src/components/shell/more-sidebar.tsx`;Modify `apps/web-agent/src/components/layouts/app-shell-layout.tsx`;Delete `apps/web-agent/src/components/shell/placeholder-sidebar.tsx`;Modify `messages/zh.json`+`en.json`

- [ ] **Step 1:** 新建 `more-sidebar.tsx`(`"use client"`):容器同 messages-sidebar(`flex h-full flex-col bg-(--shell-sidebar) text-white` + h-11 标题栏显示 `t("rail.more")`)。两个 nav `<button>`(沿用 messages-sidebar 底部定时任务按钮的 class 范式):
  - 使用情况 → `router.push("/more")`,active `pathname === "/more"`,图标 `BarChart3`(lucide)。
  - 定时任务 → `router.push("/schedule")`,active `pathname.startsWith("/schedule")`,图标 `Clock`。
  用 `useRouter`/`usePathname`/`useTranslations("...")`;文案键 `more.usage`("使用情况")、`more.scheduled`(复用现有 `schedule`/`scheduled` 文案,按现有键命名,见下)。
- [ ] **Step 2:** `app-shell-layout.tsx`:import MoreSidebar,删 PlaceholderSidebar import;`autoSidebar` 的 `area === "more"` 分支由 `<PlaceholderSidebar .../>` 改为 `<MoreSidebar />`。
- [ ] **Step 3:** 删 `placeholder-sidebar.tsx`(已确认仅此一处引用)。
- [ ] **Step 4:** 文案:`messages/zh.json`+`en.json` 加 `more.usage`(中"使用情况"/英"Usage")、定时任务沿用现有 messages 段 `scheduled` 文案值("定时任务")作 MoreSidebar 标签(MoreSidebar 内可 `useTranslations()` 取对应命名空间;实现时按现有键定位"定时任务"文案,避免重复键)。`pnpm sync:locales --write`。
- [ ] **Step 5:** typecheck 通过。

---

### Task 3: 删消息侧栏定时任务入口 + /more 左对齐

**Files:** Modify `apps/web-agent/src/components/shell/messages-sidebar.tsx`、`apps/web-agent/src/app/more/page.tsx`

- [ ] **Step 1:** `messages-sidebar.tsx`:删除底部「定时任务入口」`<button>`(及其外层注释,约行 170-183);删 `Clock` import(确认 Clock 仅此处用,`router`/`pathname` 保留)。
- [ ] **Step 2:** `more/page.tsx`:内容容器左对齐——去掉居中(如 `mx-auto`/`text-center`/`items-center`),标题、区间切换、指标卡左对齐排布;stats 数据逻辑不动,仅排版 class 调整。
- [ ] **Step 3:** 收尾全验证:`pnpm --filter @meshbot/web-agent typecheck` + `pnpm test -- --roots apps/web-agent` + `pnpm check`(check:dead 应确认 PlaceholderSidebar 已无悬挂) + `pnpm exec biome check --write apps/web-agent/src`。

---

## Self-Review
- **Spec 覆盖**:MoreSidebar(改动1)=Task2;layout 接线(改动2)=Task2;areaFromPath(改动3)=Task1;删消息侧栏定时任务(改动4)=Task3;/more 左对齐(改动5)=Task3。全覆盖。
- **占位符**:文件路径/行号/class 范式/图标/文案键均具体;唯一"实现时定位"项=定时任务现有文案键(避免重复键),已指明策略。
- **类型一致**:areaFromPath 返回 "more" 与 layout 分支一致;MoreSidebar 路由 /more、/schedule 与 areaFromPath「more」分支一致。
- **风险**:check:dead 需 PlaceholderSidebar 删干净(import + 文件);定时任务文案不要新建重复键。
