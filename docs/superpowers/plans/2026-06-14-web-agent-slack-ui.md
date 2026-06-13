# web-agent Slack 风格 UI 改造 · 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `apps/web-agent` 重做成 Slack 式外壳（最左 rail + 顶部搜索栏 + 内嵌白色内容卡 + 橙色包边），rail 四区导航（主页/消息/助手/更多），助手区完整 Slack 化，登录页改左品牌右表单。

**Architecture:** 纯前端改造（Next.js 16 + React 19 + Tailwind v4 + next-intl）。新增 rail/topbar/sidebar 外壳原语，重写 `AppShellLayout` 按 pathname 选区渲染对应侧栏，把现有会话/消息组件重排为 Slack 行式。配色用 web-agent 局部 CSS 变量，不动共享 `packages/design`。

**Tech Stack:** Next.js 16（App Router）、React 19、Tailwind v4、next-intl、jotai、lucide-react、`@meshbot/design`（Button/Card/Input/DropdownMenu/Tooltip/Form）。

---

## 关于测试与验证（务必先读）

web-agent **没有任何前端测试设施**（package.json 无 test 脚本，根 jest 排除 `packages/` 与前端，无 vitest/RTL）。本计划遵循「跟随现有模式」原则，**不引入前端单测框架**（属额外范围，用户未要求）。每个任务的验证 = 以下命令全过 + 必要时人工目测：

- **类型**：`pnpm --filter @meshbot/web-agent typecheck` → 期望 `0 errors`
- **格式/lint**：`pnpm biome check --write apps/web-agent/src` → 期望无剩余 error
- **i18n 对称**（仅改 messages 时）：`pnpm exec tsx scripts/sync-locales.ts -- --check` → 期望 `Done (missing=0, asymmetric=0)`
- **人工目测**：`pnpm dev:web-agent`（端口 3001）打开对应路由确认

提交信息用中文、conventional commits（CLAUDE.md 约定）。已在分支 `feat/web-agent-slack-ui`。

## 配色与 token（全程引用）

| 变量 | 值 | 用途 |
|------|----|------|
| `--shell-chrome` | `#9a3412` | 顶部搜索栏 + rail + 内容卡包边 |
| `--shell-sidebar` | `#d24a0d` | 区域侧栏背景 |
| `--shell-content` | 亮 `#ffffff` / 暗 `oklch(0.145 0 0)` | 内嵌内容卡背景 |
| `--shell-accent` | `#d24a0d` | 白底内主按钮/发送键/链接 |
| `--shell-radius` | `0.625rem`（10px） | 内容卡/rail 图标方块/pill 圆角 |
| rail 选中图标方块 | `rgba(255,255,255,0.22)` | — |
| 侧栏选中 pill | `rgba(255,255,255,0.24)` | — |
| 工作区「M」 | 白底 + `#9a3412` 字 | — |
| 用户头像 | `#16a34a` | — |

Tailwind 引用方式：`bg-[var(--shell-chrome)]`、`bg-[var(--shell-sidebar)]`、`rounded-[var(--shell-radius)]` 等 arbitrary value，配 `text-white` / `text-white/70`。

## 路由变更总览

| 区 | 路由 | 文件 | 本期 |
|----|------|------|------|
| 主页 | `/` | `app/page.tsx`（改为占位） | 占位 |
| 消息 | `/messages` | `app/messages/page.tsx`（新建占位） | 占位 |
| 助手 | `/assistant` | `app/assistant/page.tsx`（承接旧首页内容） | 完整 |
| 助手·会话 | `/session?id=` | `app/session/page.tsx`（路由不变） | 完整 |
| 助手·定时 | `/schedule` | 不变（rail 助手 active） | 不变 |
| 更多 | `/more` | `app/more/page.tsx`（新建占位） | 占位 |
| 设置·组织 | `/settings/org` | 不变（rail 不高亮，入口移到用户菜单） | 不变 |

登录/注册/会话空态/auth-guard 的默认落地从 `/` 改为 `/assistant`（Task 9）。

---

## Phase A — Token 与 i18n 基础

### Task 1: 注入 web-agent 外壳 CSS 变量

**Files:**
- Modify: `apps/web-agent/src/app/globals.css`

- [ ] **Step 1: 在 `:root` 段加入外壳变量**

在 [globals.css](apps/web-agent/src/app/globals.css) 的 `:root { --titlebar-height: 52px; ... }` 块**内**追加：

```css
:root {
  --titlebar-height: 52px;
  --mac-controls-safe-left: 92px;
  /* Slack 风格外壳配色（web-agent 局部，不进共享 design 系统） */
  --shell-chrome: #9a3412;
  --shell-sidebar: #d24a0d;
  --shell-content: #ffffff;
  --shell-accent: #d24a0d;
  --shell-radius: 0.625rem;
}
```

- [ ] **Step 2: 暗色模式覆盖内容卡背景**

在 globals.css 末尾追加（chrome/sidebar 暗色不变，只翻内容卡）：

```css
/* 暗色模式：橙色骨架保留，仅内嵌内容卡翻深色 */
html.dark {
  --shell-content: oklch(0.145 0 0);
}
```

- [ ] **Step 3: 验证构建**

Run: `pnpm --filter @meshbot/web-agent typecheck`
Expected: `0 errors`（CSS 改动不影响 TS，确认无连带破坏）

- [ ] **Step 4: 提交**

```bash
git add apps/web-agent/src/app/globals.css
git commit -m "feat(web-agent): 注入 Slack 外壳配色 CSS 变量（橙骨架/侧栏/内容卡）"
```

### Task 2: 新增 rail/区域/登录/用户菜单 i18n key

**Files:**
- Modify: `apps/web-agent/messages/en.json`
- Modify: `apps/web-agent/messages/zh.json`

> en/zh 必须同步增删同样的 key（sync-locales 校验对称）。在**命名空间段**（文件顶部 `appShell` / `login` / `session` 对象内）添加，不要动底部扁平兼容段。

- [ ] **Step 1: 给 `appShell` 命名空间加 rail/区域/搜索/用户菜单 key（en.json）**

在 [en.json](apps/web-agent/messages/en.json) 的 `"appShell": { ... }` 对象内追加：

```json
    "assistantTitle": "Assistant",
    "rail": {
      "home": "Home",
      "messages": "Messages",
      "assistant": "Assistant",
      "more": "More"
    },
    "search": {
      "placeholder": "Search meshbot"
    },
    "userMenu": {
      "org": "Organization",
      "settings": "Settings",
      "logout": "Log out"
    },
    "placeholder": {
      "homeTitle": "Home",
      "homeBody": "A global overview is coming soon — unread messages, local sessions and activity will live here.",
      "messagesTitle": "Messages",
      "messagesBody": "Real-time conversations with your teammates are coming soon.",
      "moreTitle": "More",
      "moreBody": "Files, knowledge base and more are coming soon.",
      "goAssistant": "Go to Assistant"
    }
```

