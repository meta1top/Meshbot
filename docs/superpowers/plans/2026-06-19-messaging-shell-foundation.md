# 消息壳重构 · Plan 1：IA 与 Shell 地基 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把桌面端一级导航从 4 项（主页/消息/助手/更多）收敛为 2 项（消息/更多），用一个三段式（频道/私信/助手）统一侧栏取代原有两个侧栏，并把统计仪表盘迁到「更多」，全程保持 App 可用。

**Architecture:** 纯前端重构（`apps/web-agent`，Next.js App Router + Jotai）。保留「深色壳 + inset 圆角内容卡」既有 shell 结构与 `--shell-*` 配色。频道/私信沿用 `atoms/im.ts`，助手会话沿用 `atoms/sessions.ts`，统一侧栏只是组合层；路由保留 `/messages`（频道/私信）与 `/session`（助手会话）双轨，二者在 `areaFromPath` 中都归入 `messages` 区。本计划**不**含富文本输入升级、统一新消息、随手问面板（各自后续计划）。

**Tech Stack:** Next.js 16 App Router、React 19、Jotai 2、next-intl 4、Tailwind v4（CSS 变量代理 `bg-(--var)`）、lucide-react；测试用根 Jest（`testEnvironment: node`，`testMatch: **/?(*.)+(spec|test).ts`，roots 含 `apps`）跑纯逻辑 `.ts`。

## Global Constraints

- 目标包：仅 `apps/web-agent`，不改任何后端 / `libs/*` 业务逻辑。
- 国际化：所有用户可见字符串走 next-intl `useTranslations`，禁裸字符串；新增 key **同时**改 `apps/web-agent/messages/zh.json` 与 `apps/web-agent/messages/en.json`（遵循 `i18n-page` 规范）。
- 配色变量（`apps/web-agent/src/app/globals.css`）：`--shell-chrome:#241c15`、`--shell-sidebar:#342a20`、`--shell-content:#ffffff`、`--shell-accent:#d24a0d`、`--shell-radius:0.5rem`。沿用，**不引入新配色体系**。
- Tailwind 用法：`bg-(--shell-accent)`、`rounded-(--shell-radius)` 这类 CSS 变量代理写法。
- 视觉验收基准：`/Users/grant/Meta1/meshbot/.superpowers/brainstorm/90418-1781852822/content/01-shell-structure.html`（骨架）与 `04e-inset-cards.html`（外壳）。
- 提交信息中文、conventional commits 风格，结尾加 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
- 每个 Task 完成后跑 `pnpm --filter @meshbot/web-agent typecheck` 与 `pnpm lint`（Biome）必须过。

---

### Task 1: `areaFromPath` 收敛为 messages / more / other（纯逻辑 TDD）

把区域推断函数从 `workspace-rail.tsx` 抽到独立纯 `.ts` 文件并收敛映射：`/`、`/messages*`、`/session*`、`/assistant*`、`/schedule*` 全部归 `messages`；`/more*` 归 `more`；其余 `other`。这样消息与助手会话共用「消息」区与统一侧栏。

**Files:**
- Create: `apps/web-agent/src/lib/area-from-path.ts`
- Create: `apps/web-agent/src/lib/area-from-path.test.ts`
- Modify: `apps/web-agent/src/components/shell/workspace-rail.tsx`（删除内联 `areaFromPath`，改为 re-export）

**Interfaces:**
- Produces: `export type ShellArea = "messages" | "more" | "other";` 与 `export function areaFromPath(pathname: string): ShellArea;`
- Consumes: 无。

- [ ] **Step 1: 写失败测试**

`apps/web-agent/src/lib/area-from-path.test.ts`：

```ts
import { areaFromPath } from "./area-from-path";

describe("areaFromPath", () => {
  it("把 / 归入 messages（首页即消息）", () => {
    expect(areaFromPath("/")).toBe("messages");
  });

  it("把 /messages 及子路径归入 messages", () => {
    expect(areaFromPath("/messages")).toBe("messages");
    expect(areaFromPath("/messages?id=abc")).toBe("messages");
  });

  it("把助手相关路由 /session /assistant /schedule 归入 messages", () => {
    expect(areaFromPath("/session?id=x")).toBe("messages");
    expect(areaFromPath("/assistant")).toBe("messages");
    expect(areaFromPath("/schedule")).toBe("messages");
  });

  it("把 /more 归入 more", () => {
    expect(areaFromPath("/more")).toBe("more");
  });

  it("其它路由（如 /settings /login）归入 other", () => {
    expect(areaFromPath("/settings/org")).toBe("other");
    expect(areaFromPath("/login")).toBe("other");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test -- area-from-path`
