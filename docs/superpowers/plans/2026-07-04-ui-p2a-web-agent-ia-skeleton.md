# UI 重构 P2a:web-agent IA 骨架 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 web-agent 的信息架构从"消息一栏揉助手三段"重排为 spec 的六项一级导航 + 助手/消息拆成两个独立区,并补齐流程(留位)与设置(hub)。

**Architecture:** 四步:①`areaFromPath` 扩到 6 区 + `WorkspaceRail` 6 项 + i18n + 首页重定向;②新增 `/assistant` 区(独立路由 + `AssistantSidebar` 单一"本机"分组 + `SessionListItem` 路由改指 `/assistant`);③`/messages` 区瘦身为私聊+频道(移除助手段);④`/flows` 留位空态 + 「更多」区更名为「设置」。全部沿用现有壳组件(`PageShell`/`SidebarSection`/`SidebarNavItem`/`RailNavItem`/`SessionListItem`/`AssistantConversationBody`/`SessionHeader`)与 atom(`sessionsAtom`/`conversationsAtom`/`loadSidebarAtom`),不动数据层与传输层。

**Tech Stack:** Next.js 16.2.4(App Router,静态导出,`useSearchParams` 需 `Suspense`)· React 19 · jotai 2 · next-intl 4 · lucide-react 0.468 · Tailwind v4。

## Global Constraints

- **一级菜单顺序固定**:助手 · 消息 · 技能 · 网盘 · 流程 · 设置(rail 从上到下),底部主题切换 + 用户头像。
- **助手 vs 消息 边界**:助手区=本机设备 Agent 的会话(`sessionsAtom`,`SessionListItem`);消息区=人际 IM 私聊(dm)+频道(channel)。**"群"暂缓**——数据模型 `ConversationSummary.type` 仅 `channel`/`dm`,无群类型,留位待后端。**私聊自己设备 Agent 归助手区**。
- **助手不做跨设备分组**:web-agent 本地会话无设备信息,助手二级用**单一"本机"分组**(平铺 `sessionsAtom`),跨设备分组待云端(后续)。
- **设置=本地 hub**:纳入现有「使用情况」(`/more`)+「定时任务」(`/schedule`);账号/组织/登出保持在 rail 头像菜单,主题切换保持 rail 底部。**保留 `/more`、`/schedule` 路由不迁移**(仅归入设置区、更名侧栏),降低风险。
- **流程=D 留位**:`/flows` 纯空态占位,不接后端。
- **视觉沿用 P1 token**:`bg-(--shell-accent)`(=`var(--brand)` 焦橙)、`--shell-sidebar`、`--shell-radius` 等;不改配色。
- **验证方式**:前端无单测 runner;纯函数(`areaFromPath`)走 node-jest 单测(`apps/web-agent/src/**/*.spec.ts`,仅纯 TS,`@/` 别名已在根 jest `moduleNameMapper`),其余走 `typecheck` + `next build` + `pnpm check` + 人工视觉冒烟。
- **i18n**:新增 `t()` key 必须同步补 `apps/web-agent/messages/{zh,en}.json`,使 pre-commit `sync-locales --check` 保持 `missing=0`。
- **工程纪律**:禁止 `--no-verify`;中文 conventional commits + `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`;分支 `feat/unified-ui-redesign`。

## 依赖与命令
- 包名 `@meshbot/web-agent`(dev 3001)。typecheck:`pnpm --filter @meshbot/web-agent typecheck`。构建:`pnpm --filter @meshbot/web-agent build`(timeout 600000)。纯函数单测:`pnpm jest apps/web-agent/src/lib/area-from-path.spec.ts`。冒烟:`pnpm dev:web-agent`。

---

## File Structure

