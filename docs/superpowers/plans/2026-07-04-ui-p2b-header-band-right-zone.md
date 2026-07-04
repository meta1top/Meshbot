# UI 重构 P2b:统一 header 带 + 右区双层 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 web-agent 的顶部 header 统一成 52px 一条带,并把右侧 dock 从"随手问⇄产物二选一"升级为"**页面上下文 tab(产物/工具/成员)+ 钉住的全局随手问**"双层结构。

**Architecture:** 三块:①各 header 从 44px(h-11)统一抬到 52px(h-13),保持同一条底边线;②新增"当前上下文"atom(当前主助手会话 id / 当前会话 id 已有),让右区面板拿得到当前页数据;③右区 dock 头改造成统一 tab 条——左侧上下文 tab(产物已有 / 工具·成员新建)+ 右端钉住橙色「✦随手问」,选中即换面板。随手问仍是既有 `AssistantDock`、全局可开。**文件/置顶因无数据留位。** 本期不做"暖米浅色壳"(那是下一期 A)。

**Tech Stack:** Next.js 16.2.4 · React 19 · jotai 2(含 `atomFamily`/`atomWithStorage`)· lucide-react 0.468 · Tailwind v4。

## Global Constraints

- **header 带 = 52px**:所有顶部头部行(会话标题头、各侧栏头、右区 dock 头)统一 `h-13`(52px),`border-b border-border`/`border-white/8` 底边线不变,与顶栏 chrome(`h-[42px]`,独立不改)之下对齐成一条。
- **右区 = 上下文 tab + 钉住随手问**:右区 dock 头是一条 tab 条——左侧**上下文 tab**(随页面/状态出现:助手会话→产物(有产物时)+工具;频道→成员),右端**钉住橙色 ✦随手问**(始终在、`bg-(--brand)` 焦橙强调)。选中 tab 换面板。随手问=既有 `AssistantDock`,由顶栏 ✦ 全局开关控制,任何页可开。
- **数据来源(纯前端,无新后端)**:成员=`listChannelMembers(conversationId)`(已存在,`@/rest/im`);工具=从当前主助手会话的消息(`ToolCallView[]`,`toolName`/args)派生;产物=既有 `ArtifactPreviewPanel`/`previewArtifactAtom`。**文件、置顶无数据 → 不做,留位**。
- **不丢现有能力**:随手问(AssistantDock)、产物预览(present_file)、产物自动打开、面板宽度拖拽/持久化,全部保留。
- **视觉沿用 P1/P2a token**:`--brand` 焦橙、`--shell-*`;本期**不**改深/浅侧栏配色(暖米浅色壳是下一期)。
- **验证方式**:前端无组件 runner;纯函数(如工具派生 selector)走 node-jest 单测;其余 typecheck + next build + 人工冒烟。
- **i18n**:新增 `t()` key 同步补 `apps/web-agent/messages/{zh,en}.json`(`sync-locales --check` 保持 missing=0)。
- **工程纪律**:禁 `--no-verify`;中文 conventional commits + `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`;分支 `feat/unified-ui-redesign`。

## 依赖与命令
包名 `@meshbot/web-agent`(dev 3001)。typecheck `pnpm --filter @meshbot/web-agent typecheck`;build `pnpm --filter @meshbot/web-agent build`(timeout 600000);纯函数单测 `pnpm jest <spec 路径>`;冒烟 `pnpm dev:web-agent`。