Expected: FAIL —「Cannot find module './area-from-path'」。

- [ ] **Step 3: 写实现**

`apps/web-agent/src/lib/area-from-path.ts`：

```ts
/** Shell rail 当前区域。首页即消息；助手会话并入消息区。 */
export type ShellArea = "messages" | "more" | "other";

/** 由 pathname 推断当前 rail 区域。 */
export function areaFromPath(pathname: string): ShellArea {
  if (
    pathname === "/" ||
    pathname.startsWith("/messages") ||
    pathname.startsWith("/session") ||
    pathname.startsWith("/assistant") ||
    pathname.startsWith("/schedule")
  )
    return "messages";
  if (pathname.startsWith("/more")) return "more";
  return "other";
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test -- area-from-path`
Expected: PASS（5 个用例全绿）。

- [ ] **Step 5: 改 workspace-rail.tsx 改为 re-export**

把 `workspace-rail.tsx` 顶部原本的 `export function areaFromPath(...)`（行 29-43）整段删除，改为从新模块 re-export，保持现有 `import { areaFromPath, WorkspaceRail } from ".../workspace-rail"` 调用方不破：

在 import 区加：

```ts
import { areaFromPath } from "@/lib/area-from-path";
```

并在文件内（WorkspaceRail 定义之外）加一行 re-export：

```ts
export { areaFromPath } from "@/lib/area-from-path";
```

注意：`WorkspaceRail` 内部 `const area = areaFromPath(pathname);` 的返回类型现在是 `"messages" | "more" | "other"`，下一个 Task 会调整 rail 项的 active 判定，本 Task 暂时保留（`area === "home"` 等比较会因联合类型收窄报 TS 错——所以本 Task 与 Task 2 同属一次提交，见 Step 6）。

- [ ] **Step 6: typecheck + lint + 提交（与 Task 2 合并提交，先不单独 commit）**

本 Task 改 rail 后类型暂不自洽，**不单独提交**；继续 Task 2 完成 rail 收敛后一起 typecheck 并提交。先只确认测试绿：

Run: `pnpm test -- area-from-path`
Expected: PASS。

---

### Task 2: 导航 rail 收敛为 消息 + 更多

删除「主页」「助手」两个一级项，保留「消息」「更多」。点「消息」去 `/messages`。

**Files:**
- Modify: `apps/web-agent/src/components/shell/workspace-rail.tsx`（行 68-93 的 `<nav>`）

**Interfaces:**
- Consumes: `areaFromPath`（Task 1）、`RailNavItem`（props: `{icon, label, active?, onClick?}`，已存在）。

- [ ] **Step 1: 改 nav 区只留两项**

把 `workspace-rail.tsx` 的 `<nav>...</nav>`（行 68-93，含 Home/Messages/Assistant/More 四项）整体替换为：

```tsx
      <nav className="mt-1 flex w-full flex-col gap-1">
        <RailNavItem
          icon={<MessageSquare className="h-5 w-5" />}
          label={t("rail.messages")}
          active={area === "messages"}
          onClick={() => router.push("/messages")}
        />
        <RailNavItem
          icon={<MoreHorizontal className="h-5 w-5" />}
          label={t("rail.more")}
          active={area === "more"}
          onClick={() => router.push("/more")}
        />
      </nav>
```

- [ ] **Step 2: 清理未用 import**

`workspace-rail.tsx` 顶部 lucide-react import：删除现在不再使用的 `Home`、`Sparkles`。保留 `MessageSquare`、`MoreHorizontal`、`Moon`、`Sun`、`Building2`。

Run: `pnpm clean:imports`（Biome 自动移除未用 import），随后人工确认 `Home`/`Sparkles` 已移除。

- [ ] **Step 3: typecheck**

Run: `pnpm --filter @meshbot/web-agent typecheck`
Expected: 通过（`area === "home"`/`"assistant"` 的比较已随四项删除而消失，联合类型自洽）。

- [ ] **Step 4: lint**

Run: `pnpm lint`
Expected: 通过。

- [ ] **Step 5: 视觉确认**