- [ ] **Step 2: 给 `login` 命名空间加品牌文案（en.json）**

在 `"login": { ... }` 对象内追加：

```json
    "brandTagline": "Where your team and AI work together",
    "brandSubtitle": "Local agent + cloud collaboration — pick up your workflow anywhere.",
    "welcomeBack": "Welcome back to meshbot"
```

- [ ] **Step 3: 给 `session` 命名空间加助手名（en.json）**

在 `"session": { ... }` 对象内追加：

```json
    "assistantName": "Assistant",
    "youName": "You"
```

- [ ] **Step 4: 在 zh.json 同步全部对应 key**

在 [zh.json](apps/web-agent/messages/zh.json) 的 `appShell` / `login` / `session` 命名空间内追加等价中文：

```json
// appShell:
    "assistantTitle": "助手",
    "rail": { "home": "主页", "messages": "消息", "assistant": "助手", "more": "更多" },
    "search": { "placeholder": "搜索 meshbot" },
    "userMenu": { "org": "组织", "settings": "设置", "logout": "退出登录" },
    "placeholder": {
      "homeTitle": "主页",
      "homeBody": "全局概览即将上线 —— 未读消息、本地会话与活跃统计都会汇聚到这里。",
      "messagesTitle": "消息",
      "messagesBody": "与团队同事的实时会话即将上线。",
      "moreTitle": "更多",
      "moreBody": "文件、知识库等扩展能力即将上线。",
      "goAssistant": "前往助手"
    }
// login:
    "brandTagline": "让团队与 AI 一起协作",
    "brandSubtitle": "本地 Agent + 云端协同，随时随地接管你的工作流。",
    "welcomeBack": "欢迎回到 meshbot"
// session:
    "assistantName": "助手",
    "youName": "你"
```

- [ ] **Step 5: 验证 i18n 对称**

Run: `pnpm exec tsx scripts/sync-locales.ts -- --check`
Expected: `Done (missing=0, asymmetric=0)`（无新增 missing/asymmetric）

- [ ] **Step 6: 提交**

```bash
git add apps/web-agent/messages/en.json apps/web-agent/messages/zh.json
git commit -m "feat(web-agent): 新增 rail 导航/区域占位/登录品牌/用户菜单 i18n key"
```

---

## Phase B — 外壳原语组件

### Task 3: RailNavItem 组件

**Files:**
- Create: `apps/web-agent/src/components/shell/rail-nav-item.tsx`

- [ ] **Step 1: 写组件**

```tsx
"use client";

import { cn } from "@meshbot/design";
import type { ReactNode } from "react";

interface RailNavItemProps {
  icon: ReactNode;
  label: string;
  active?: boolean;
  onClick?: () => void;
}

/**
 * 最左 rail 的导航项：图标方块 + 下方文字标签。
 * 选中态高亮只作用于图标方块（半透明白），文字标签无背景，仅由暗→白提亮。
 */
export function RailNavItem({ icon, label, active = false, onClick }: RailNavItemProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex w-full flex-col items-center gap-1 py-1 transition-colors",
        active ? "text-white" : "text-white/65 hover:text-white",
      )}
    >
      <span
        className={cn(
          "flex h-9 w-9 items-center justify-center rounded-[var(--shell-radius)] transition-colors",
          active ? "bg-white/22" : "hover:bg-white/10",
        )}
      >
        {icon}
      </span>
      <span className="text-[10px] leading-none">{label}</span>
    </button>
  );
}
```

- [ ] **Step 2: 验证类型 + 格式**

Run: `pnpm --filter @meshbot/web-agent typecheck && pnpm biome check --write apps/web-agent/src/components/shell/rail-nav-item.tsx`
Expected: `0 errors`，biome 无剩余 error

- [ ] **Step 3: 提交**

```bash
git add apps/web-agent/src/components/shell/rail-nav-item.tsx
git commit -m "feat(web-agent): 新增 RailNavItem（图标方块高亮 + 文字标签）"
```

### Task 4: WorkspaceRail 组件（工作区 + 四区导航 + 主题 + 用户菜单）

**Files:**
- Create: `apps/web-agent/src/components/shell/workspace-rail.tsx`

- [ ] **Step 1: 写组件**

依赖：`usePathname`/`useRouter`、`useTheme`（`@meshbot/web-common/react`）、`useTranslations`、`currentUserAtom`（`@/atoms/auth`）、`useLogout`（`@/rest/auth`）、`DropdownMenu*`（`@meshbot/design`）、lucide 图标。

```tsx
"use client";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@meshbot/design";
import { useTheme } from "@meshbot/web-common/react";
import { useAtomValue } from "jotai";
import { Building2, Home, MessageSquare, Moon, MoreHorizontal, Sparkles, Sun } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback } from "react";
import { currentUserAtom } from "@/atoms/auth";
import { RailNavItem } from "@/components/shell/rail-nav-item";
import { useLogout } from "@/rest/auth";

/** 由 pathname 推断当前 rail 区域。 */
export function areaFromPath(pathname: string): "home" | "messages" | "assistant" | "more" | "other" {
  if (pathname.startsWith("/messages")) return "messages";
  if (
    pathname.startsWith("/assistant") ||
    pathname.startsWith("/session") ||
    pathname.startsWith("/schedule")
  )
    return "assistant";
  if (pathname.startsWith("/more")) return "more";
  if (pathname === "/") return "home";
  return "other";
}

export function WorkspaceRail() {
  const router = useRouter();
  const pathname = usePathname();
  const t = useTranslations("appShell");
  const { theme, toggleTheme } = useTheme();
  const user = useAtomValue(currentUserAtom);
  const logoutMutation = useLogout();
  const area = areaFromPath(pathname);

  const handleLogout = useCallback(async () => {
    await logoutMutation.mutateAsync().catch(() => {});
    router.replace("/login");
  }, [logoutMutation.mutateAsync, router]);

  const initial = (user?.displayName ?? user?.email ?? "?").charAt(0).toUpperCase();

  return (
    <div className="flex h-full w-[68px] shrink-0 flex-col items-center gap-2 bg-[var(--shell-chrome)] px-1.5 pt-2 pb-2">
      <div className="flex h-8 w-8 items-center justify-center rounded-[var(--shell-radius)] bg-white text-[15px] font-extrabold text-[var(--shell-chrome)]">
        M
      </div>
      <nav className="mt-1 flex w-full flex-col gap-1">
        <RailNavItem icon={<Home className="h-5 w-5" />} label={t("rail.home")} active={area === "home"} onClick={() => router.push("/")} />
        <RailNavItem icon={<MessageSquare className="h-5 w-5" />} label={t("rail.messages")} active={area === "messages"} onClick={() => router.push("/messages")} />
        <RailNavItem icon={<Sparkles className="h-5 w-5" />} label={t("rail.assistant")} active={area === "assistant"} onClick={() => router.push("/assistant")} />
        <RailNavItem icon={<MoreHorizontal className="h-5 w-5" />} label={t("rail.more")} active={area === "more"} onClick={() => router.push("/more")} />
      </nav>
      <div className="flex-1" />
      <button
        type="button"
        onClick={toggleTheme}
        className="flex h-9 w-9 items-center justify-center rounded-[var(--shell-radius)] text-white/65 transition-colors hover:bg-white/10 hover:text-white"
        title={theme === "dark" ? t("userMenu.settings") : t("userMenu.settings")}
      >
        {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex h-8 w-8 items-center justify-center rounded-[var(--shell-radius)] bg-[#16a34a] text-[13px] font-semibold text-white"
            title={user?.displayName ?? user?.email ?? ""}
          >
            {initial}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="end">
          <DropdownMenuItem onClick={() => router.push("/settings/org")}>
            <Building2 className="mr-2 h-4 w-4" />
            {t("userMenu.org")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => void handleLogout()} disabled={logoutMutation.isPending}>
            {t("userMenu.logout")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
```