## 现状关键事实(实现者背景)
- 右区在 `app/(shell)/layout.tsx`:`isPreview ? <ArtifactPreviewPanel/> : <AssistantDock/>`,`isPreview = assistantPanelTypeAtom==="preview" && previewArtifactAtom`。开关 `assistantPanelOpenAtom`(顶栏 ✦,`atomWithStorage`)。宽度 `assistantPanelWidthAtom`/`previewPanelWidthAtom`。
- `DockTabs`(`components/im/dock-tabs.tsx`)现在只在有产物时出现,切 `assistantPanelTypeAtom`("assistant"|"preview")。
- 头部现状**全为 `h-11`(44px)**:`session-header.tsx:14`、`im-conversation-header.tsx:402`(+ skeleton)、`assistant-dock.tsx:125`、`artifact-preview-panel.tsx:36`、`assistant-sidebar.tsx:32`、`messages-sidebar.tsx:49`、`more-sidebar.tsx:36`。
- 主助手会话 id 只在 `/assistant` 页 `searchParams.get("id")`,**未提全局**;当前频道 id 已有 `currentConversationIdAtom`(`@/atoms/im`)。
- 工具调用类型 `ToolCallView`(`message-list.tsx:16` 附近:`toolCallId`/`toolName`/`args`),挂在每条消息 `toolCalls?: ToolCallView[]`。
- 成员 API:`listChannelMembers(conversationId): Promise<ChannelMember[]>`(`@/rest/im`);`ChannelMember`(`@meshbot/types`)。

---

## File Structure

| 文件 | 改动 | 职责 |
|------|------|------|
| 8 处 header(见现状) | 改 | `h-11`→`h-13`(52px) |
| `apps/web-agent/src/atoms/right-zone.ts` | 建 | 右区状态:当前上下文 id + 选中 tab + 可用 tab 派生 |
| `apps/web-agent/src/app/(shell)/assistant/page.tsx` | 改 | 把当前主会话 id 写入 `currentAssistantSessionIdAtom` |
| `apps/web-agent/src/components/shell/right-zone.ts x` | 建 | 右区容器:统一 tab 条(上下文 tab + 钉住随手问)+ 按选中 tab 渲染面板 |
| `apps/web-agent/src/app/(shell)/layout.tsx` | 改 | 右 `<aside>` 内容改渲染 `<RightZone/>` |
| `apps/web-agent/src/components/session/tools-panel.tsx` | 建 | 工具上下文面板(当前会话工具调用列表) |
| `apps/web-agent/src/lib/derive-tool-calls.ts` + `.spec.ts` | 建 | 从消息派生工具调用列表(纯函数 + 单测) |
| `apps/web-agent/src/components/im/members-panel.tsx` | 建 | 成员上下文面板(频道成员) |
| `apps/web-agent/src/components/im/dock-tabs.tsx` | 删/并 | 逻辑并入 RightZone tab 条 |
| `apps/web-agent/messages/{zh,en}.json` | 改 | rightZone.* 文案 |

---

## Task 1:统一 52px header 带

把 8 处 `h-11` 头部行统一为 `h-13`(52px),保持底边线与对齐。纯样式,无逻辑。

**Files:** Modify(仅改各文件里头部行的 `h-11`→`h-13`):
`components/session/session-header.tsx:14`、`components/im/im-conversation-header.tsx`(两处 `h-11` 头部行,含 skeleton)、`components/im/assistant-dock.tsx:125`、`components/artifact/artifact-preview-panel.tsx:36`、`components/shell/assistant-sidebar.tsx:32`、`components/shell/messages-sidebar.tsx:49`、`components/shell/more-sidebar.tsx:36`。

- [ ] **Step 1:逐处替换 `h-11`→`h-13`**

对上述每个文件,把该**头部行**上的 `h-11`(class 串里,通常紧邻 `shrink-0 items-center border-b`)改为 `h-13`。**只改头部那一行**——不要动文件里其它 `h-11`(如 SessionListItem 会话项 `h-7`、头像 `h-6`/`h-7` 等与本任务无关)。用 grep 定位:`grep -n "h-11" <file>`,对照"是否是带 `border-b` 的头部容器"再改。

> Tailwind v4 内置 `h-13`(3.25rem=52px)刻度可用;若项目 spacing 未启用 13,改用 `h-[52px]`。先试 `h-13`,typecheck/build 通过即可;构建告警找不到 `h-13` 则全部换成 `h-[52px]`。

