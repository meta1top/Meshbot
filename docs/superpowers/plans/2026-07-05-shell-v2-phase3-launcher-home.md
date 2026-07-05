# Shell v2 · Phase 3 起手台首页 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 web-agent 根路由 `/` 从「redirect→/assistant」变成**起手台实页**（在 `(shell)` 布局内、带左栏）：主区 = 大标题 + 场景分段 + 建议 chips + 重 composer；发送即建会话跳进去；左栏「最近」= 会话列表。

**Architecture:** 复用现成件——`ChatInput`（解耦输入器）、`SuggestionChips`（孤儿组件复活，点击填 composer）、`home` i18n（旧首页文案复活）、`sessionsAtom`+`SessionListItem`（最近列表）；发送链路仿 `new-message-view.tsx`：`createSession(content)`→`addSession`→`router.push('/assistant?id='+id)`。`/` 移进 `(shell)` 组以拿到 WorkspaceSidebar + portal 插槽。参考 spec §6.1/§11。

**Tech Stack:** Next.js 15 App Router（`output: "export"` 静态导出）· jotai · TipTap(ChatInput)。

## Global Constraints

- **仅 web-agent**。不动后端、不碰 web-main、不动 Phase 1/2 的壳/右区。
- **发送链路复用既有**：`createSession` 建会话即落首条，前端**无需**再单发首条；建完 `addSession` 本地插列表 + `router.push('/assistant?id='+sessionId)`。**不要**用 `stream.send`（那只服务已有会话）。
- **composer 底部「技能/连应用/权限」配置开关**：web-agent 现**无对应后端/atom**——本期做成**视觉占位**（非功能：一排 pill 按钮 + 图标 + 下拉箭头，点击暂无行为或 `title` 提示「即将上线」，对齐 mockup 观感）。真实配置写入留 follow-up（需后端）。场景分段同为视觉占位。
- **静态导出**：`next.config.ts` 是 `output:"export"`；任何 `useSearchParams()` 客户端组件必须包 `Suspense`（起手台首屏若不读 query 则不需要）。
- **视觉**：沿用暖炭·配橙 + 居中单列（spec §6.1）；焦橙克制（主发送/选中）。品牌文案用 `MeshBot`（大驼峰，spec §9）。
- commit：中文 conventional，结尾 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`；**禁 `--no-verify`**。
- 验证：每任务 `pnpm --filter web-agent typecheck`（+ Task 2 `build`）+ 人工冒烟。

---

## 前置事实（实现者须知）

- **发送范式**（照抄）`components/im/new-message-view.tsx:53-60`：`const res = await createSession(body); addSession(res.session); router.push(\`/assistant?id=${res.sessionId}\`)`。`createSession(content, kind?)` 在 `rest/session.ts:25`（`content` 即首条）。`addSession` = `useSetAtom(addSessionAtom)`（`atoms/sessions.ts:50`）。
- **ChatInput** `components/common/chat-input.tsx`：受控 props `value:string` / `onChange(next)` / `onSend?(msg)`（msg=trim 后 markdown，发送后自动清空）/ `placeholder?` / `isLoading?` / `onInterrupt?`。可脱离会话纯用：`<ChatInput value={draft} onChange={setDraft} onSend={handleSend} placeholder={...} />`。
- **SuggestionChips** `components/common/suggestion-chips.tsx`（当前**无引用**，可复活）：点击**填入输入框、不自动发送**；读 `home.defaultSuggestions` + `fetchSuggestions()`(`rest/stats.ts:19`)。核对其 props（onSelect/回填回调）后接 `setDraft`。
- **home i18n**（复活）`messages/zh.json:303-338`（en 同）：`title`/`titles`/`inputPlaceholders`/`defaultSuggestions`/`metrics`。起手台标题/占位/建议直接用。
- **最近列表**：`sessionsAtom`(`atoms/sessions.ts:14`,已排序 updatedAt desc) + `SessionListItem`(`components/sidebar/session-list-item.tsx`,点击 push `/assistant?id=`)；首屏加载 `loadSidebarAtom`(`atoms/sidebar.ts`,assistant-sidebar 也用它,带 guard 不重复拉)。
- **PageShell 插槽**：`(shell)` 内页面用 `<PageShell sidebar={<...>} >{content}</PageShell>`,sidebar 会 portal 进 WorkspaceSidebar 子栏（Phase 1 机制）。
- **`/` 现状**：`app/page.tsx` 仅 `redirect("/assistant")`,**在 (shell) 组外**。WorkspaceSidebar 的「新建任务」CTA 已指 `/`（`workspace-sidebar.tsx:151`）。`areaFromPath("/")` 返回 `"assistant"`——起手台在 `/` 时 rail 高亮「助手」、最近列表即会话列表,语义自洽（起手台=助手区的 home）。

---

## Task 1: `LauncherHome` 起手台中区

**Files:**
- Create: `apps/web-agent/src/components/home/launcher-home.tsx`

**Interfaces:**
- Produces: `LauncherHome`（无 props）——居中单列:品牌大标题 + 场景分段(视觉) + `SuggestionChips`(填 composer) + `ChatInput`(重 composer);发送 = 建会话跳转。

- [ ] **Step 1: 写组件**

`launcher-home.tsx`——本地 `draft` state + `sending` state;`handleSend(text)` 走建会话范式:

```tsx
"use client";

import { useSetAtom } from "jotai";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { addSessionAtom } from "@/atoms/sessions";
import { ChatInput } from "@/components/common/chat-input";
import { SuggestionChips } from "@/components/common/suggestion-chips";
import { createSession } from "@/rest/session";

/** 起手台中区：品牌大标题 + 场景分段 + 建议 chips + 重 composer；发送即建会话跳转。 */
export function LauncherHome() {
  const t = useTranslations("home");
  const router = useRouter();
  const addSession = useSetAtom(addSessionAtom);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

  const handleSend = async (text: string) => {
    if (sending || !text.trim()) return;
    setSending(true);
    try {
      const res = await createSession(text);
      addSession(res.session);
      router.push(`/assistant?id=${res.sessionId}`);
    } catch {
      setSending(false); // 失败留在起手台，草稿由 ChatInput 已清——保守起见不自动重填
    }
  };

  // 场景分段（视觉占位，本地 state 切高亮，不接功能）
  const [scene, setScene] = useState("daily");
  const scenes = [
    { key: "daily", label: t("scenes.daily") },
    { key: "code", label: t("scenes.code") },
    { key: "design", label: t("scenes.design") },
  ];

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-6">
      <div className="flex w-full max-w-[640px] flex-col items-center gap-5">
        <div className="text-center">
          <h1 className="text-[40px] font-extrabold leading-tight tracking-tight text-foreground">
            MeshBot
          </h1>
          <p className="mt-1 text-[18px] font-semibold text-muted-foreground">
            {t("title")}
          </p>
        </div>
        {/* 场景分段（视觉占位） */}
        <div className="inline-flex gap-1 rounded-xl bg-muted p-1">
          {scenes.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => setScene(s.key)}
              className={
                scene === s.key
                  ? "rounded-lg bg-(--shell-chrome) px-4 py-1.5 text-[13px] font-semibold text-white"
                  : "rounded-lg px-4 py-1.5 text-[13px] font-semibold text-muted-foreground hover:text-foreground"
              }
            >
              {s.label}
            </button>
          ))}
        </div>
        {/* 建议 chips：点击填入草稿 */}
        <SuggestionChips onSelect={(s) => setDraft(s)} />
        {/* 重 composer：配置条（视觉占位）+ ChatInput */}
        <div className="w-full">
          <div className="mb-1.5 flex items-center gap-1.5">
            {[
              { key: "skills", icon: <Blocks className="h-3.5 w-3.5" />, label: t("composer.skills") },
              { key: "apps", icon: <Link2 className="h-3.5 w-3.5" />, label: t("composer.apps") },
              { key: "perms", icon: <Shield className="h-3.5 w-3.5" />, label: t("composer.permissions") },
            ].map((c) => (
              <button
                key={c.key}
                type="button"
                title={t("composer.comingSoon")}
                className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-[12px] font-medium text-muted-foreground hover:text-foreground"
              >
                {c.icon}
                {c.label}
                <ChevronDown className="h-3 w-3 opacity-60" />
              </button>
            ))}
          </div>
          <ChatInput
            value={draft}
            onChange={setDraft}
            onSend={(text) => void handleSend(text)}
            isLoading={sending}
            placeholder={t("inputPlaceholders.0")}
          />
        </div>
      </div>
    </div>
  );
}
```

新增 import：`import { Blocks, ChevronDown, Link2, Shield } from "lucide-react";`。

> 注：`SuggestionChips` 的实际 prop 名（onSelect/onPick 等）以其源码为准——**实现前先读 `components/common/suggestion-chips.tsx`**,按真实签名接 `setDraft`;若它内部直接写某输入 atom 而非回调,则改受控回调或包一层。`home.inputPlaceholders` 是数组,取第 0 个作 placeholder。**场景分段 + 配置条(技能/连应用/权限)均为视觉占位**：场景切换只改本地高亮、配置条 pill 点击无行为(仅 `title` 提示"即将上线")——对齐 mockup 观感,功能留 follow-up。
> **本任务须补 i18n（否则 pre-commit `sync-locales --check` 因 missing 拦住）**：`home.scenes.daily/code/design`（日常办公/代码开发/设计创意）、`home.composer.skills/apps/permissions`（技能/连应用/权限）、`home.composer.comingSoon`（即将上线）——zh + en 都加、对称。`home.recent`（最近）留 Task 2（那边 RecentSessionsSidebar 才用它）。

- [ ] **Step 2: 补 i18n（本组件用到的 key）**

`messages/zh.json` + `en.json` 的 `home` 段补 `scenes.{daily,code,design}`、`composer.{skills,apps,permissions,comingSoon}`（zh:日常办公/代码开发/设计创意 · 技能/连应用/权限/即将上线;en 对应英文）。跑 `pnpm sync:locales --write` 后确认 `sync:locales --check` 无 missing/asymmetric。

- [ ] **Step 3: typecheck + commit**

Run: `pnpm --filter web-agent typecheck` → exit 0（组件未被引用,编译通过即可）
Commit: `feat(web-agent): 起手台中区 LauncherHome（复用 ChatInput/SuggestionChips/建会话范式）`

---

## Task 2: `/` 接成起手台实页 + 最近侧栏

**Files:**
- Create: `apps/web-agent/src/app/(shell)/page.tsx`
- Delete: `apps/web-agent/src/app/page.tsx`（旧 redirect）
- Create: `apps/web-agent/src/components/home/recent-sessions-sidebar.tsx`（最近列表侧栏）

**Interfaces:**
- Consumes: `LauncherHome`（Task 1）、`PageShell`、`sessionsAtom`/`SessionListItem`/`loadSidebarAtom`。

- [ ] **Step 1: 最近侧栏**

`recent-sessions-sidebar.tsx`——mount 时 `loadSidebar()`;渲染「最近」分组 + `sessionsAtom` 列表(复用 `SessionListItem`);结构仿 `assistant-sidebar.tsx`（`flex h-full flex-col` 外壳——**不带** `bg-(--shell-sidebar)`,因 portal 进 WorkspaceSidebar 浅底继承,与 Phase 1 各子栏一致）。header「最近」`h-13`。

```tsx
"use client";
import { SidebarSection } from "@meshbot/web-common/shell";
import { useAtomValue, useSetAtom } from "jotai";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { sessionsAtom } from "@/atoms/sessions";
import { loadSidebarAtom } from "@/atoms/sidebar";
import { SessionListItem } from "@/components/sidebar/session-list-item";

export function RecentSessionsSidebar() {
  const t = useTranslations("home");
  const sessions = useAtomValue(sessionsAtom);
  const loadSidebar = useSetAtom(loadSidebarAtom);
  useEffect(() => {
    void loadSidebar();
  }, [loadSidebar]);
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-13 shrink-0 items-center border-b border-(--shell-sidebar-border) px-3.5 text-[15px] font-extrabold">
        {t("recent")}
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 py-2">
        <SidebarSection title={t("recent")}>
          {sessions.map((s) => (
            <SessionListItem key={s.id} session={s} />
          ))}
        </SidebarSection>
      </div>
    </div>
  );
}
```

> 注：`SessionListItem` 的 props 以源码为准（`components/sidebar/session-list-item.tsx`,大概率 `session`）；`home.recent` 是新 i18n key（Step 3 补）。若 `SidebarSection` 需要额外 props 参 assistant-sidebar 用法。header 那行「最近」与分组标题重复可去其一——以 assistant-sidebar 现观感为准,保持一致。

- [ ] **Step 2: `(shell)/page.tsx` 起手台路由**

`app/(shell)/page.tsx`——`(shell)` 组内 index route（= `/`）,用 `PageShell` 把最近侧栏 portal 进左栏 + 中区放 `LauncherHome`:

```tsx
"use client";
import { PageShell } from "@/components/layouts/page-shell";
import { LauncherHome } from "@/components/home/launcher-home";
import { RecentSessionsSidebar } from "@/components/home/recent-sessions-sidebar";

/** 起手台首页 `/`：左栏最近会话 + 中区起手台 composer。 */
export default function HomePage() {
  return (
    <PageShell sidebar={<RecentSessionsSidebar />}>
      <LauncherHome />
    </PageShell>
  );
}
```

- [ ] **Step 3: 删旧 redirect + 补 i18n**

- 删 `apps/web-agent/src/app/page.tsx`（旧 `redirect("/assistant")`——现由 `(shell)/page.tsx` 承接 `/`）。
- `messages/zh.json` + `en.json`：`home` 段补 `"recent"`（zh「最近」/ en「Recent」）。跑 `pnpm sync:locales --write` 确认对称。

- [ ] **Step 4: typecheck + build + 冒烟**

Run: `pnpm --filter web-agent typecheck` → exit 0
Run: `pnpm --filter web-agent build` → 成功（`/` 现为静态起手台页,不再 redirect;确认 8+ 页正常）
冒烟：进 `/` → 带左栏(WorkspaceSidebar)+ 左「最近」会话列表 + 中区 MeshBot 大标题 + 建议 chips + composer；点 chip 填入输入框;输入并发送 → 建会话并跳 `/assistant?id=<新id>`、消息在;点左栏「新建任务」CTA 回到 `/`;点最近某会话进 `/assistant?id=`;rail「助手」高亮。

- [ ] **Step 5: Commit**

`feat(web-agent): / 改为起手台实页（左栏最近 + 中区 composer 建会话）`

---

## 完成后（controller）

- 终审整 Phase（`review-package` MERGE_BASE HEAD → opus）。重点：建会话流（createSession→addSession→push）与首条落库无重复发送；`/` 进 (shell) 布局正确（左栏/portal 插槽/静态导出）；删 `app/page.tsx` 后无路由冲突（`/` 仅由 `(shell)/page.tsx` 提供）；SuggestionChips 复活接线正确;登录后 `router.replace("/")` 现落起手台（非再跳 assistant）无异常。
- **本 Phase 不含**（记 follow-up）：场景分段（日常/代码/设计）功能化；composer「技能/MCP/权限/模型」配置开关（需后端）；`/assistant` 空态是否统一到起手台;孤儿 i18n 清理。
- **Phase 4**（下阶段）：web-main 用上两栏壳 + 起手台（或占位）、MeshBot casing 扫 i18n/wordmark、任务/会话 措辞、精修。
- 走 PR（与 Phase 1/2 攒一起合,由用户定）。