> 注意：`currentUserAtom` 的 `UserInfo` 字段名（`displayName`/`email`）若与实际类型不符，按实际类型调整取值；执行时打开 `apps/web-agent/src/atoms/auth.ts` 确认。

- [ ] **Step 2: 验证类型 + 格式**

Run: `pnpm --filter @meshbot/web-agent typecheck && pnpm biome check --write apps/web-agent/src/components/shell/workspace-rail.tsx`
Expected: `0 errors`

- [ ] **Step 3: 提交**

```bash
git add apps/web-agent/src/components/shell/workspace-rail.tsx
git commit -m "feat(web-agent): 新增 WorkspaceRail（四区导航 + 主题切换 + 用户菜单含组织/登出）"
```

### Task 5: ShellTopBar 组件（前进后退 + 搜索 + 帮助）

**Files:**
- Create: `apps/web-agent/src/components/shell/shell-top-bar.tsx`

- [ ] **Step 1: 写组件**

```tsx
"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { ChevronLeft, ChevronRight, HelpCircle, Search } from "lucide-react";

/**
 * 顶部全宽搜索栏（位于橙色 chrome 上）。左：前进/后退；中：全局搜索（本期 UI 占位）；右：帮助。
 * 整条作为 Electron 拖拽区（.drag-handle），按钮 [data-no-drag]。
 */
export function ShellTopBar() {
  const router = useRouter();
  const t = useTranslations("appShell");
  return (
    <div className="drag-handle flex h-[42px] shrink-0 items-center gap-2 bg-[var(--shell-chrome)] px-3">
      <div className="app-mac-controls-safe-left flex items-center gap-0.5">
        <button type="button" data-no-drag onClick={() => router.back()} className="flex h-7 w-7 items-center justify-center rounded-md text-white/65 hover:bg-white/10 hover:text-white">
          <ChevronLeft className="h-4 w-4" />
        </button>
        <button type="button" data-no-drag onClick={() => router.forward()} className="flex h-7 w-7 items-center justify-center rounded-md text-white/65 hover:bg-white/10 hover:text-white">
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
      <div className="mx-auto w-full max-w-[460px]">
        <div data-no-drag className="flex h-7 items-center gap-2 rounded-md bg-white/15 px-3 text-white/70">
          <Search className="h-3.5 w-3.5" />
          <span className="text-[12px]">{t("search.placeholder")}</span>
        </div>
      </div>
      <button type="button" data-no-drag className="flex h-7 w-7 items-center justify-center rounded-md text-white/65 hover:bg-white/10 hover:text-white">
        <HelpCircle className="h-4 w-4" />
      </button>
    </div>
  );
}
```

- [ ] **Step 2: 验证 + 提交**

Run: `pnpm --filter @meshbot/web-agent typecheck && pnpm biome check --write apps/web-agent/src/components/shell/shell-top-bar.tsx`
Expected: `0 errors`
```bash
git add apps/web-agent/src/components/shell/shell-top-bar.tsx
git commit -m "feat(web-agent): 新增 ShellTopBar（前进后退 + 搜索占位 + 帮助，整条可拖拽）"
```

### Task 6: AssistantSidebar 组件（会话列表，从旧 AppShellLayout 抽出）

**Files:**
- Create: `apps/web-agent/src/components/shell/assistant-sidebar.tsx`

- [ ] **Step 1: 写组件**

把旧 `AppShellLayout` 里的会话加载 + socket title 更新 + 列表渲染逻辑搬到这里，套上橙色侧栏样式。复用现有 `SessionListSection` / `SessionListSkeleton` 与 sessions atoms。顶部为「助手」标题 + 新建会话按钮（→ `/assistant`）；底部一行「定时任务」入口（→ `/schedule`）。

```tsx
"use client";

import { SESSION_WS_EVENTS, type SessionTitleUpdatedEvent } from "@meshbot/types-agent";
import { useAtomValue, useSetAtom } from "jotai";
import { Clock, SquarePen } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import {
  loadSessionsAtom,
  pinnedSessionsAtom,
  recentSessionsAtom,
  reloadSessionsAtom,
  sessionsStatusAtom,
  updateSessionTitleAtom,
} from "@/atoms/sessions";
import { SessionListSection } from "@/components/sidebar/session-list-section";
import { SessionListSkeleton } from "@/components/sidebar/session-list-skeleton";
import { getSessionSocket } from "@/lib/socket";

export function AssistantSidebar() {
  const router = useRouter();
  const pathname = usePathname();
  const t = useTranslations("appShell");
  const pinned = useAtomValue(pinnedSessionsAtom);
  const recent = useAtomValue(recentSessionsAtom);
  const status = useAtomValue(sessionsStatusAtom);
  const loadSessions = useSetAtom(loadSessionsAtom);
  const reload = useSetAtom(reloadSessionsAtom);
  const updateSessionTitle = useSetAtom(updateSessionTitleAtom);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    const socket = getSessionSocket();
    const onTitleUpdated = (e: SessionTitleUpdatedEvent) => updateSessionTitle({ id: e.sessionId, title: e.title });
    const onConnect = () => void reload();
    socket.on(SESSION_WS_EVENTS.titleUpdated, onTitleUpdated);
    socket.on("connect", onConnect);
    return () => {
      socket.off(SESSION_WS_EVENTS.titleUpdated, onTitleUpdated);
      socket.off("connect", onConnect);
    };
  }, [updateSessionTitle, reload]);

  return (
    <div className="flex h-full flex-col bg-[var(--shell-sidebar)] px-2 py-2.5 text-white">
      <div className="flex items-center justify-between border-b border-white/15 px-1.5 pb-2.5">
        <span className="text-[15px] font-extrabold">{t("assistantTitle")}</span>
        <button type="button" onClick={() => router.push("/assistant")} title={t("newSession")} className="flex h-7 w-7 items-center justify-center rounded-md text-white/80 hover:bg-white/15 hover:text-white">
          <SquarePen className="h-4 w-4" />
        </button>
      </div>

      <div className="mt-1 flex min-h-0 flex-1 flex-col overflow-y-auto">
        {pinned.length > 0 && <SessionListSection title={t("pinned")} sessions={pinned} />}
        {status === "loading" ? (
          <div className="mt-4">
            <div className="px-2 text-[12px] font-medium text-white/70">{t("sessions")}</div>
            <SessionListSkeleton />
          </div>
        ) : status === "error" ? (
          <div className="mt-4 px-2 text-xs text-white/80">
            {t("loadFailed")}{" "}
            <button type="button" onClick={() => void reload()} className="underline hover:text-white">
              {t("retry")}
            </button>
          </div>
        ) : (
          (recent.length > 0 || pinned.length === 0) && (
            <SessionListSection title={t("sessions")} sessions={recent} emptyText={t("sessionsEmpty")} />
          )
        )}
      </div>

      <button
        type="button"
        onClick={() => router.push("/schedule")}
        className={`mt-1 flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] transition-colors ${pathname.startsWith("/schedule") ? "bg-white/24 text-white" : "text-white/85 hover:bg-white/12 hover:text-white"}`}
      >
        <Clock className="h-4 w-4" />
        {t("scheduled")}
      </button>
    </div>
  );
}
```