- [ ] **Step 2:确认无遗漏 + 头部一致**

Run:`grep -rn "flex h-11\|h-11 w-full\|h-11 shrink-0" apps/web-agent/src/components/session apps/web-agent/src/components/im apps/web-agent/src/components/artifact apps/web-agent/src/components/shell`
Expected:头部行不再出现 `h-11`(仅剩非头部的无关 `h-11`,若有,人工确认不是头部)。

- [ ] **Step 3:typecheck + build**

Run:`pnpm --filter @meshbot/web-agent typecheck && pnpm --filter @meshbot/web-agent build`(timeout 600000)。Expected:PASS。

- [ ] **Step 4:提交**

```bash
git add -A
git commit -m "feat(web-agent): 统一 header 带高度 52px

各会话标题头/侧栏头/右区 dock 头 h-11→h-13(52px),保持同一条底边线对齐。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2:右区状态 + 统一 tab 条容器(RightZone)

引入右区状态 atom 与 `RightZone` 容器:一条 tab 条(左上下文 tab + 右钉住随手问),按选中 tab 渲染面板。把现有"产物⇄随手问"迁进这个模型(替代 `DockTabs` + `assistantPanelTypeAtom` 的二值切换)。

**Files:**
- Create: `apps/web-agent/src/atoms/right-zone.ts`
- Modify: `apps/web-agent/src/app/(shell)/assistant/page.tsx`(写当前主会话 id)
- Create: `apps/web-agent/src/components/shell/right-zone.tsx`
- Modify: `apps/web-agent/src/app/(shell)/layout.tsx`(渲染 `<RightZone/>`)
- Modify: `apps/web-agent/messages/{zh,en}.json`

**Interfaces:**
- Produces:`currentAssistantSessionIdAtom: PrimitiveAtom<string|null>`;`RightTab = "quick" | "artifact" | "tools" | "members"`;`rightTabAtom`;`availableContextTabsAtom`(派生:根据产物/当前会话/当前频道算出可用上下文 tab)。`<RightZone/>` 组件。

- [ ] **Step 1:建右区状态 atom** — 新建 `apps/web-agent/src/atoms/right-zone.ts`:

```ts
"use client";

import { atom } from "jotai";
import { currentConversationIdAtom } from "@/atoms/im";
import { previewArtifactAtom } from "@/atoms/assistant-panel";

/** 右区可选的 tab。quick=随手问(全局钉住);其余为页面上下文 tab。 */
export type RightTab = "quick" | "artifact" | "tools" | "members";

/** 当前主助手会话 id(由 /assistant 页写入;非随手问会话)。 */
export const currentAssistantSessionIdAtom = atom<string | null>(null);

/** 用户显式选中的上下文 tab(null=未显式选,取默认)。 */
export const selectedContextTabAtom = atom<RightTab | null>(null);

/** 派生:当前可用的上下文 tab 列表(不含 quick——quick 永远钉在右端)。
 *  - 有产物 → artifact
 *  - 在主助手会话 → tools
 *  - 在频道会话 → members
 */
export const availableContextTabsAtom = atom<RightTab[]>((get) => {
  const tabs: RightTab[] = [];
  if (get(previewArtifactAtom)) tabs.push("artifact");
  if (get(currentAssistantSessionIdAtom)) tabs.push("tools");
  if (get(currentConversationIdAtom)) tabs.push("members");
  return tabs;
});

/** 派生:实际生效的右区 tab。优先用户显式选择(且仍可用),否则默认:
 *  有产物→artifact;否则有上下文→第一个;否则 quick。 */