启动 `pnpm dev:web-agent`，打开 http://localhost:3001 ，确认左侧 rail 只剩「消息 / 更多」两项，底部主题切换 + 头像菜单不变。对照 mockup `01-shell-structure.html`。

- [ ] **Step 6: 提交（含 Task 1）**

```bash
git add apps/web-agent/src/lib/area-from-path.ts apps/web-agent/src/lib/area-from-path.test.ts apps/web-agent/src/components/shell/workspace-rail.tsx
git commit -m "feat(web-agent): 一级导航收敛为 消息+更多，areaFromPath 抽离并归并助手区

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: 可复用 SidebarSection（可折叠分段）

抽一个统一的分段容器：分段头（折叠 chevron + 标题 + 可选「+」按钮）+ 折叠态切换 + 子内容。供统一侧栏的频道/私信/助手三段共用。

**Files:**
- Create: `apps/web-agent/src/components/shell/sidebar-section.tsx`

**Interfaces:**
- Produces:
  ```ts
  interface SidebarSectionProps {
    title: string;
    children: React.ReactNode;
    /** 提供时分段头右侧显示「+」按钮 */
    onAdd?: () => void;
    addLabel?: string;
    /** 默认展开 */
    defaultOpen?: boolean;
  }
  export function SidebarSection(props: SidebarSectionProps): JSX.Element;
  ```
- Consumes: lucide-react `ChevronDown`、`Plus`。

- [ ] **Step 1: 写组件**

`apps/web-agent/src/components/shell/sidebar-section.tsx`：

```tsx
"use client";

import { cn } from "@meshbot/design";
import { ChevronDown, Plus } from "lucide-react";
import { useState } from "react";

interface SidebarSectionProps {
  title: string;
  children: React.ReactNode;
  /** 提供时分段头右侧显示「+」按钮 */
  onAdd?: () => void;
  addLabel?: string;
  /** 默认展开 */
  defaultOpen?: boolean;
}

/**
 * 统一侧栏的可折叠分段：分段头（折叠箭头 + 标题 + 可选「+」）+ 子内容。
 * 频道 / 私信 / 助手三段共用。
 */