> `SessionListSection` / `SessionListItem` 内部当前用 `bg-accent text-white`、`text-muted-foreground` 等中性 token，放进橙色侧栏后对比可能偏弱。Task 6b 微调它们。

- [ ] **Step 2: 验证 + 提交**

Run: `pnpm --filter @meshbot/web-agent typecheck && pnpm biome check --write apps/web-agent/src/components/shell/assistant-sidebar.tsx`
Expected: `0 errors`
```bash
git add apps/web-agent/src/components/shell/assistant-sidebar.tsx
git commit -m "feat(web-agent): 新增 AssistantSidebar（会话列表 + 定时入口，橙色侧栏）"
```

### Task 6b: 适配 SessionListSection / SessionListItem 到橙色侧栏

**Files:**
- Modify: `apps/web-agent/src/components/sidebar/session-list-section.tsx`
- Modify: `apps/web-agent/src/components/sidebar/session-list-item.tsx`

- [ ] **Step 1: 调整分组标题颜色**

打开 [session-list-section.tsx](apps/web-agent/src/components/sidebar/session-list-section.tsx)，把标题用的 `text-muted-foreground`/类似中性灰，改为 `text-white/70`；空态文案 `text-white/55`。保持结构不变。

- [ ] **Step 2: 调整列表项选中/hover/菜单态**

打开 [session-list-item.tsx](apps/web-agent/src/components/sidebar/session-list-item.tsx)：
- 选中态由 `bg-accent text-white` 改为 `bg-white/24 text-white`（半透明白 pill）。
- 默认文字 `text-white/85`，hover `hover:bg-white/12 hover:text-white`。
- 图标与三点菜单触发的 `text-muted-foreground` 改为 `text-white/70`。
- DropdownMenu 内容（rename/pin/delete）保持 design 默认（弹层是白底，不受侧栏影响）。

> 仅改 className 颜色，不动编辑/删除/置顶交互逻辑与路由（`/session?id=`）。

- [ ] **Step 3: 验证 + 提交**

Run: `pnpm --filter @meshbot/web-agent typecheck && pnpm biome check --write apps/web-agent/src/components/sidebar`
Expected: `0 errors`
```bash
git add apps/web-agent/src/components/sidebar/session-list-section.tsx apps/web-agent/src/components/sidebar/session-list-item.tsx
git commit -m "style(web-agent): 会话列表分组/项适配橙色侧栏（白系文字 + 半透明白选中）"
```

### Task 7: 区域占位组件（主页/消息/更多共用）

**Files:**
- Create: `apps/web-agent/src/components/shell/placeholder-sidebar.tsx`
- Create: `apps/web-agent/src/components/shell/area-placeholder.tsx`

- [ ] **Step 1: PlaceholderSidebar（橙侧栏 + 区名标题，无列表）**

```tsx
"use client";

export function PlaceholderSidebar({ title }: { title: string }) {
  return (
    <div className="flex h-full flex-col bg-[var(--shell-sidebar)] px-2 py-2.5 text-white">
      <div className="border-b border-white/15 px-1.5 pb-2.5 text-[15px] font-extrabold">{title}</div>
    </div>
  );
}
```

- [ ] **Step 2: AreaPlaceholder（内容区「敬请期待」空态 + 去助手 CTA）**

```tsx
"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

export function AreaPlaceholder({ titleKey, bodyKey }: { titleKey: string; bodyKey: string }) {
  const router = useRouter();
  const t = useTranslations("appShell");
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <h1 className="text-2xl font-semibold text-foreground">{t(titleKey)}</h1>
      <p className="max-w-md text-sm text-muted-foreground">{t(bodyKey)}</p>
      <button
        type="button"
        onClick={() => router.push("/assistant")}
        className="mt-2 rounded-[var(--shell-radius)] bg-[var(--shell-accent)] px-4 py-2 text-sm font-medium text-white hover:opacity-90"
      >
        {t("placeholder.goAssistant")}
      </button>
    </div>
  );
}
```

- [ ] **Step 3: 验证 + 提交**

Run: `pnpm --filter @meshbot/web-agent typecheck && pnpm biome check --write apps/web-agent/src/components/shell`
Expected: `0 errors`
```bash
git add apps/web-agent/src/components/shell/placeholder-sidebar.tsx apps/web-agent/src/components/shell/area-placeholder.tsx
git commit -m "feat(web-agent): 新增区域占位组件（PlaceholderSidebar + AreaPlaceholder）"
```

---

## Phase C — 外壳装配与路由

### Task 8: 重写 AppShellLayout（rail + topbar + 选区侧栏 + 内嵌内容卡）

**Files:**
- Modify: `apps/web-agent/src/components/layouts/app-shell-layout.tsx`

- [ ] **Step 1: 整体重写**

新结构：最外层橙色 chrome（含包边）→ 顶部 `ShellTopBar` → 下方 `WorkspaceRail` + 区域侧栏 + 内嵌白色内容卡。侧栏按 `areaFromPath` 选择；新增可选 `sidebar` prop（传 `null` 时不渲染侧栏，用于设置页）。保留 `scrollContainerRef` 与 `app-shell-mode` body class、Electron 安全区逻辑。