export const effectiveRightTabAtom = atom<RightTab>((get) => {
  const sel = get(selectedContextTabAtom);
  const ctx = get(availableContextTabsAtom);
  if (sel === "quick") return "quick";
  if (sel && ctx.includes(sel)) return sel;
  if (get(previewArtifactAtom)) return "artifact";
  return ctx[0] ?? "quick";
});
```

- [ ] **Step 2:/assistant 页写当前主会话 id**

在 `apps/web-agent/src/app/(shell)/assistant/page.tsx` 的 `AssistantView` 里,新增一个 effect 把当前 `id` 同步到 `currentAssistantSessionIdAtom`(离开/无 id 时置 null),供右区工具面板取用:

```tsx
  const setCurrentAssistantSessionId = useSetAtom(currentAssistantSessionIdAtom);
  useEffect(() => {
    setCurrentAssistantSessionId(id ?? null);
    return () => setCurrentAssistantSessionId(null);
  }, [id, setCurrentAssistantSessionId]);
```

(import:`import { useSetAtom } from "jotai";`、`import { currentAssistantSessionIdAtom } from "@/atoms/right-zone";`;`useEffect` 已在用。)

- [ ] **Step 3:建 `RightZone` 容器** — 新建 `apps/web-agent/src/components/shell/right-zone.tsx`。它渲染统一 tab 条(上下文 tab + 钉住随手问)+ 按 `effectiveRightTabAtom` 渲染面板:

```tsx
"use client";

import { cn } from "@meshbot/design";
import { useAtom, useAtomValue } from "jotai";
import { Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  availableContextTabsAtom,
  effectiveRightTabAtom,
  type RightTab,
  selectedContextTabAtom,
} from "@/atoms/right-zone";
import { ArtifactBody } from "@/components/artifact/artifact-body";
import { AssistantDock } from "@/components/im/assistant-dock";
import { MembersPanel } from "@/components/im/members-panel";
import { ToolsPanel } from "@/components/session/tools-panel";