| 文件 | 改动 | 职责 |
|------|------|------|
| `apps/web-agent/src/lib/area-from-path.ts` | 改 | `ShellArea` 扩为 6 区 + 映射 |
| `apps/web-agent/src/lib/area-from-path.spec.ts` | 建 | `areaFromPath` 纯函数单测(node-jest) |
| `apps/web-agent/src/components/shell/workspace-rail.tsx` | 改 | rail 6 项 + 图标 + 路由 |
| `apps/web-agent/src/app/page.tsx` | 改 | 首页重定向 `/messages` → `/assistant` |
| `apps/web-agent/src/app/(shell)/assistant/page.tsx` | 建 | 助手区页(PageShell + AssistantSidebar + 会话) |
| `apps/web-agent/src/components/shell/assistant-sidebar.tsx` | 建 | 助手二级:单一"本机"分组列会话 |
| `apps/web-agent/src/components/sidebar/session-list-item.tsx` | 改 | 路由/激活态从 `/messages?kind=assistant` 改指 `/assistant?id=` |
| `apps/web-agent/src/app/session/page.tsx` | 改 | 旧链接兼容跳板改指 `/assistant` |
| `apps/web-agent/src/components/shell/messages-sidebar.tsx` | 改 | 移除助手段,仅私聊+频道 |
| `apps/web-agent/src/app/(shell)/messages/page.tsx` | 改 | 移除 `kind=assistant` 分支;旧 assistant 链接重定向到 `/assistant` |
| `apps/web-agent/src/app/(shell)/flows/page.tsx` | 建 | 流程留位空态 |
| `apps/web-agent/src/components/shell/more-sidebar.tsx` | 改 | 更名「设置」侧栏(标题 + 文案) |
| `apps/web-agent/messages/zh.json`、`en.json` | 改 | 新增 rail.flows/settings、assistantSidebar.*、flows.*、settingsSidebar.* |

---

## Task 1:areaFromPath 六区 + rail 6 项 + 首页重定向

把 rail 区域从 4 区扩到 6 区(纯函数,先 TDD),重排 `WorkspaceRail` 为六项,首页默认落到助手区。

**Files:**
- Modify: `apps/web-agent/src/lib/area-from-path.ts`
- Test: `apps/web-agent/src/lib/area-from-path.spec.ts`(新建)
- Modify: `apps/web-agent/src/components/shell/workspace-rail.tsx`
- Modify: `apps/web-agent/src/app/page.tsx`
- Modify: `apps/web-agent/messages/zh.json`、`apps/web-agent/messages/en.json`

**Interfaces:**
- Produces:`type ShellArea = "assistant" | "messages" | "skills" | "drive" | "flows" | "settings" | "other"`;`areaFromPath(pathname: string): ShellArea`。

- [ ] **Step 1:写失败单测** — 新建 `apps/web-agent/src/lib/area-from-path.spec.ts`:

```ts
import { areaFromPath } from "./area-from-path";

describe("areaFromPath", () => {
  it("根路径归助手区", () => {
    expect(areaFromPath("/")).toBe("assistant");
  });
  it("/assistant 与旧 /session 归助手区", () => {
    expect(areaFromPath("/assistant")).toBe("assistant");
    expect(areaFromPath("/session")).toBe("assistant");
  });
  it("/messages 归消息区", () => {
    expect(areaFromPath("/messages")).toBe("messages");
  });
  it("/skills、/drive 各归本区", () => {
    expect(areaFromPath("/skills")).toBe("skills");
    expect(areaFromPath("/drive")).toBe("drive");
  });
  it("/flows 归流程区", () => {
    expect(areaFromPath("/flows")).toBe("flows");
  });
  it("/more 与 /schedule 归设置区", () => {
    expect(areaFromPath("/more")).toBe("settings");
    expect(areaFromPath("/schedule")).toBe("settings");
  });
  it("未知路径归 other", () => {
    expect(areaFromPath("/nope")).toBe("other");
  });
});
```

- [ ] **Step 2:跑测确认失败**

Run:`pnpm jest apps/web-agent/src/lib/area-from-path.spec.ts`
Expected:FAIL(现 `areaFromPath("/")` 返回 `"messages"`,类型也无 `assistant`/`flows`/`settings`)。

- [ ] **Step 3:重写 `area-from-path.ts`**

整体替换 `apps/web-agent/src/lib/area-from-path.ts` 为:

```ts
/** Shell rail 当前区域(六项一级导航 + other)。 */
export type ShellArea =
  | "assistant"
  | "messages"
  | "skills"
  | "drive"
  | "flows"
  | "settings"
  | "other";

/** 由 pathname 推断当前 rail 区域。首页归助手区;/more、/schedule 归设置区。 */
export function areaFromPath(pathname: string): ShellArea {
  if (
    pathname === "/" ||
    pathname.startsWith("/assistant") ||
    pathname.startsWith("/session")
  )
    return "assistant";
  if (pathname.startsWith("/messages")) return "messages";
  if (pathname.startsWith("/skills")) return "skills";
  if (pathname.startsWith("/drive")) return "drive";
  if (pathname.startsWith("/flows")) return "flows";
  if (pathname.startsWith("/more") || pathname.startsWith("/schedule"))
    return "settings";
  return "other";
}
```

- [ ] **Step 4:跑测确认通过**

Run:`pnpm jest apps/web-agent/src/lib/area-from-path.spec.ts`
Expected:PASS(7 用例全绿)。

- [ ] **Step 5:补 i18n key**

在 `apps/web-agent/messages/zh.json` 的 `appShell.rail` 对象里,新增 `flows` 与 `settings`(保留现有 home/messages/assistant/skills/more/drive):

```json
      "flows": "流程",
      "settings": "设置",
```

在 `apps/web-agent/messages/en.json` 对应 `appShell.rail` 里新增:

```json
      "flows": "Flows",
      "settings": "Settings",
```

- [ ] **Step 6:重排 `WorkspaceRail` 为六项**

在 `apps/web-agent/src/components/shell/workspace-rail.tsx`:

(a) 把 lucide 图标 import 行改为(新增 `Bot`、`Workflow`、`Settings`,移除只在旧四项用到的 `MoreHorizontal`——`Blocks`/`Folder`/`MessageSquare` 保留;`Building2`/`Check`/`Moon`/`Sun` 头像菜单与主题仍用):

```tsx
import {
  Blocks,
  Bot,
  Building2,
  Check,
  Folder,
  MessageSquare,
  Moon,
  Settings,
  Sun,
  Workflow,
} from "lucide-react";
```

(b) 把 `<nav>` 内的四个 `RailNavItem` 整段替换为六项(顺序:助手·消息·技能·网盘·流程·设置):

```tsx
      <nav className="mt-1 flex w-full flex-col gap-1">
        <RailNavItem
          icon={<Bot className="h-5 w-5" />}
          label={t("rail.assistant")}
          active={area === "assistant"}
          onClick={() => router.push("/assistant")}
        />
        <RailNavItem
          icon={<MessageSquare className="h-5 w-5" />}
          label={t("rail.messages")}
          active={area === "messages"}
          onClick={() => router.push("/messages")}
        />
        <RailNavItem
          icon={<Blocks className="h-5 w-5" />}
          label={t("rail.skills")}
          active={area === "skills"}
          onClick={() => router.push("/skills")}
        />
        <RailNavItem
          icon={<Folder className="h-5 w-5" />}
          label={t("rail.drive")}
          active={area === "drive"}
          onClick={() => router.push("/drive")}
        />
        <RailNavItem
          icon={<Workflow className="h-5 w-5" />}
          label={t("rail.flows")}
          active={area === "flows"}
          onClick={() => router.push("/flows")}
        />
        <RailNavItem
          icon={<Settings className="h-5 w-5" />}
          label={t("rail.settings")}
          active={area === "settings"}
          onClick={() => router.push("/more")}
        />
      </nav>
```

> 注:设置区落地页沿用现有 `/more`(使用情况);url 保持 `/more` 但导航文案为「设置」,避免迁移路由带来的连锁改动。

- [ ] **Step 7:首页重定向改指助手区**

在 `apps/web-agent/src/app/page.tsx` 把 `redirect("/messages")` 改为 `redirect("/assistant")`。

- [ ] **Step 8:typecheck + build**