```tsx
"use client";

import { cn } from "@meshbot/design";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, type ReactNode } from "react";
import { DragRegion } from "@/components/drag-region";
import { AssistantSidebar } from "@/components/shell/assistant-sidebar";
import { PlaceholderSidebar } from "@/components/shell/placeholder-sidebar";
import { ShellTopBar } from "@/components/shell/shell-top-bar";
import { WorkspaceRail, areaFromPath } from "@/components/shell/workspace-rail";

interface AppShellLayoutProps {
  children: ReactNode;
  className?: string;
  scrollContainerRef?: React.RefObject<HTMLDivElement | null>;
  /** 侧栏覆盖：undefined=按区自动选；null=不渲染侧栏（设置页用）。 */
  sidebar?: ReactNode | null;
}

export function AppShellLayout({ children, className, scrollContainerRef, sidebar }: AppShellLayoutProps) {
  const pathname = usePathname();
  const t = useTranslations("appShell");
  const area = areaFromPath(pathname);

  useEffect(() => {
    document.body.classList.add("app-shell-mode");
    return () => document.body.classList.remove("app-shell-mode");
  }, []);

  const autoSidebar =
    area === "assistant" ? <AssistantSidebar />
    : area === "messages" ? <PlaceholderSidebar title={t("rail.messages")} />
    : area === "more" ? <PlaceholderSidebar title={t("rail.more")} />
    : area === "home" ? <PlaceholderSidebar title={t("rail.home")} />
    : null;
  const resolvedSidebar = sidebar === undefined ? autoSidebar : sidebar;

  return (
    <main className="titlebar-safe flex h-screen flex-col bg-[var(--shell-chrome)] text-foreground">
      {/* 保留 DragRegion：Electron Linux 窗口控制按钮 + macOS 安全区由它承载 */}
      <DragRegion />
      <ShellTopBar />
      <div className="flex min-h-0 flex-1">
        <WorkspaceRail />
        <div className="flex min-h-0 flex-1 gap-0 pr-1.5 pb-1.5">
          {resolvedSidebar && (
            <aside className="hidden w-[240px] shrink-0 overflow-hidden rounded-l-[var(--shell-radius)] lg:block">
              {resolvedSidebar}
            </aside>
          )}
          <section className="relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-r-[var(--shell-radius)] bg-[var(--shell-content)]">
            <div ref={scrollContainerRef} className={cn("flex min-h-0 flex-1 flex-col overflow-y-auto", className)}>
              <div className="mx-auto flex w-full max-w-[900px] flex-1 flex-col p-4 lg:px-10">{children}</div>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
```

> 若内容卡无侧栏时希望左上角也圆角，给 `<section>` 在 `!resolvedSidebar` 时改 `rounded-[var(--shell-radius)]`（条件 className）。

- [ ] **Step 2: 验证类型 + 格式**

Run: `pnpm --filter @meshbot/web-agent typecheck && pnpm biome check --write apps/web-agent/src/components/layouts/app-shell-layout.tsx`
Expected: `0 errors`

- [ ] **Step 3: 人工目测（旧路由暂时还在 `/`）**

Run: `pnpm dev:web-agent`，访问 `http://localhost:3001/session?id=<任一会话>`，确认 rail + 橙侧栏 + 顶栏 + 白内容卡显示正常（会话列表此时来自 AssistantSidebar）。

- [ ] **Step 4: 提交**

```bash
git add apps/web-agent/src/components/layouts/app-shell-layout.tsx
git commit -m "feat(web-agent): 重写 AppShellLayout 为 rail + 顶栏 + 选区侧栏 + 内嵌内容卡"
```

### Task 9: 路由重排（主页占位 / 助手承接旧首页 / 消息·更多占位 / 默认落地改 /assistant）

**Files:**
- Create: `apps/web-agent/src/app/assistant/page.tsx`（旧首页内容迁入）
- Modify: `apps/web-agent/src/app/page.tsx`（改为主页占位）
- Create: `apps/web-agent/src/app/messages/page.tsx`
- Create: `apps/web-agent/src/app/more/page.tsx`
- Modify: `apps/web-agent/src/app/login/page.tsx`（落地 `/assistant`）
- Modify: `apps/web-agent/src/app/session/page.tsx`（空 id 回退 `/assistant`）
- Modify: `apps/web-agent/src/app/setup/page.tsx`（完成后落地 `/assistant`）
- Modify: `apps/web-agent/src/components/auth-guard.tsx`（已登录默认 `/assistant`，若其有此逻辑）

- [ ] **Step 1: 迁移旧首页内容到 `/assistant`**

把当前 [app/page.tsx](apps/web-agent/src/app/page.tsx) 的**全部内容**原样复制到新文件 `apps/web-agent/src/app/assistant/page.tsx`，仅改：函数名 `Home` → `AssistantHome`，`createSession` 成功后仍 `router.push(\`/session?id=${sessionId}\`)`（不变）。其余（stats/heatmap/SuggestionChips/ChatInput/AppShellLayout）保持。

- [ ] **Step 2: `/` 改为主页占位**

把 [app/page.tsx](apps/web-agent/src/app/page.tsx) 整体替换为：

```tsx
"use client";

import { AppShellLayout } from "@/components/layouts/app-shell-layout";
import { AreaPlaceholder } from "@/components/shell/area-placeholder";

export default function HomePage() {
  return (
    <AppShellLayout>
      <AreaPlaceholder titleKey="placeholder.homeTitle" bodyKey="placeholder.homeBody" />
    </AppShellLayout>
  );
}
```

- [ ] **Step 3: 新建消息占位 `app/messages/page.tsx`**

```tsx
"use client";

import { AppShellLayout } from "@/components/layouts/app-shell-layout";
import { AreaPlaceholder } from "@/components/shell/area-placeholder";

export default function MessagesPage() {
  return (
    <AppShellLayout>
      <AreaPlaceholder titleKey="placeholder.messagesTitle" bodyKey="placeholder.messagesBody" />
    </AppShellLayout>
  );
}
```

- [ ] **Step 4: 新建更多占位 `app/more/page.tsx`**

```tsx
"use client";

import { AppShellLayout } from "@/components/layouts/app-shell-layout";
import { AreaPlaceholder } from "@/components/shell/area-placeholder";

export default function MorePage() {
  return (
    <AppShellLayout>
      <AreaPlaceholder titleKey="placeholder.moreTitle" bodyKey="placeholder.moreBody" />
    </AppShellLayout>
  );
}
```

- [ ] **Step 5: 改默认落地路由**

- [login/page.tsx](apps/web-agent/src/app/login/page.tsx) 第 32 行：`router.push("/")` → `router.push("/assistant")`。
- [session/page.tsx](apps/web-agent/src/app/session/page.tsx) 第 193 行：`router.replace("/")` → `router.replace("/assistant")`。
- [setup/page.tsx](apps/web-agent/src/app/setup/page.tsx)：完成 model 步骤后跳转 `/` 的位置改为 `/assistant`（grep `"/"` 确认实际行）。
- `apps/web-agent/src/components/auth-guard.tsx`：若含「已登录访问 /login 重定向到 /」逻辑，把目标 `/` 改 `/assistant`（grep 确认，没有则跳过）。

- [ ] **Step 6: 设置页不渲染侧栏**

[settings/org/page.tsx](apps/web-agent/src/app/settings/org/page.tsx)：把 `<AppShellLayout>` 改为 `<AppShellLayout sidebar={null}>`（org 入口已在用户菜单，设置页内容占满内容卡）。

- [ ] **Step 7: 验证类型 + 格式 + 目测全路由**