/** 右区容器:统一 tab 条(上下文 tab + 钉住 ✦随手问)+ 选中面板。 */
export function RightZone() {
  const t = useTranslations("rightZone");
  const ctx = useAtomValue(availableContextTabsAtom);
  const active = useAtomValue(effectiveRightTabAtom);
  const [, setSelected] = useAtom(selectedContextTabAtom);

  const label: Record<RightTab, string> = {
    quick: t("quick"),
    artifact: t("artifact"),
    tools: t("tools"),
    members: t("members"),
  };

  return (
    <div className="flex h-full w-full flex-col bg-(--shell-content)">
      <div className="flex h-13 shrink-0 items-center gap-1 border-b border-border px-2">
        {ctx.map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setSelected(tab)}
            className={cn(
              "rounded-md px-2.5 py-1 text-[12px] transition-colors",
              active === tab
                ? "font-semibold text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {label[tab]}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setSelected("quick")}
          className={cn(
            "ml-auto flex items-center gap-1 rounded-md px-2.5 py-1 text-[12px] font-semibold transition-colors",
            active === "quick"
              ? "bg-(--brand) text-white"
              : "text-(--brand) hover:bg-(--brand)/10",
          )}
        >
          <Sparkles className="h-3.5 w-3.5" />
          {label.quick}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {active === "quick" && <AssistantDock chromeless />}
        {active === "artifact" && <ArtifactBodyPane />}
        {active === "tools" && <ToolsPanel />}
        {active === "members" && <MembersPanel />}
      </div>
    </div>
  );
}

/** 产物面板正文(复用 ArtifactBody;标题栏由本容器的 tab 条承担,故只渲染正文)。 */
function ArtifactBodyPane() {
  const artifact = useAtomValue(
    // 局部导入避免顶部再加一行
    require("@/atoms/assistant-panel").previewArtifactAtom,
  ) as import("@/atoms/assistant-panel").PreviewArtifact | null;
  if (!artifact) return null;
  return (
    <div className="h-full overflow-auto">
      <ArtifactBody path={artifact.path} url={artifact.url} name={artifact.name} />
    </div>
  );
}
```

> 注:`AssistantDock` 需要一个 `chromeless` prop——本容器已提供统一 tab 条,dock 不再自绘自己的品牌头(见 Task 2 Step 5)。`ArtifactPreviewPanel` 的工具条(下载/全屏/关闭)本任务从其头部移除或保留由后续期处理;本期 `artifact` tab 先渲染正文 `ArtifactBody`,下载/全屏作为已知简化(记录在案)。避免用 `require()`——见 Step 4 修正。

- [ ] **Step 4:修正 `ArtifactBodyPane` 用正常 import**

把 Step 3 里 `ArtifactBodyPane` 的 `require(...)` 改为顶部正常 import:在 `right-zone.tsx` 顶部 import 段加 `import { previewArtifactAtom } from "@/atoms/assistant-panel";`,函数体改为:

```tsx
function ArtifactBodyPane() {
  const artifact = useAtomValue(previewArtifactAtom);
  if (!artifact) return null;
  return (
    <div className="h-full overflow-auto">
      <ArtifactBody path={artifact.path} url={artifact.url} name={artifact.name} />
    </div>
  );
}
```

- [ ] **Step 5:`AssistantDock` 支持 `chromeless`**

在 `apps/web-agent/src/components/im/assistant-dock.tsx`:给组件加可选 prop `{ chromeless }: { chromeless?: boolean } = {}`,当 `chromeless` 为真时**不渲染**自绘的品牌头那一整块 `<div className="flex h-13 ...品牌渐变头...>`(改名后已是 h-13),只保留对话区 + 输入。(RightZone 的 tab 条已充当头部。)非 chromeless(如别处直接用)保持原样。

- [ ] **Step 6:shell layout 渲染 `<RightZone/>`**

在 `apps/web-agent/src/app/(shell)/layout.tsx`:把右 `<aside>` 里的 `{isPreview ? <ArtifactPreviewPanel /> : <AssistantDock />}` 替换为 `<RightZone />`。移除随之不再需要的 `isPreview`/`ArtifactPreviewPanel`/`AssistantDock` 直接引用(宽度/resize 逻辑保留:仍用 `assistantPanelWidthAtom`;`previewPanelWidthAtom` 若不再用则保留 atom 但 layout 简化——宽度统一用 `assistantPanelWidthAtom`,产物宽度并入,作为本期简化记录在案)。

> 本步是本任务风险点(触及 shell 持久壳)。改完必须 `pnpm dev:server-agent` + `pnpm dev:web-agent` 真启动人工冒烟(见收尾),确认右区开关、tab 切换、随手问发消息不回归。

- [ ] **Step 7:i18n `rightZone`**

`zh.json` 顶层加:

```json
  "rightZone": {
    "quick": "随手问",
    "artifact": "产物",
    "tools": "工具",
    "members": "成员"
  },
```

`en.json` 顶层加:

```json
  "rightZone": {
    "quick": "Ask",
    "artifact": "Artifact",
    "tools": "Tools",
    "members": "Members"
  },
```

- [ ] **Step 8:typecheck + build**

Run:`pnpm --filter @meshbot/web-agent typecheck && pnpm --filter @meshbot/web-agent build`(timeout 600000)。Expected:PASS。(`ToolsPanel`/`MembersPanel` 在 Task 3/4 建;若本任务先建占位空组件以过编译,则建最小占位——见下 Step 9。)

- [ ] **Step 9:先占位 `ToolsPanel`/`MembersPanel`(让 Task 2 可独立编译)**

为使本任务自身可编译通过,先建两个最小占位组件(Task 3/4 再填实):

`apps/web-agent/src/components/session/tools-panel.tsx`:
```tsx
"use client";
export function ToolsPanel() {
  return <div className="p-4 text-[12px] text-muted-foreground">工具</div>;
}
```
`apps/web-agent/src/components/im/members-panel.tsx`:
```tsx
"use client";
export function MembersPanel() {
  return <div className="p-4 text-[12px] text-muted-foreground">成员</div>;
}
```

- [ ] **Step 10:提交**

```bash
git add -A
git commit -m "feat(web-agent): 右区双层——统一 tab 条(上下文+钉住随手问)

新增 right-zone atom(当前主会话 id/选中 tab/可用上下文 tab 派生)+ RightZone 容器:
左上下文 tab(产物/工具/成员)+ 右端钉住 ✦随手问;AssistantDock 加 chromeless;
shell 右 aside 改渲染 RightZone。工具/成员先占位,下两 task 填实。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3:工具上下文面板(当前会话工具调用)

`ToolsPanel` 列出当前主助手会话的工具调用。派生逻辑抽成纯函数单测。

**Files:**
- Create: `apps/web-agent/src/lib/derive-tool-calls.ts` + `apps/web-agent/src/lib/derive-tool-calls.spec.ts`
- Modify: `apps/web-agent/src/components/session/tools-panel.tsx`(填实)

**Interfaces:**
- Consumes:`currentAssistantSessionIdAtom`;当前会话消息(经 `useSessionStream(sessionId)`,返回 `{ messages }`,消息含 `toolCalls?: ToolCallView[]`)。
- Produces:`deriveToolCalls(messages): ToolCallSummary[]`。

- [ ] **Step 1:写纯函数失败单测** — 新建 `apps/web-agent/src/lib/derive-tool-calls.spec.ts`:

```ts
import { deriveToolCalls } from "./derive-tool-calls";

describe("deriveToolCalls", () => {
  it("按消息顺序抽出所有 toolCalls,保留 toolName", () => {
    const msgs = [
      { toolCalls: [{ toolCallId: "a", toolName: "read_logs" }] },
      { toolCalls: undefined },
      { toolCalls: [{ toolCallId: "b", toolName: "grep" }, { toolCallId: "c", toolName: "read_logs" }] },
    ];
    // biome-ignore lint/suspicious/noExplicitAny: 测试构造最小形状
    const out = deriveToolCalls(msgs as any);
    expect(out.map((t) => t.toolCallId)).toEqual(["a", "b", "c"]);
    expect(out.map((t) => t.toolName)).toEqual(["read_logs", "grep", "read_logs"]);
  });
  it("空/无工具消息返回空数组", () => {
    expect(deriveToolCalls([])).toEqual([]);
    // biome-ignore lint/suspicious/noExplicitAny: 测试构造
    expect(deriveToolCalls([{ toolCalls: [] }] as any)).toEqual([]);
  });
});
```

- [ ] **Step 2:跑测确认失败** — Run:`pnpm jest apps/web-agent/src/lib/derive-tool-calls.spec.ts`;Expected:FAIL(未定义)。

- [ ] **Step 3:实现纯函数** — 新建 `apps/web-agent/src/lib/derive-tool-calls.ts`:

```ts
/** 工具调用摘要(右区工具面板用)。 */
export interface ToolCallSummary {
  toolCallId: string;
  toolName: string;
}

/** 最小消息形状:只关心 toolCalls。 */
interface MsgLike {
  toolCalls?: { toolCallId: string; toolName: string }[];
}

/** 按消息顺序展平所有 toolCalls。空/缺省安全。 */
export function deriveToolCalls(messages: MsgLike[]): ToolCallSummary[] {
  const out: ToolCallSummary[] = [];
  for (const m of messages) {
    for (const tc of m.toolCalls ?? []) {
      out.push({ toolCallId: tc.toolCallId, toolName: tc.toolName });
    }
  }
  return out;
}
```

- [ ] **Step 4:跑测确认通过** — Run:`pnpm jest apps/web-agent/src/lib/derive-tool-calls.spec.ts`;Expected:PASS。

- [ ] **Step 5:填实 `ToolsPanel`** — 覆盖 `apps/web-agent/src/components/session/tools-panel.tsx`:

```tsx
"use client";

import { useAtomValue } from "jotai";
import { Wrench } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRef } from "react";
import { currentAssistantSessionIdAtom } from "@/atoms/right-zone";
import { deriveToolCalls } from "@/lib/derive-tool-calls";
import { TOOL_LABELS } from "@/lib/tool-display";
import { useSessionStream } from "@/hooks/use-session-stream";

/** 工具上下文面板:列出当前主助手会话的工具调用。 */
export function ToolsPanel() {
  const t = useTranslations("rightZone");
  const sessionId = useAtomValue(currentAssistantSessionIdAtom);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stream = useSessionStream(sessionId, scrollRef);
  const calls = deriveToolCalls(stream.messages);

  if (!sessionId || calls.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-[12px] text-muted-foreground">
        {t("toolsEmpty")}
      </div>
    );
  }
  return (
    <div ref={scrollRef} className="h-full overflow-y-auto p-3">
      {calls.map((c) => (
        <div
          key={c.toolCallId}
          className="mb-1.5 flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2"
        >
          <Wrench className="h-3.5 w-3.5 shrink-0 text-(--brand)" />
          <span className="truncate text-[12px] text-foreground">
            {TOOL_LABELS[c.toolName] ?? c.toolName}
          </span>
        </div>
      ))}
    </div>
  );
}
```

> 若 `TOOL_LABELS`(`@/lib/tool-display`)导出名不同,读该文件取实际导出(它是工具名→友好中文映射);实在没有映射就直接显示 `c.toolName`。`useSessionStream(sessionId, scrollRef)` 签名与 `AssistantDock` 用法一致(`sessionId` 可为 null)。

- [ ] **Step 6:i18n 加空态** — `zh.json` 的 `rightZone` 加 `"toolsEmpty": "本会话暂无工具调用"`;`en.json` 加 `"toolsEmpty": "No tool calls in this session"`。

- [ ] **Step 7:typecheck + build** — Run:`pnpm --filter @meshbot/web-agent typecheck && pnpm --filter @meshbot/web-agent build`(timeout 600000)。Expected:PASS。

- [ ] **Step 8:提交**

```bash
git add -A
git commit -m "feat(web-agent): 右区工具面板(当前会话工具调用列表)