Run:`pnpm --filter @meshbot/web-agent typecheck`(Expected PASS)
Run:`pnpm --filter @meshbot/web-agent build`(timeout 600000;Expected PASS。此时 `/assistant`、`/flows` 路由尚未建,但 rail 用 `router.push` 运行时跳转,不是静态 import,构建不因此失败;`/assistant` 页在 Task 2 建、`/flows` 在 Task 4 建)。

> ⚠️ 若 `next build` 因静态导出找不到 `/assistant`/`/flows` 而失败(静态导出会预渲染已知路由,但不会因 `router.push` 目标缺失而失败),按 DONE_WITH_CONCERNS 记录并继续——Task 2/4 建页后 Task 4 末尾的整体 build 会转绿。

- [ ] **Step 9:提交**

```bash
git add apps/web-agent/src/lib/area-from-path.ts apps/web-agent/src/lib/area-from-path.spec.ts apps/web-agent/src/components/shell/workspace-rail.tsx apps/web-agent/src/app/page.tsx apps/web-agent/messages/zh.json apps/web-agent/messages/en.json
git commit -m "feat(web-agent): rail 六项 + areaFromPath 六区 + 首页落助手区

助手·消息·技能·网盘·流程·设置;首页重定向 /messages→/assistant;/more、/schedule 归设置区。
areaFromPath 7 用例单测。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2:助手区(独立 `/assistant` 路由 + AssistantSidebar)

把助手会话从 `/messages?kind=assistant` 迁到独立 `/assistant` 区,二级用单一"本机"分组。

**Files:**
- Create: `apps/web-agent/src/app/(shell)/assistant/page.tsx`
- Create: `apps/web-agent/src/components/shell/assistant-sidebar.tsx`
- Modify: `apps/web-agent/src/components/sidebar/session-list-item.tsx`
- Modify: `apps/web-agent/src/app/session/page.tsx`
- Modify: `apps/web-agent/messages/zh.json`、`en.json`

**Interfaces:**
- Consumes:`sessionsAtom`/`sessionsStatusAtom`(`@/atoms/sessions`)、`loadSidebarAtom`(`@/atoms/sidebar`)、`SessionListItem`、`SidebarSection`、`SidebarSkeleton`、`PageShell`、`SessionHeader({sessionId})`、`AssistantConversationBody({id, scrollRef})`。
- Produces:路由 `/assistant?id=<sessionId>`;`AssistantSidebar` 组件。

- [ ] **Step 1:建 `AssistantSidebar`** — 新建 `apps/web-agent/src/components/shell/assistant-sidebar.tsx`:

```tsx
"use client";

import { useAtomValue, useSetAtom } from "jotai";
import { SquarePen } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { sessionsAtom, sessionsStatusAtom } from "@/atoms/sessions";
import { loadSidebarAtom } from "@/atoms/sidebar";
import { SidebarSection } from "@/components/shell/sidebar-section";
import { SidebarSkeleton } from "@/components/shell/sidebar-skeleton";
import { SessionListItem } from "@/components/sidebar/session-list-item";

/**
 * 助手二级侧栏:本机设备 Agent 的会话列表(单一「本机」分组)。
 * 跨设备分组待云端设备信息,当前 web-agent 本地只有本机一台。
 * 数据与消息侧栏共用 loadSidebarAtom(一次请求填会话+助手,带 guard 不重复拉)。
 */