Run: `pnpm --filter @meshbot/web-agent typecheck && pnpm biome check --write apps/web-agent/src/app`
Expected: `0 errors`
Run: `pnpm dev:web-agent`，逐一访问 `/`、`/messages`、`/more`（占位 + 去助手 CTA）、`/assistant`（统计+输入框）、`/session?id=`、`/schedule`、`/settings/org`（无侧栏），确认 rail 高亮正确（help/messages/assistant/more）。

- [ ] **Step 8: 提交**

```bash
git add apps/web-agent/src/app
git commit -m "feat(web-agent): rail 路由重排（主页/消息/更多占位 + 助手承接旧首页 + 默认落地 /assistant）"
```

---

## Phase D — 助手区 Slack 行式消息

### Task 9b: SessionHeader（会话内容顶栏：标题 + 置顶星）

**Files:**
- Create: `apps/web-agent/src/components/session/session-header.tsx`
- Modify: `apps/web-agent/src/app/session/page.tsx`

> 对应 spec §6.2。会话标题取自 `sessionsAtom`（按 id 查 `SessionSummary`），置顶用现有 `togglePinAtom`。「导出」当前**无对应功能**，本期不做（不臆造按钮）；重命名/删除仍走侧栏列表项的下拉菜单，避免重复。

- [ ] **Step 1: 写 SessionHeader**

```tsx
"use client";

import { useAtomValue, useSetAtom } from "jotai";
import { Star } from "lucide-react";
import { sessionsAtom, togglePinAtom } from "@/atoms/sessions";

export function SessionHeader({ sessionId }: { sessionId: string }) {
  const sessions = useAtomValue(sessionsAtom);
  const togglePin = useSetAtom(togglePinAtom);
  const session = sessions.find((s) => s.id === sessionId);
  if (!session) return null;
  return (
    <div className="sticky top-0 z-10 -mx-4 flex h-11 items-center gap-2 border-b border-border bg-[var(--shell-content)] px-4 lg:-mx-10 lg:px-10">
      <button
        type="button"
        onClick={() => void togglePin(session.id)}
        className={session.pinned ? "text-[var(--shell-accent)]" : "text-muted-foreground hover:text-foreground"}
        aria-pressed={session.pinned}
      >
        <Star className="h-4 w-4" fill={session.pinned ? "currentColor" : "none"} />
      </button>
      <span className="truncate text-[13px] font-semibold text-foreground">{session.title}</span>
    </div>
  );
}
```

> 确认 `togglePinAtom` 的入参签名（id 字符串 vs 对象）；按 `apps/web-agent/src/atoms/sessions.ts` 实际签名调整调用。`SessionSummary` 字段 `id`/`title`/`pinned` 若名称不同，按实际类型调整。

- [ ] **Step 2: 在会话页挂载 SessionHeader**

[session/page.tsx](apps/web-agent/src/app/session/page.tsx)：在 `return (<AppShellLayout ...>` 的 `<div className="flex w-full flex-1 flex-col">` **之前/之上**插入（即内容卡顶部）：

```tsx
{sessionId && <SessionHeader sessionId={sessionId} />}
```

并在文件顶部 `import { SessionHeader } from "@/components/session/session-header";`。其余消息列表/输入框/滚动逻辑不动。

- [ ] **Step 3: 验证 + 提交**

Run: `pnpm --filter @meshbot/web-agent typecheck && pnpm biome check --write apps/web-agent/src/components/session/session-header.tsx apps/web-agent/src/app/session/page.tsx`
Expected: `0 errors`
```bash
git add apps/web-agent/src/components/session/session-header.tsx apps/web-agent/src/app/session/page.tsx
git commit -m "feat(web-agent): 新增会话内容顶栏 SessionHeader（标题 + 置顶星）"
```

### Task 10: MessageList 重排为 Slack 行（头像 + 名字 + 内容）

**Files:**
- Modify: `apps/web-agent/src/components/session/message-list.tsx`

- [ ] **Step 1: 重写顶层布局为行式，保留所有子渲染**

目标：把现有「user 右对齐色块 / assistant 左对齐」改为统一 Slack 行：`头像 + (名字 + 正文/工具块/reasoning/actions)`，整列左对齐。**保留**：`CompactionRow`、`ReasoningBlock`、`TypingDots`、`MarkdownContent`、`ToolCallBlock`、`AssistantMessageActions`、`UserMessageActions`、所有 `m.loading/streaming/failed/reasoning/toolCalls/metadata` 分支判断逻辑。

具体改动（基于现 [message-list.tsx](apps/web-agent/src/components/session/message-list.tsx) 第 86-204 行 `MessageList`）：

1. 顶部容器 `flex flex-col gap-8 pb-6` → `flex flex-col gap-5 pb-6`。
2. 引入用户名/助手名与头像。文件顶部加：

```tsx
import { useAtomValue } from "jotai";
import { currentUserAtom } from "@/atoms/auth";
```

在 `MessageList` 函数体首部加：

```tsx
  const t = useTranslations("session");
  const user = useAtomValue(currentUserAtom);
  const userName = user?.displayName ?? user?.email ?? t("youName");
  const userInitial = userName.charAt(0).toUpperCase();
  const assistantName = t("assistantName");
```

3. 把每条消息（非 compaction）的外层 `<div>` 从「按 role 改宽度/对齐」改为统一行：

```tsx
return (
  <div key={m.id} className="group relative flex gap-3">
    {/* 头像 */}
    {m.role === "user" ? (
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] bg-[#16a34a] text-[12px] font-semibold text-white">
        {userInitial}
      </div>
    ) : (
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] bg-[var(--shell-accent)] text-white">
        <Sparkles className="h-4 w-4" />
      </div>
    )}
    {/* 名字 + 内容 */}
    <div className="min-w-0 flex-1">
      <div className="mb-1 text-[13px] font-bold text-foreground">
        {m.role === "user" ? userName : assistantName}
      </div>
      {/* —— 以下保留原有 reasoning / 正文 / toolCalls / actions 全部分支，
            只是去掉原 user 右对齐色块样式：user 正文也改为普通文本行 —— */}
      ...
    </div>
  </div>
);
```

4. 正文块：原 user 用 `bg-foreground/8` 色块、assistant 无背景。新版**两者都无大色块**（Slack 行式靠头像/名字区分）。把正文 `<div>` 统一为：

```tsx
{(m.role === "user" || m.content || m.loading || m.streaming || m.failed) && (
  <div className={cn("text-sm leading-relaxed text-foreground", m.failed && "text-destructive")}>
    {m.loading ? <TypingDots /> : m.role === "assistant"
      ? <MarkdownContent text={m.content} streaming={m.streaming} />
      : <span className="whitespace-pre-wrap">{m.content}{m.streaming && (
          <span className="ml-0.5 inline-block w-[2px] animate-pulse bg-muted-foreground/60 align-middle">&nbsp;</span>
        )}</span>}
  </div>
)}
```