deriveToolCalls 纯函数(展平消息 toolCalls)+ 单测;ToolsPanel 读当前主会话流、
友好名展示。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4:成员上下文面板(频道成员)

`MembersPanel` 列出当前频道会话的成员。

**Files:** Modify `apps/web-agent/src/components/im/members-panel.tsx`(填实)、`apps/web-agent/messages/{zh,en}.json`。

**Interfaces:** Consumes `currentConversationIdAtom`(`@/atoms/im`)、`listChannelMembers(id): Promise<ChannelMember[]>`(`@/rest/im`)、`ChannelMember`(`@meshbot/types`)。

- [ ] **Step 1:确认 `ChannelMember` 形状** — Run:`grep -n "interface ChannelMember" -A6 libs/types/src/im/im.schema.ts`。记下字段(应含 `userId`/`displayName`/可能 `role`/`online`)。实现里只用确实存在的字段——**不要臆造**。

- [ ] **Step 2:填实 `MembersPanel`** — 覆盖 `apps/web-agent/src/components/im/members-panel.tsx`(以下按常见字段 `userId`/`displayName` 写;若 Step 1 显示字段名不同,按实际改):

```tsx
"use client";

import type { ChannelMember } from "@meshbot/types";
import { useAtomValue } from "jotai";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { currentConversationIdAtom } from "@/atoms/im";
import { listChannelMembers } from "@/rest/im";

/** 成员上下文面板:当前频道成员列表。 */
export function MembersPanel() {
  const t = useTranslations("rightZone");
  const convId = useAtomValue(currentConversationIdAtom);
  const [members, setMembers] = useState<ChannelMember[] | null>(null);

  useEffect(() => {
    if (!convId) {
      setMembers(null);
      return;
    }
    let alive = true;
    listChannelMembers(convId)
      .then((m) => {
        if (alive) setMembers(m);
      })
      .catch(() => {
        if (alive) setMembers([]);
      });
    return () => {
      alive = false;
    };
  }, [convId]);

  if (!convId) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-[12px] text-muted-foreground">
        {t("membersEmpty")}
      </div>
    );
  }
  return (
    <div className="h-full overflow-y-auto p-3">
      {(members ?? []).map((m) => {
        const name = m.displayName ?? m.userId;
        const initial = (name || "?").charAt(0).toUpperCase();
        return (
          <div key={m.userId} className="mb-1 flex items-center gap-2.5 px-1 py-1.5">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-[12px] font-semibold text-foreground">
              {initial}
            </span>
            <span className="truncate text-[13px] text-foreground">{name}</span>
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 3:i18n 加空态** — `zh.json` 的 `rightZone` 加 `"membersEmpty": "在频道会话里查看成员"`;`en.json` 加 `"membersEmpty": "Open a channel to see members"`。

- [ ] **Step 4:typecheck + build(P2b 收口)** — Run:`pnpm --filter @meshbot/web-agent typecheck && pnpm --filter @meshbot/web-agent build`(timeout 600000)。Expected:PASS。

- [ ] **Step 5:提交**

```bash
git add -A
git commit -m "feat(web-agent): 右区成员面板(频道成员列表)