export function SidebarSection({
  title,
  children,
  onAdd,
  addLabel,
  defaultOpen = true,
}: SidebarSectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="mb-1.5">
      <div className="group flex h-6 items-center gap-1 px-2 text-[11px] font-semibold tracking-wide text-white/50">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1 transition-colors hover:text-white/75"
        >
          <ChevronDown
            className={cn(
              "h-3 w-3 transition-transform",
              open ? "" : "-rotate-90",
            )}
          />
          <span>{title}</span>
        </button>
        {onAdd && (
          <button
            type="button"
            onClick={onAdd}
            title={addLabel}
            className="ml-auto opacity-0 transition-opacity hover:text-white/80 group-hover:opacity-100"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {open && <div className="mt-0.5 space-y-0.5">{children}</div>}
    </div>
  );
}
```

- [ ] **Step 2: typecheck + lint**

Run: `pnpm --filter @meshbot/web-agent typecheck && pnpm lint`
Expected: 通过。

- [ ] **Step 3: 提交**

```bash
git add apps/web-agent/src/components/shell/sidebar-section.tsx
git commit -m "feat(web-agent): 新增可折叠 SidebarSection 分段容器

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: 统一 MessagesSidebar（频道 / 私信 / 助手 三段）

新建统一侧栏，组合：频道、私信（`atoms/im.ts`）+ 助手会话（`atoms/sessions.ts`）。复用 `SidebarSection`、`SessionListItem`。头部「消息」标题 + 「✎ 新消息」入口（本计划仅占位 onClick，统一新消息在后续计划）。助手段底部放「定时任务」入口。频道/私信行复用 `im-sidebar.tsx` 的现有渲染语义（`#`/`🔒` 图标、presence 绿点、未读 badge）。

**Files:**
- Create: `apps/web-agent/src/components/shell/messages-sidebar.tsx`
- Modify: `apps/web-agent/messages/zh.json`、`apps/web-agent/messages/en.json`（新增 `messagesSidebar` 命名空间）

**Interfaces:**
- Consumes:
  - `conversationsAtom: ConversationSummary[]`、`currentConversationIdAtom`、`presenceAtom`、`loadConversationsAtom`（`atoms/im.ts`）。`ConversationSummary` 字段：`{id, type:"channel"|"dm", visibility:"public"|"private", name:string|null, peer:{userId,displayName}|null, unreadCount, lastMessage}`。
  - `pinnedSessionsAtom`、`recentSessionsAtom`、`sessionsStatusAtom`、`loadSessionsAtom`（`atoms/sessions.ts`）。
  - `SessionListItem`（props `{session: SessionSummary}`）。
  - `SidebarSection`（Task 3）。
- Produces: `export function MessagesSidebar(): JSX.Element;`

- [ ] **Step 1: 加 i18n key**

`apps/web-agent/messages/zh.json` 顶层加命名空间：

```json
"messagesSidebar": {
  "title": "消息",
  "newMessage": "新消息",
  "channels": "频道",
  "directMessages": "私信",
  "assistant": "助手",
  "scheduled": "定时任务",
  "assistantEmpty": "暂无会话",
  "loadFailed": "加载失败",
  "retry": "重试"
}
```

`apps/web-agent/messages/en.json` 同步加：

```json
"messagesSidebar": {
  "title": "Messages",
  "newMessage": "New message",
  "channels": "Channels",
  "directMessages": "Direct messages",
  "assistant": "Assistant",
  "scheduled": "Scheduled",
  "assistantEmpty": "No conversations",
  "loadFailed": "Failed to load",
  "retry": "Retry"
}
```

- [ ] **Step 2: 写 MessagesSidebar**

`apps/web-agent/src/components/shell/messages-sidebar.tsx`：

```tsx
"use client";

import { cn } from "@meshbot/design";
import { useAtomValue, useSetAtom } from "jotai";
import { Clock, Hash, Lock, SquarePen } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import {
  conversationsAtom,
  currentConversationIdAtom,
  loadConversationsAtom,
  presenceAtom,
} from "@/atoms/im";
import {
  loadSessionsAtom,
  pinnedSessionsAtom,
  recentSessionsAtom,
  sessionsStatusAtom,
} from "@/atoms/sessions";
import { SessionListItem } from "@/components/sidebar/session-list-item";
import { SidebarSection } from "@/components/shell/sidebar-section";

/**
 * 统一消息侧栏：频道 / 私信 / 助手三段。频道+私信来自 IM atom，
 * 助手来自 session atom。点击频道/私信→/messages?id=，助手→/session?id=。
 */
export function MessagesSidebar() {
  const t = useTranslations("messagesSidebar");
  const router = useRouter();
  const pathname = usePathname();

  const conversations = useAtomValue(conversationsAtom);
  const currentConvId = useAtomValue(currentConversationIdAtom);
  const presence = useAtomValue(presenceAtom);
  const loadConversations = useSetAtom(loadConversationsAtom);

  const pinned = useAtomValue(pinnedSessionsAtom);
  const recent = useAtomValue(recentSessionsAtom);
  const sessionsStatus = useAtomValue(sessionsStatusAtom);
  const loadSessions = useSetAtom(loadSessionsAtom);

  useEffect(() => {
    void loadConversations();
    void loadSessions();
  }, [loadConversations, loadSessions]);

  const channels = conversations.filter((c) => c.type === "channel");
  const dms = conversations.filter((c) => c.type === "dm");
  const assistantSessions = [...pinned, ...recent];

  const rowBase =
    "flex h-7 w-full items-center gap-2 rounded-md px-2 text-[13px] transition-colors";

  return (
    <div className="flex h-full flex-col bg-(--shell-sidebar) text-white">
      {/* Header */}
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-white/15 px-3.5">
        <span className="text-[15px] font-extrabold">{t("title")}</span>
        <button
          type="button"
          title={t("newMessage")}
          onClick={() => router.push("/messages/new")}
          className="flex h-7 w-7 items-center justify-center rounded-md text-white/70 transition-colors hover:bg-white/10 hover:text-white"
        >
          <SquarePen className="h-4 w-4" />
        </button>
      </div>

      {/* Body */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 py-2">
        {/* 频道 */}
        <SidebarSection title={t("channels")}>
          {channels.map((c) => {
            const active = c.id === currentConvId;
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => router.push(`/messages?id=${c.id}`)}
                className={cn(
                  rowBase,
                  active
                    ? "bg-(--shell-accent) text-white"
                    : "text-white/80 hover:bg-white/12",
                )}
              >
                {c.visibility === "private" ? (
                  <Lock className="h-3.5 w-3.5 shrink-0 opacity-70" />
                ) : (
                  <Hash className="h-3.5 w-3.5 shrink-0 opacity-70" />
                )}
                <span className="min-w-0 flex-1 truncate text-left">
                  {c.name}
                </span>
                {c.unreadCount > 0 && (
                  <span className="shrink-0 rounded-full bg-(--shell-accent) px-1.5 py-0.5 text-[10px] font-bold leading-none">
                    {c.unreadCount > 99 ? "99+" : c.unreadCount}
                  </span>
                )}
              </button>
            );
          })}
        </SidebarSection>

        {/* 私信 */}
        <SidebarSection title={t("directMessages")}>
          {dms.map((c) => {
            const active = c.id === currentConvId;
            const peerId = c.peer?.userId ?? "";
            const online = peerId !== "" && (presence[peerId] ?? false);
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => router.push(`/messages?id=${c.id}`)}
                className={cn(
                  rowBase,
                  active
                    ? "bg-(--shell-accent) text-white"
                    : "text-white/80 hover:bg-white/12",
                )}
              >
                <span
                  className={cn(
                    "h-2 w-2 shrink-0 rounded-full",
                    online ? "bg-green-400" : "bg-white/30",
                  )}
                />
                <span className="min-w-0 flex-1 truncate text-left">
                  {c.peer?.displayName ?? ""}
                </span>
                {c.unreadCount > 0 && (
                  <span className="shrink-0 rounded-full bg-(--shell-accent) px-1.5 py-0.5 text-[10px] font-bold leading-none">
                    {c.unreadCount > 99 ? "99+" : c.unreadCount}
                  </span>
                )}
              </button>
            );
          })}
        </SidebarSection>

        {/* 助手 */}
        <SidebarSection title={t("assistant")}>
          {sessionsStatus === "error" ? (
            <div className="px-2 py-1 text-[12px] text-white/55">
              {t("loadFailed")}
            </div>
          ) : assistantSessions.length === 0 && sessionsStatus === "loaded" ? (
            <div className="px-2 py-1 text-[12px] text-white/55">
              {t("assistantEmpty")}
            </div>
          ) : (
            assistantSessions.map((s) => (
              <SessionListItem key={s.id} session={s} />
            ))
          )}
        </SidebarSection>
      </div>

      {/* 助手区底部：定时任务入口 */}
      <button
        type="button"
        onClick={() => router.push("/schedule")}
        className={cn(
          "mx-2 mt-1 mb-2.5 flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] transition-colors",
          pathname.startsWith("/schedule")
            ? "bg-(--shell-accent) text-white"
            : "text-white/75 hover:bg-white/12",
        )}
      >
        <Clock className="h-4 w-4" />
        {t("scheduled")}
      </button>
    </div>
  );
}
```

> 备注：`/messages/new`（统一新消息路由）与「✎」当前仅占位跳转，对应页面在后续「统一新消息」计划创建；本计划只需保证 `router.push` 不报错（Next.js 对未知路由会 404，但不影响编译与本 Task 验收，后续计划补页面）。如担心 404 干扰联调，可临时改为 `onClick={() => {}}`，并在后续计划接回。

- [ ] **Step 3: typecheck + lint**

Run: `pnpm --filter @meshbot/web-agent typecheck && pnpm lint`
Expected: 通过。`SessionListItem` 内部已自带「激活态」判定（匹配 `/session?id=`），无需额外传参。

- [ ] **Step 4: 提交**

```bash
git add apps/web-agent/src/components/shell/messages-sidebar.tsx apps/web-agent/messages/zh.json apps/web-agent/messages/en.json
git commit -m "feat(web-agent): 新增统一 MessagesSidebar（频道/私信/助手三段）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: AppShellLayout 接入统一侧栏 + 收敛区域分支

把 messages 区的自动侧栏换成 `MessagesSidebar`；删除 assistant / home 分支（这两个区已不存在）；移除对 `ImSidebar`、`AssistantSidebar` 的 import。

**Files:**
- Modify: `apps/web-agent/src/components/layouts/app-shell-layout.tsx`（行 8-12 imports、行 50-60 autoSidebar）

**Interfaces:**
- Consumes: `MessagesSidebar`（Task 4）、`PlaceholderSidebar`（props `{title}`）、`areaFromPath`（Task 1）。

- [ ] **Step 1: 改 import**

`app-shell-layout.tsx` 顶部，把：

```ts
import { ImSidebar } from "@/components/im/im-sidebar";
import { AssistantSidebar } from "@/components/shell/assistant-sidebar";
import { PlaceholderSidebar } from "@/components/shell/placeholder-sidebar";
import { ShellTopBar } from "@/components/shell/shell-top-bar";
import { areaFromPath, WorkspaceRail } from "@/components/shell/workspace-rail";
```

替换为：

```ts
import { MessagesSidebar } from "@/components/shell/messages-sidebar";
import { PlaceholderSidebar } from "@/components/shell/placeholder-sidebar";
import { ShellTopBar } from "@/components/shell/shell-top-bar";
import { WorkspaceRail } from "@/components/shell/workspace-rail";
import { areaFromPath } from "@/lib/area-from-path";
```

- [ ] **Step 2: 改 autoSidebar 分支**

把 `app-shell-layout.tsx` 行 50-59 的 `autoSidebar` 三元链：

```tsx
  const autoSidebar =
    area === "assistant" ? (
      <AssistantSidebar />
    ) : area === "messages" ? (
      <ImSidebar />
    ) : area === "more" ? (
      <PlaceholderSidebar title={t("rail.more")} />
    ) : area === "home" ? (
      <PlaceholderSidebar title={t("rail.home")} />
    ) : null;
```

替换为：

```tsx
  const autoSidebar =
    area === "messages" ? (
      <MessagesSidebar />
    ) : area === "more" ? (
      <PlaceholderSidebar title={t("rail.more")} />
    ) : null;
```

- [ ] **Step 3: typecheck + lint**

Run: `pnpm --filter @meshbot/web-agent typecheck && pnpm lint`
Expected: 通过（`t` 仍用于 `rail.more`，保留；`area === "home"/"assistant"` 分支已删）。

- [ ] **Step 4: 视觉确认**

`pnpm dev:web-agent`，访问 `/messages`、`/session?id=<任一会话>`：两者都应显示同一个三段侧栏（频道/私信/助手），rail「消息」高亮。对照 mockup `01-shell-structure.html` 与 `04e-inset-cards.html`。

- [ ] **Step 5: 提交**

```bash
git add apps/web-agent/src/components/layouts/app-shell-layout.tsx
git commit -m "feat(web-agent): AppShellLayout 接入统一侧栏并收敛区域分支

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: 路由收敛 + 统计仪表盘迁「更多」+ 移除旧伴生面板

`/` 重定向到 `/messages`；把 `/assistant` 的统计仪表盘（metrics + ActivityHeatmap + `fetchStats`）迁到 `/more`；`/assistant` 仅保留「随手问起点」（标题 + 建议 chips + 输入框）；移除 `/messages` 的旧 IM 伴生面板（不再传 `rightPanel`）。

**Files:**
- Modify: `apps/web-agent/src/app/page.tsx`（首页改重定向）
- Modify: `apps/web-agent/src/app/more/page.tsx`（渲染仪表盘）
- Modify: `apps/web-agent/src/app/assistant/page.tsx`（移除统计块，仅留输入起点）
- Modify: `apps/web-agent/src/app/messages/page.tsx`（删除 `rightPanel={<ImCompanionPanel .../>}` 传参与相关引用）

**Interfaces:**
- Consumes: `redirect`（`next/navigation`）、`fetchStats`/`ActivityHeatmap`/`SuggestionChips`（已存在）、`assistant` i18n 命名空间（已存在 metrics keys）。

- [ ] **Step 1: 首页重定向**

`apps/web-agent/src/app/page.tsx` 整体替换为：

```tsx
import { redirect } from "next/navigation";

/** 首页即消息：重定向到消息中心。 */
export default function HomePage() {
  redirect("/messages");
}
```

- [ ] **Step 2: 把统计仪表盘搬到 /more**

打开 `apps/web-agent/src/app/assistant/page.tsx`，把其中「统计卡」JSX 块（`<Card>` 含 Range 按钮 + 8 指标 grid + `<ActivityHeatmap>`，对应探查报告 C.3 的统计区）连同 `range`/`stats`/`fetchStats`/`metrics`/`RANGES` 相关 state 与 import，整段迁移到 `apps/web-agent/src/app/more/page.tsx`。`/more/page.tsx` 替换为：

```tsx
"use client";

import { Card, CardContent, CardHeader } from "@meshbot/design";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { AppShellLayout } from "@/components/layouts/app-shell-layout";
import { ActivityHeatmap } from "@/components/common/activity-heatmap";
import { formatPeakHour, formatStreak, formatTokens } from "@/lib/format-tokens";
import { fetchStats, type StatsRange, type StatsResponse } from "@/rest/stats";

const RANGES: StatsRange[] = ["all", "30d", "7d"];

/** 「更多」→ 使用情况：会话/消息/Token/活跃度统计（原助手仪表盘迁来）。 */
export default function MorePage() {
  const t = useTranslations("assistant");
  const [range, setRange] = useState<StatsRange>("all");
  const [stats, setStats] = useState<StatsResponse | null>(null);

  useEffect(() => {
    void fetchStats(range).then((s) => setStats(s));
  }, [range]);

  const metrics = [
    { label: t("metrics.sessions"), value: String(stats?.sessions ?? 0) },
    { label: t("metrics.messages"), value: String(stats?.messages ?? 0) },
    { label: t("metrics.totalTokens"), value: formatTokens(stats?.totalTokens ?? 0) },
    { label: t("metrics.activeDays"), value: String(stats?.activeDays ?? 0) },
    { label: t("metrics.currentStreak"), value: formatStreak(stats?.currentStreak ?? 0) },
    { label: t("metrics.longestStreak"), value: formatStreak(stats?.longestStreak ?? 0) },
    { label: t("metrics.peakHour"), value: formatPeakHour(stats?.peakHour ?? null) },
    { label: t("metrics.favoriteModel"), value: stats?.favoriteModel ?? "—" },
  ];

  return (
    <AppShellLayout>
      <div className="mx-auto w-full max-w-[620px] flex-1 py-6">
        <Card className="overflow-hidden border-border bg-muted px-1 py-1 shadow-none">
          <CardHeader>
            <div className="flex items-center justify-end gap-1 text-[11px]">
              {RANGES.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setRange(r)}
                  className={
                    r === range
                      ? "rounded-md bg-foreground/8 px-1.5 py-0.5 font-medium"
                      : "px-1.5 py-0.5 text-muted-foreground"
                  }
                >
                  {r === "all" ? t("all") : r}
                </button>
              ))}
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-4 gap-x-3 gap-y-2">
              {metrics.map((item) => (
                <div key={item.label}>
                  <p className="text-[11px] text-foreground/55">{item.label}</p>
                  <p className="text-[18px] font-semibold">{item.value}</p>
                </div>
              ))}
            </div>
            <ActivityHeatmap cells={stats?.heatmap ?? []} weeks={26} />
          </CardContent>
        </Card>
      </div>
    </AppShellLayout>
  );
}
```

> 注：上面 import 的具体名（`formatPeakHour`/`formatStreak`、`StatsRange`/`StatsResponse`、`Card`/`CardHeader`/`CardContent`）需与 `assistant/page.tsx` 原本使用的完全一致；以原文件 import 为准照搬。

- [ ] **Step 3: 精简 /assistant 为随手问起点**

把 `apps/web-agent/src/app/assistant/page.tsx` 里 Step 2 迁走的统计 `<Card>` 块删除，保留：Logo + 随机标题、底部粘底的 `<SuggestionChips>` + `<ChatInput>`（创建会话→`/session?id=`）。删掉 `range`/`stats`/`metrics`/`RANGES`/`fetchStats` 等仅服务统计的 state 与 import（`pnpm clean:imports` 辅助）。

- [ ] **Step 4: 移除旧 IM 伴生面板**

`apps/web-agent/src/app/messages/page.tsx`：删除传给 `<AppShellLayout>` 的 `rightPanel={ id ? <ImCompanionPanel ... /> : undefined }` 整个 prop，以及对应的 `ImCompanionPanel` import 和 `useCandidate`/`onUseCandidate` 相关逻辑（若 `useCandidate` 仅服务伴生面板则一并删除）。保留 `header`、`children`、`scrollContainerRef`、`ChatInput`。

- [ ] **Step 5: typecheck + lint**

Run: `pnpm --filter @meshbot/web-agent typecheck && pnpm lint`
Expected: 通过。

- [ ] **Step 6: 视觉确认**

`pnpm dev:web-agent`：① 访问 `/` 自动跳 `/messages`；② `/more` 显示统计仪表盘；③ `/assistant` 只剩输入起点（无统计）；④ `/messages?id=<会话>` 右侧不再有伴生面板。

- [ ] **Step 7: 提交**

```bash
git add apps/web-agent/src/app/page.tsx apps/web-agent/src/app/more/page.tsx apps/web-agent/src/app/assistant/page.tsx apps/web-agent/src/app/messages/page.tsx
git commit -m "feat(web-agent): 首页重定向消息、统计迁更多、移除旧 IM 伴生面板

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: 清理旧侧栏与伴生面板组件 + 全量围栏

删除已无引用的 `im-sidebar.tsx`、`assistant-sidebar.tsx`、`im-companion-panel.tsx`，跑死导出围栏与全量校验。

**Files:**
- Delete: `apps/web-agent/src/components/im/im-sidebar.tsx`
- Delete: `apps/web-agent/src/components/shell/assistant-sidebar.tsx`
- Delete: `apps/web-agent/src/components/im/im-companion-panel.tsx`

**Interfaces:** 无新增。

- [ ] **Step 1: 确认无残留引用**

Run: `cd /Users/grant/Meta1/meshbot && grep -rn "im-sidebar\|assistant-sidebar\|im-companion-panel\|ImSidebar\|AssistantSidebar\|ImCompanionPanel" apps/web-agent/src`
Expected: 无输出（全部引用已在 Task 5/6 移除）。若有，回到对应 Task 清理。

- [ ] **Step 2: 删除文件**

```bash
git rm apps/web-agent/src/components/im/im-sidebar.tsx \
       apps/web-agent/src/components/shell/assistant-sidebar.tsx \
       apps/web-agent/src/components/im/im-companion-panel.tsx
```

- [ ] **Step 3: 死导出 + 类型 + lint + 测试**

Run: `pnpm --filter @meshbot/web-agent typecheck`
Expected: 通过。

Run: `pnpm check:dead`
Expected: 无新增死导出 finding（`SessionListSection` 若因 assistant-sidebar 删除而变孤儿，需判断：它仍被本计划保留吗？本计划 MessagesSidebar 直接用 `SessionListItem`，未用 `SessionListSection`——若 `session-list-section.tsx` 自此无引用，一并 `git rm` 并重跑）。

Run: `pnpm lint && pnpm test -- area-from-path`
Expected: 全过。

- [ ] **Step 4: 提交**

```bash
git add -A
git commit -m "chore(web-agent): 删除被取代的旧侧栏与 IM 伴生面板组件

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 后续计划（独立成篇，本计划不含）

1. **共享富文本输入升级** —— `chat-input.tsx` 工具条改为可用（选区插 markdown）；自适应高度已具备只需校准；附件入口 UI。
2. **附件全栈（独立项目）** —— 需后端：消息 `attachments` 字段 + 上传端点 + 对象存储 + 历史链路适配。当前**零基建**，spec 限定前端，故拆出。
3. **统一「新消息」** —— `/messages/new` 视图 + 「至：」单框分组（频道/成员/助手）。
4. **随手问全局面板** —— 顶栏 ✦ 开关 + shell 级右侧 peer 卡（`AppShellLayout` 增 `assistantDock` 槽，渲染为带深色缝的独立圆角卡）+ 「保存到助手」沉淀（Session 加 `kind="quick"` 或 `in_sidebar` 列 + SQLite/TypeORM 迁移，`listSessions` 过滤）。
5. **对话区精修** —— 消息分组、悬停操作条、表情回应、日期分隔（IM 与会话两条渲染线）。

## Self-Review（对照 spec）

- **覆盖**：spec 需求 3（导航收敛 消息+更多、首页即消息）→ Task 1/2/6；需求 4（三段侧栏）→ Task 3/4/5；仪表盘迁更多 → Task 6；移除旧伴生面板 → Task 6/7。需求 1（列表精修）部分体现在统一侧栏密度，对话区精修留后续计划；需求 2（随手问）、需求 5（统一新消息）、富文本/附件均明确拆入后续计划（见上）。
- **占位符扫描**：无 TBD/TODO；`/messages/new` 与 ✎ 的占位跳转已显式标注并给出临时降级方案。
- **类型一致**：`areaFromPath` 返回 `"messages"|"more"|"other"` 全程一致；`ConversationSummary`/`SessionSummary` 字段名与探查报告一致（`peer.displayName`、`visibility`、`unreadCount`、`pinned`）。
- **风险**：`SessionListSection` 是否成孤儿在 Task 7 Step 3 显式处理；`/assistant` 精简后若 `fetchStats` 等仍被引用由 `clean:imports` + typecheck 兜底。