5. `reasoning` 块、`toolCalls` 块、`AssistantMessageActions`、`UserMessageActions` 的渲染条件与 props **完全照搬**原逻辑，只是现在都嵌在 `名字+内容` 的右列 `<div className="min-w-0 flex-1">` 内（user actions 不再 absolute 贴左，可改为 hover 显示的行内按钮组——见 Task 10b）。

6. 顶部加 `import { Sparkles } from "lucide-react";`（已用到）。`ChevronRight` 等保留。

> 失败/重试：`UserMessageActions` 现为 absolute 定位贴气泡左侧；行式布局下改为放在用户名同行右侧或正文下方。本 Task 先让它跟随在正文下方（行内），视觉细节交 Task 10b。

- [ ] **Step 2: 验证类型 + 格式**

Run: `pnpm --filter @meshbot/web-agent typecheck && pnpm biome check --write apps/web-agent/src/components/session/message-list.tsx`
Expected: `0 errors`

- [ ] **Step 3: 人工目测**

Run: `pnpm dev:web-agent`，进入一个有历史的会话，确认：用户/助手都为左对齐行（头像+名字+内容）、Markdown/代码块正常、工具调用块出现、流式光标、reasoning 折叠、滚动跟随与上拉加载不破。

- [ ] **Step 4: 提交**

```bash
git add apps/web-agent/src/components/session/message-list.tsx
git commit -m "feat(web-agent): 消息时间线改为 Slack 行式（头像 + 名字 + 左对齐内容）"
```

### Task 10b: 用户消息操作条改行内 + 工具块卡片化

**Files:**
- Modify: `apps/web-agent/src/components/session/user-message-actions.tsx`
- Modify: `apps/web-agent/src/components/session/tool-call-block.tsx`

- [ ] **Step 1: UserMessageActions 改行内 hover 按钮组**

打开 [user-message-actions.tsx](apps/web-agent/src/components/session/user-message-actions.tsx)，把容器的 absolute 定位（`right-full mr-1.5 top-1/2 -translate-y-1/2`）改为静态行内：`mt-1 flex gap-1 opacity-0 group-hover:opacity-100`（failed 时强制 `opacity-100`）。复制/重试两个按钮与逻辑不变。

- [ ] **Step 2: ToolCallBlock 卡片化**

打开 [tool-call-block.tsx](apps/web-agent/src/components/session/tool-call-block.tsx)，把外层容器加边框卡片样式：`rounded-[8px] border border-border overflow-hidden`，头部行 `bg-muted/40 px-2.5 py-1.5`，状态徽标（running/ok/error）保留。展开区 `px-2.5 py-2`。保留 `mcp__server__tool` 名称解析与 Request/Response 渲染逻辑。

- [ ] **Step 3: 验证 + 提交**

Run: `pnpm --filter @meshbot/web-agent typecheck && pnpm biome check --write apps/web-agent/src/components/session`
Expected: `0 errors`
```bash
git add apps/web-agent/src/components/session/user-message-actions.tsx apps/web-agent/src/components/session/tool-call-block.tsx
git commit -m "style(web-agent): 用户操作条改行内 hover + 工具调用块卡片化"
```

### Task 11: ChatInput 改 Slack 富文本外观

**Files:**
- Modify: `apps/web-agent/src/components/common/chat-input.tsx`

- [ ] **Step 1: 重排为「工具栏 + 输入 + 底部行」三段**

保留**全部** contentEditable 逻辑（`editorRef`、`handleInput/handleSend/handleKeyDown`、IME 处理、`useImperativeHandle`、token 进度环 Tooltip）。仅改外层视觉：

1. 外层容器 `rounded-none border border-border bg-card` → `rounded-[10px] border border-border bg-card overflow-hidden`。
2. 在输入区**上方**加一行装饰工具栏（纯视觉，本期不接富文本编辑）：

```tsx
<div className="flex items-center gap-3 border-b border-border px-3 py-1.5 text-muted-foreground">
  <span className="text-[13px] font-bold">B</span>
  <span className="text-[13px] italic">I</span>
  <span className="text-[13px] underline">U</span>
  <span className="text-[13px]">≡</span>
  <span className="text-[12px] font-mono">{"</>"}</span>
</div>
```

3. 底部行：左侧附件按钮（保留），右侧把发送按钮改橙：`bg-[var(--shell-accent)] text-white rounded-md`（`hasContent` 时实色，否则灰禁用）；模型名 `modelName` 渲染为 chip：`rounded-full border border-border px-2 py-0.5 text-[11px]`。token 进度环 Tooltip 保留在底部行右侧。

> 工具栏按钮先做装饰（无 onClick）。Enter 发送、Shift+Enter 换行、IME 行为一律不动。

- [ ] **Step 2: 验证 + 目测**

Run: `pnpm --filter @meshbot/web-agent typecheck && pnpm biome check --write apps/web-agent/src/components/common/chat-input.tsx`
Expected: `0 errors`
Run: `pnpm dev:web-agent`，在 `/assistant` 与会话页测试：输入中文（IME 候选不被回车吞）、Enter 发送、Shift+Enter 换行、发送键橙色态、token 环 tooltip。

- [ ] **Step 3: 提交**

```bash
git add apps/web-agent/src/components/common/chat-input.tsx
git commit -m "feat(web-agent): ChatInput 改 Slack 富文本外观（工具栏 + 模型 chip + 橙发送键）"
```

---

## Phase E — 登录与注册

### Task 12: AuthShellLayout + LoginPage 改左品牌右表单

**Files:**
- Modify: `apps/web-agent/src/components/layouts/auth-shell-layout.tsx`
- Modify: `apps/web-agent/src/app/login/page.tsx`

- [ ] **Step 1: AuthShellLayout 改为左右双栏（左品牌橙块，右内容 slot）**

重写 [auth-shell-layout.tsx](apps/web-agent/src/components/layouts/auth-shell-layout.tsx)：保留 `DragRegion`/语言/主题切换 actions、`auth-shell-mode` body class、`mounted` gate。把布局改为：

```tsx
<div className="relative flex min-h-screen overflow-hidden bg-background text-foreground">
  <DragRegion actions={/* 保留原 LanguageToggle + 主题按钮 */} />
  {/* 左品牌色块 */}
  <div className="relative hidden w-[44%] flex-col justify-between overflow-hidden bg-gradient-to-br from-[var(--shell-chrome)] to-[var(--shell-sidebar)] p-10 text-white lg:flex">
    <div className="flex items-center gap-2 text-[16px] font-extrabold">
      <span className="flex h-7 w-7 items-center justify-center rounded-[8px] bg-white text-[var(--shell-chrome)]">M</span>
      meshbot
    </div>
    <div>
      <div className="text-[28px] font-extrabold leading-snug">{brandTagline}</div>
      <div className="mt-3 text-sm text-white/85">{brandSubtitle}</div>
    </div>
    <div className="pointer-events-none absolute -right-12 -bottom-12 h-48 h-48 rounded-full border-[20px] border-white/10" />
  </div>
  {/* 右内容 */}
  <div className={cn("relative z-10 flex min-h-0 flex-1 items-center justify-center px-6", className)}>
    {mounted ? children : null}
  </div>
</div>
```