MembersPanel 读当前频道会话成员(listChannelMembers);非频道显示空态。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 收尾:围栏 + 视觉冒烟(必做——右区触及持久壳)

- [ ] **Step 1:全量围栏** — Run:`pnpm typecheck && pnpm check`;Expected:全绿(i18n missing=0)。
- [ ] **Step 2:视觉冒烟(人工,`pnpm dev:server-agent` + `pnpm dev:web-agent`)**:
  - header:各头部一条 52px 带、底边线对齐。
  - 右区 tab 条:顶栏 ✦ 开右区;在助手会话页,tab 条左出「工具」(+「产物」当有产物时),右端钉橙色「随手问」;点工具列出本会话工具调用;点产物看预览;点随手问回随手问对话且能发消息。
  - 频道会话页开右区:左出「成员」tab,列频道成员;随手问仍钉右端可用。
  - 无回归:产物自动打开、随手问流式、面板宽度拖拽仍正常。

---

## Self-Review

**1. Spec/意图覆盖**:52px header 带 ✅(T1)· 右区双层=上下文 tab+钉住随手问 ✅(T2)· 产物(既有并入)/工具(T3,真数据)/成员(T4,真数据)✅ · 文件/置顶无数据留位(Global Constraints 说明)✅ · 随手问保持全局 ✅ · 暖米浅色壳明确不在本期(下一期 A)✅。
**2. 占位符扫描**:无 TBD;新文件给完整代码,edits 给确切定位。已知简化(产物工具条下载/全屏本期从右区头移除、面板宽度统一)已显式记录,非占位。Step 3 的 `require()` 反模式在 Step 4 显式修正为正常 import。
**3. 类型/命名一致**:`RightTab`/`currentAssistantSessionIdAtom`/`effectiveRightTabAtom`/`availableContextTabsAtom`/`deriveToolCalls`/`ToolsPanel`/`MembersPanel`/`rightZone.*` i18n 全 plan 一致;`chromeless` prop 在 AssistantDock 定义(T2-S5)与 RightZone 使用(T2-S3)一致。
**4. 风险**:T2-S6 触及 `(shell)/layout.tsx` 持久壳——收尾强制真启动冒烟。`ChannelMember` 字段以 grep 实证为准(T4-S1),不臆造。`h-13` 若无刻度回退 `h-[52px]`(T1-S1)。

## 关于下一期 A(暖米浅色壳)
P2b 完成后进 A:把深色 `--shell-sidebar`/rail 换成暖米浅色 + 组件卡片化——真正"去 Slack 观感"。另起 plan。