export function AssistantSidebar() {
  const t = useTranslations("assistantSidebar");
  const router = useRouter();
  const sessions = useAtomValue(sessionsAtom);
  const status = useAtomValue(sessionsStatusAtom);
  const loadSidebar = useSetAtom(loadSidebarAtom);

  useEffect(() => {
    void loadSidebar();
  }, [loadSidebar]);

  return (
    <div className="flex h-full flex-col bg-(--shell-sidebar) text-white">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-white/8 px-3.5">
        <span className="text-[15px] font-extrabold">{t("title")}</span>
        <button
          type="button"
          title={t("newSession")}
          onClick={() => router.push("/assistant")}
          className="flex h-7 w-7 items-center justify-center rounded-md text-white/70 transition-colors hover:bg-white/10 hover:text-white"
        >
          <SquarePen className="h-4 w-4" />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 py-2">
        {status === "idle" || status === "loading" ? (
          <SidebarSkeleton />
        ) : (
          <SidebarSection title={t("thisDevice")}>
            {status === "error" ? (
              <div className="px-2 py-1 text-[12px] text-white/55">
                {t("loadFailed")}
              </div>
            ) : sessions.length === 0 ? (
              <div className="px-2 py-1 text-[12px] text-white/55">
                {t("empty")}
              </div>
            ) : (
              sessions.map((s) => <SessionListItem key={s.id} session={s} />)
            )}
          </SidebarSection>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2:建 `/assistant` 页** — 新建 `apps/web-agent/src/app/(shell)/assistant/page.tsx`:

```tsx
"use client";

import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Suspense, useRef } from "react";
import { PageShell } from "@/components/layouts/page-shell";
import { AssistantConversationBody } from "@/components/session/assistant-conversation-body";
import { SessionHeader } from "@/components/session/session-header";
import { AssistantSidebar } from "@/components/shell/assistant-sidebar";

function AssistantView() {
  const t = useTranslations("assistantSidebar");
  const searchParams = useSearchParams();
  const id = searchParams.get("id");
  const scrollRef = useRef<HTMLDivElement>(null);

  return (
    <PageShell
      sidebar={<AssistantSidebar />}
      scrollContainerRef={scrollRef}
      header={id ? <SessionHeader sessionId={id} /> : undefined}
    >
      {id ? (
        <AssistantConversationBody id={id} scrollRef={scrollRef} />
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          {t("emptyHint")}
        </div>
      )}
    </PageShell>
  );
}

/** /assistant 页。useSearchParams 需 Suspense 边界(静态导出要求)。 */
export default function AssistantPage() {
  return (
    <Suspense fallback={null}>
      <AssistantView />
    </Suspense>
  );
}
```

- [ ] **Step 3:`SessionListItem` 路由改指 `/assistant`**

在 `apps/web-agent/src/components/sidebar/session-list-item.tsx`:

(a) 把 `active` 判定(约 48–51 行)改为:

```tsx
  const active =
    pathname === "/assistant" && searchParams.get("id") === session.id;
```

(b) 把点击跳转(约 132–135 行)里的 `router.push(\`/messages?kind=assistant&id=${session.id}\`)` 改为:

```tsx
              router.push(`/assistant?id=${session.id}`);
```

(c) 把删除后跳转(约 97 行)`if (active) router.push("/")` 改为 `if (active) router.push("/assistant")`。

- [ ] **Step 4:旧 `/session` 跳板改指 `/assistant`**

`apps/web-agent/src/app/session/page.tsx` 是旧链接兼容跳板。把其 `useEffect` 里的重定向行:

```tsx
    router.replace(id ? `/messages?kind=assistant&id=${id}` : "/messages");
```

改为:

```tsx
    router.replace(id ? `/assistant?id=${id}` : "/assistant");
```

(其余逻辑与 JSDoc 中的 `/messages?kind=assistant` 描述可一并更新为 `/assistant`,非必需。)

- [ ] **Step 5:补 i18n** — `apps/web-agent/messages/zh.json` 顶层新增 `assistantSidebar` 对象:

```json
  "assistantSidebar": {
    "title": "助手",
    "newSession": "新会话",
    "thisDevice": "本机",
    "empty": "暂无会话",
    "loadFailed": "加载失败",
    "emptyHint": "选择或新建一个会话开始"
  },
```

`en.json` 顶层新增:

```json
  "assistantSidebar": {
    "title": "Assistant",
    "newSession": "New session",
    "thisDevice": "This device",
    "empty": "No sessions yet",
    "loadFailed": "Failed to load",
    "emptyHint": "Pick or start a session to begin"
  },
```

- [ ] **Step 6:typecheck + build**

Run:`pnpm --filter @meshbot/web-agent typecheck && pnpm --filter @meshbot/web-agent build`(timeout 600000)
Expected:PASS(`/assistant` 路由已建;`/messages?kind=assistant` 旧分支仍在 messages 页,Task 3 移除)。

- [ ] **Step 7:提交**

```bash
git add apps/web-agent/src/app/\(shell\)/assistant apps/web-agent/src/components/shell/assistant-sidebar.tsx apps/web-agent/src/components/sidebar/session-list-item.tsx apps/web-agent/src/app/session/page.tsx apps/web-agent/messages/zh.json apps/web-agent/messages/en.json
git commit -m "feat(web-agent): 独立助手区 /assistant + AssistantSidebar(本机分组)

助手会话从 /messages?kind=assistant 迁到 /assistant?id=;二级单一「本机」分组列会话;
旧 /session 跳板改指 /assistant。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3:消息区瘦身(私聊 + 频道,移除助手段)

助手已迁出,消息侧栏只留人际 IM 两组;消息页移除 `kind=assistant` 分支并把旧 assistant 链接重定向到 `/assistant`。

**Files:**
- Modify: `apps/web-agent/src/components/shell/messages-sidebar.tsx`
- Modify: `apps/web-agent/src/app/(shell)/messages/page.tsx`

**Interfaces:**
- Consumes:`conversationsAtom`/`currentConversationIdAtom`/`presenceAtom`(`@/atoms/im`)、`loadSidebarAtom`、`SidebarSection`、`SidebarNavItem`、`SidebarSkeleton`。

- [ ] **Step 1:`MessagesSidebar` 移除助手段 + 改用 conversations 加载判据**

在 `apps/web-agent/src/components/shell/messages-sidebar.tsx`:

(a) 移除对 `sessionsAtom`/`sessionsStatusAtom`/`SessionListItem` 的 import 与使用;骨架判据从 `sessionsStatus` 改为一个 conversations 就绪标记。改用 `sessionsStatusAtom`? 否——消息侧栏不该依赖助手状态。用 `loadSidebarAtom` 的完成态:引入 `sessionsStatusAtom` 仅作"侧栏是否加载完"信号会耦合助手;改为本地以 conversations 是否已尝试加载判断。**最简做法**:保留 `sessionsStatusAtom` 作为"侧栏聚合请求是否完成"的信号(它由 `loadSidebarAtom` 统一置位,语义是整个侧栏请求完成,不特指助手),继续用它控骨架。即:**只删助手段的渲染,保留骨架判据 `sessionsStatus`**。

具体:删掉 `import { sessionsAtom, sessionsStatusAtom }` 改为只 `import { sessionsStatusAtom }`;删掉 `const assistantSessions = useAtomValue(sessionsAtom);` 与 `import { SessionListItem }`;删掉整个「助手」`<SidebarSection title={t("assistant")}>...</SidebarSection>` 块(约 137–153 行)。保留频道段、私信段与 `sessionsStatus` 骨架判据不变。

(b) 段顺序调整为**私信在前、频道在后**(贴 spec「私聊 / 频道」顺序):把「私信」`<SidebarSection>` 块整体移到「频道」块之前。

- [ ] **Step 2:消息页移除 `kind=assistant` 分支 + 旧链接重定向**

在 `apps/web-agent/src/app/(shell)/messages/page.tsx` 的 `MessagesView`。用**与 `session/page.tsx` 一致的客户端重定向惯例**(`useRouter().replace` in `useEffect`,不用 `redirect()`):把旧 `/messages?kind=assistant&id=X` 导到 `/assistant?id=X`,并删除 assistant 正文分支。移除文件顶部 `AssistantConversationBody`、`SessionHeader` 两个 import;顶部 import 新增 `useRouter`(与已有 `useSearchParams` 同来源 `next/navigation`)。

改完 `MessagesView` 整体替换为:

```tsx
function MessagesView() {
  const t = useTranslations("messages");
  const router = useRouter();
  const searchParams = useSearchParams();
  const id = searchParams.get("id");
  const isAssistant = searchParams.get("kind") === "assistant";
  const scrollRef = useRef<HTMLDivElement>(null);

  const setCurrentConversationId = useSetAtom(currentConversationIdAtom);
  const setMessages = useSetAtom(messagesAtom);
  // 旧 assistant 链接:客户端重定向到独立助手区(与 /session 跳板同款惯例)。
  // 其余:进 IM 会话时写当前会话 id;裸 /messages 复位清空。
  useEffect(() => {
    if (isAssistant) {
      router.replace(id ? `/assistant?id=${id}` : "/assistant");
      return;
    }
    const imId = id ?? null;
    setCurrentConversationId(imId);
    if (!imId) setMessages([]);
  }, [id, isAssistant, router, setCurrentConversationId, setMessages]);

  // 重定向进行中,不渲染消息壳,避免闪一帧空 IM。
  if (isAssistant) return null;

  return (
    <PageShell
      sidebar={<MessagesSidebar />}
      scrollContainerRef={scrollRef}
      header={id ? <ImConversationHeader /> : undefined}
    >
      {id ? (
        <ImConversationBody id={id} scrollRef={scrollRef} />
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          {t("emptyHint")}
        </div>
      )}
    </PageShell>
  );
}
```

(顶部 import:`import { useRouter, useSearchParams } from "next/navigation";`,并移除 `AssistantConversationBody`、`SessionHeader` 两个 import。)

- [ ] **Step 3:typecheck + build**

Run:`pnpm --filter @meshbot/web-agent typecheck && pnpm --filter @meshbot/web-agent build`(timeout 600000)
Expected:PASS。

- [ ] **Step 4:提交**

```bash
git add apps/web-agent/src/components/shell/messages-sidebar.tsx apps/web-agent/src/app/\(shell\)/messages/page.tsx
git commit -m "feat(web-agent): 消息区瘦身为私聊+频道,助手段迁出

移除消息侧栏助手段(已迁 /assistant),段序私信在前;消息页移除 kind=assistant 分支,
旧 /messages?kind=assistant 链接 301 到 /assistant。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4:流程留位 + 设置侧栏更名

补齐 rail 最后两项的落地:流程空态占位,「更多」区更名为「设置」。

**Files:**
- Create: `apps/web-agent/src/app/(shell)/flows/page.tsx`
- Modify: `apps/web-agent/src/components/shell/more-sidebar.tsx`
- Modify: `apps/web-agent/messages/zh.json`、`en.json`

- [ ] **Step 1:建 `/flows` 空态页** — 新建 `apps/web-agent/src/app/(shell)/flows/page.tsx`:

```tsx
"use client";

import { Workflow } from "lucide-react";
import { useTranslations } from "next-intl";
import { PageShell } from "@/components/layouts/page-shell";

/** 流程区(留位):人机协作流程平台占位,后续接入。 */
export default function FlowsPage() {
  const t = useTranslations("flows");
  return (
    <PageShell>
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-(--shell-accent)/12 text-(--shell-accent)">
          <Workflow className="h-7 w-7" />
        </span>
        <div className="text-[15px] font-semibold text-foreground">
          {t("comingTitle")}
        </div>
        <div className="max-w-[320px] text-[13px] text-muted-foreground">
          {t("comingHint")}
        </div>
      </div>
    </PageShell>
  );
}
```

- [ ] **Step 2:`MoreSidebar` 更名为设置** — 在 `apps/web-agent/src/components/shell/more-sidebar.tsx` 把 `useTranslations("moreSidebar")` 改为 `useTranslations("settingsSidebar")`,其余结构不变(仍是 使用情况 `/more` + 定时任务 `/schedule` 两项)。

- [ ] **Step 3:补 i18n** — `zh.json` 顶层新增 `flows` 与 `settingsSidebar`(`settingsSidebar` 复用 moreSidebar 的三项文案,标题改「设置」):

```json
  "flows": {
    "comingTitle": "流程即将上线",
    "comingHint": "人机协作的流程编排能力正在开发中,敬请期待。"
  },
  "settingsSidebar": {
    "title": "设置",
    "usage": "使用情况",
    "scheduled": "定时任务"
  },
```

`en.json` 顶层新增:

```json
  "flows": {
    "comingTitle": "Flows coming soon",
    "comingHint": "Human–agent workflow orchestration is under development."
  },
  "settingsSidebar": {
    "title": "Settings",
    "usage": "Usage",
    "scheduled": "Scheduled tasks"
  },
```

> 保留旧 `moreSidebar` 对象不删(其它处若仍引用不受影响);`sync-locales --check` 只校验 used⊆defined 与两语言对齐,`moreSidebar` 变 ORPHAN 属既有基线噪声。

- [ ] **Step 4:typecheck + build(P2a 整体收口)**

Run:`pnpm --filter @meshbot/web-agent typecheck && pnpm --filter @meshbot/web-agent build`(timeout 600000)
Expected:PASS——此时 `/assistant`、`/flows` 均已建,六项 rail 全部有落地页,静态导出不缺路由。

- [ ] **Step 5:提交**

```bash
git add apps/web-agent/src/app/\(shell\)/flows apps/web-agent/src/components/shell/more-sidebar.tsx apps/web-agent/messages/zh.json apps/web-agent/messages/en.json
git commit -m "feat(web-agent): 流程留位空态 + 更多区更名设置

/flows 空态占位(D 留位);MoreSidebar 文案改用 settingsSidebar(标题「设置」)。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 收尾:全量围栏 + 视觉冒烟清单

- [ ] **Step 1:全量类型检查 + 围栏**

Run:`pnpm typecheck && pnpm check`
Expected:typecheck 全绿;围栏全绿(i18n `missing=0`)。

- [ ] **Step 2:视觉冒烟(人工)** — `pnpm dev:web-agent`(3001):
  - rail 六项:助手·消息·技能·网盘·流程·设置,图标+文案正确,当前区高亮(焦橙)。
  - 首页 `/` 落到助手区;助手侧栏「本机」分组列会话,点会话进 `/assistant?id=`,会话头/正文/流式正常。
  - 新会话按钮(SquarePen)→ `/assistant` 空态。
  - 消息区:仅私信+频道两段(无助手段),私信在前;点频道/私信进会话正常。
  - 旧链接:浏览器手敲 `/messages?kind=assistant&id=X` 与 `/session?id=X` 都跳到 `/assistant?id=X`。
  - 流程:`/flows` 空态占位;设置:`/more`(使用情况)+ `/schedule`(定时任务)侧栏标题为「设置」。

---

## Self-Review

**1. Spec 覆盖(§3 IA / §12 P2 的骨架部分)**:rail 6 项 ✅(T1)· 助手/消息拆分 ✅(T2/T3)· 私聊自己设备 Agent 归助手(会话即助手区)✅ · 群暂缓(私聊+频道)✅(T3,Global Constraints 说明)· 流程留位 ✅(T4)· 设置 hub 纳入使用/定时 ✅(T4)。**统一 header 带 + 右区双层**属 §12 P2 后半,由后续 **P2b** plan 承接(见下),本 plan 有意不含。

**2. 占位符扫描**:无 TBD;每个 code step 给出完整文件或确切编辑 + 确切命令。T1-Step8 的 build 风险显式说明(运行时 `router.push` 不因目标未建而 fail),非占位。

**3. 类型/命名一致**:`ShellArea` 六值在 `area-from-path.ts` 与测试一致;`AssistantSidebar`/`assistantSidebar` i18n 命名一致;`SessionListItem` 路由 `/assistant?id=` 与 `/assistant` 页读 `searchParams.get("id")` 一致;`settingsSidebar` 三 key(title/usage/scheduled)与 `MoreSidebar` 用法一致。

**4. 范围**:P2a 单一可交付(新 IA 骨架,app 可用、现有能力零丢失),独立成 plan;header 带与右区双层因涉及跨三区对齐与 shell 层 dock 改造,风险与验证面不同,拆为 **P2b**(`2026-07-05-ui-p2b-header-band-right-zone.md` 或同日续号)。

## 关于 P2b(后续)
统一 52px header 带(左②级/中会话/右 tab 三者对齐)+ 右区双层(上下文 tab + 钉住随手问,演进 `AssistantDock`/`ArtifactPreviewPanel`/`DockTabs`)。P2a 合入后另起 plan。