`brandTagline`/`brandSubtitle` 用 `useTranslations("login")` 取 `brandTagline`/`brandSubtitle`。小屏（`lg` 以下）左块隐藏，仅表单。

> 这会让 setup 页（也用 AuthShellLayout）自动获得同款品牌左栏，符合 spec「注册页风格同步」。

- [ ] **Step 2: LoginPage 表单去掉外框、贴合右栏**

[login/page.tsx](apps/web-agent/src/app/login/page.tsx)：把最外层 `<div className="w-full max-w-[430px] border border-border bg-card shadow-sm">` 改为 `<div className="w-full max-w-[380px]">`（右栏已是页面背景，无需卡片边框）。标题上方加一行欢迎语 `t("welcomeBack")`。「登录」按钮 className 由 `bg-primary` 改 `bg-[var(--shell-accent)] text-white hover:opacity-90`。其余表单字段/校验/`useLogin`/错误 Alert/去注册链接不动。

- [ ] **Step 3: 验证 + 目测**

Run: `pnpm --filter @meshbot/web-agent typecheck && pnpm biome check --write apps/web-agent/src/components/layouts/auth-shell-layout.tsx apps/web-agent/src/app/login/page.tsx`
Expected: `0 errors`
Run: `pnpm dev:web-agent`，访问 `/login`：左橙品牌块 + 右表单；缩窄窗口确认左块在小屏隐藏；填错触发错误 Alert；登录成功跳 `/assistant`。

- [ ] **Step 4: 提交**

```bash
git add apps/web-agent/src/components/layouts/auth-shell-layout.tsx apps/web-agent/src/app/login/page.tsx
git commit -m "feat(web-agent): 登录页改 Slack 风格（左品牌橙块 + 右表单），注册页同步"
```

### Task 13: setup 页表单适配新 AuthShell

**Files:**
- Modify: `apps/web-agent/src/app/setup/page.tsx`

- [ ] **Step 1: 收窄外层卡 + 主按钮配色对齐**

[setup/page.tsx](apps/web-agent/src/app/setup/page.tsx)：把外层 `<div className="w-full max-w-[500px]">` 保留或收窄到 `max-w-[420px]`；各步骤主行动按钮（创建账号/创建组织/保存并开始）配色由 `bg-primary` 改 `bg-[var(--shell-accent)] text-white hover:opacity-90`（与登录一致）。表单逻辑/步骤切换不动。

- [ ] **Step 2: 验证 + 目测 + 提交**

Run: `pnpm --filter @meshbot/web-agent typecheck && pnpm biome check --write apps/web-agent/src/app/setup/page.tsx`
Expected: `0 errors`
Run: `pnpm dev:web-agent`，访问 `/setup`：左品牌块 + 三步表单，按钮橙色，完成落地 `/assistant`。
```bash
git add apps/web-agent/src/app/setup/page.tsx
git commit -m "style(web-agent): setup 注册向导按钮配色对齐 Slack 橙 + 适配品牌左栏"
```

---

## Phase F — 收尾验证

### Task 14: 深色模式与全量回归

**Files:**
- 可能 Modify: `apps/web-agent/src/app/globals.css`（如目测发现暗色内容卡边界/滚动条需微调）

- [ ] **Step 1: 暗色目测**

Run: `pnpm dev:web-agent`，在 rail 用户菜单旁的主题按钮切到暗色，逐路由确认：橙色 chrome/侧栏保留、内容卡翻深、文字对比正常（会话消息、登录右栏、占位页）。如内容卡在暗色下与 chrome 边界不清，给 `<section>` 加 `dark:ring-1 dark:ring-white/5` 或在 globals.css 调 `--shell-content`。

- [ ] **Step 2: Electron 安全区目测（若有桌面壳）**

确认 mac 下顶部 traffic-light 不被 `ShellTopBar` 内容遮挡（`app-mac-controls-safe-left` 生效）；窗口可由顶栏拖动，按钮区不拖动。无桌面环境则跳过，记录待桌面验证。

- [ ] **Step 3: 全量静态围栏**

Run: `pnpm --filter @meshbot/web-agent typecheck`
Expected: `0 errors`
Run: `pnpm exec tsx scripts/sync-locales.ts -- --check`
Expected: `Done (missing=0, asymmetric=0)`
Run: `pnpm biome check apps/web-agent/src`
Expected: 无 error

- [ ] **Step 4: 检查死导出（旧首页 Home 等是否有遗留未用导出）**

Run: `pnpm check:dead`
Expected: 无新增死导出 finding（如有，删除遗留未用 export）。

- [ ] **Step 5: 提交任何收尾微调**

```bash
git add -A apps/web-agent
git commit -m "fix(web-agent): Slack UI 暗色模式与全量回归微调"
```

### Task 15: 自检清单核对（无代码，仅核对）

- [ ] 逐条对照 spec [2026-06-14-web-agent-slack-ui-design.md](docs/superpowers/specs/2026-06-14-web-agent-slack-ui-design.md) §3–§11：
  - rail 四区导航 + 选中态（图标方块高亮/文字无底）✔ Task 3/4
  - 顶部搜索栏 + 内嵌内容卡 + 橙包边 ✔ Task 5/8
  - 配色 #9a3412 / #d24a0d / 白 ✔ Task 1/8
  - 会话内容顶栏（标题 + 置顶星）✔ Task 9b
  - 助手 Slack 行式消息 + 工具块 + reasoning + 富文本输入 ✔ Task 10/10b/11
  - 助手默认视图承接统计/热力图 ✔ Task 9
  - 主页/消息/更多占位 ✔ Task 7/9
  - 组织移入用户菜单、定时入侧栏 ✔ Task 4/6
  - 登录左品牌右表单 + setup 同步 ✔ Task 12/13
  - 深色模式橙骨架保留、内容翻深 ✔ Task 1/14
  - 全程 i18n、无裸字符串 ✔ Task 2（执行时新组件文案均走 useTranslations）
- [ ] 确认无 `/` 旧首页死链、无 `router.push("/")` 落到占位页的遗漏。

---

## 风险与备注

- **时间戳**：当前 `TimelineMessage` 无 `createdAt`，Slack 行本期**只显示头像+名字、不显示时间戳**（mockup 中时间戳为装饰）。补时间戳需从 history API 透传 `createdAt`，列为后续增强。
- **全局搜索**：顶栏搜索框本期为 UI 占位，无搜索逻辑。
- **富文本工具栏**：装饰为主，输入仍为纯文本 contentEditable。
- **设置区侧栏**：`/settings/org` 本期用 `sidebar={null}` 占满内容卡；未来可做独立设置侧栏。
- **共享 design 系统未改**：所有圆角/配色为 web-agent 局部 CSS 变量，web-main 不受影响。
- **桌面端**：Electron 安全区逻辑保留；若无桌面环境，Task 14 Step 2 记录为待桌面回归项。
