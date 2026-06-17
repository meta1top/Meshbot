# Phase 3b：IM 伴生 Agent（前端侧栏）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 web-agent 的 IM 会话视图右侧加一个"伴生 Agent 侧栏"，复用助手聊天的完整流式渲染（消息流/工具调用/推理/分块），让用户看到伴生 Agent 的候选回复并继续对话精修，再把选定文本填入 IM 输入框一键发进会话；并提供每会话「Agent 建议」开关。

**Architecture:** 把现在内联在 `session/page.tsx`（600 行）里的会话流式逻辑抽成两个可复用 hook：`useSessionStream(sessionId, scrollRef)`（历史拉取 + socket 订阅 + 13 个 run 事件 → 消息状态 + send/interrupt/loadMore）与 `useChatScroll`（吸底 + 上拉分页的 IntersectionObserver）。助手会话页与新侧栏都消费这两个 hook（行为保持不变，靠手验回归）。新增 `ImCompanionPanel` 复用 `MessageList`/`ChatInput` 指向 Plan 3a 的伴生 sessionId（经新 REST `GET/PUT /api/im/:conversationId/agent-session` 取得），通过 `AppShellLayout` 新增的可选 `rightPanel` 槽渲染。「发送到会话」取最新候选文本填入 IM 主输入框（左栏），复用既有 `im.send` 流程，天然支持编辑。

**Tech Stack:** Next.js（App Router，静态导出）、React、jotai、@tanstack/react-query、socket.io-client、next-intl、Tailwind、Biome；纯函数单测用 Jest（仅 `@meshbot/web-common`，经 `pnpm --filter @meshbot/web-common test`）。

## Global Constraints
- Spec：`docs/superpowers/specs/2026-06-17-phase3-im-companion-agent-design.md`（§6 侧栏 / §7 @检测 / §8 可见性）。后端 Plan 3a 已完成（分支 `feat/im-companion-agent`，REST：`GET /api/im/:conversationId/agent-session` → `{ sessionId, agentEnabled, convType }`；`PUT /api/im/:conversationId/agent-session` body `{ enabled }` → `{ ok: true }`）。
- **绝不自动发 IM**：侧栏产物只是候选；发进 IM 必须用户显式点「发送到会话」（→ 填入 IM 输入框 → 用户按发送）。
- **行为保持**：抽 hook 是纯重构，助手会话页 `/session` 与 IM 页 `/messages`（无侧栏分支）行为必须与重构前完全一致；web-agent 无前端测试设施，回归靠 `pnpm --filter @meshbot/web-agent typecheck` + 手动冒烟。
- **测试策略**：仅对抽出的纯函数（`latestAssistantCandidate`）写 Jest 单测（放 `@meshbot/web-common`）；React 组件/hook 用 typecheck + 手验。**不**为 web-agent 引入测试框架。
- **i18n**：用户可见文案走 next-intl，zh + en 同步加 key（`pnpm check` 含 sync-locales 校验 zh/en 对齐）。复用 `messages` namespace。
- **依赖**：不新增 npm 依赖（「Agent 建议」开关用内联样式按钮，不引第三方 Switch）。
- 公开函数/组件中文 JSDoc；commit 前相关 `pnpm check:*` + `pnpm --filter @meshbot/web-agent typecheck` 通过。
- **不在本计划**：任务面板 MCP（Phase 4）；窄屏折叠（YAGNI，先做宽屏 `xl` 以上显示侧栏）；侧栏内的 pending 编辑/删除 UI（YAGNI，侧栏只「输入精修」，不复刻队列编辑）。

## 文件结构

| 文件 | 职责 | 任务 |
|------|------|------|
| `packages/web-common/src/im/companion.ts` | 纯函数 `latestAssistantCandidate`（选最新可发候选文本） | T1 |
| `packages/web-common/src/im/companion.spec.ts` | 上面纯函数的 Jest 单测 | T1 |
| `packages/web-common/src/index.ts` | 导出新纯函数（改） | T1 |
| `apps/web-agent/src/rest/im-agent.ts` | 伴生会话 REST + react-query hooks | T2 |
| `apps/web-agent/src/hooks/use-session-stream.ts` | 抽出：历史 + socket + run 事件 → 消息状态 + 动作 | T3 |
| `apps/web-agent/src/hooks/use-chat-scroll.ts` | 抽出：吸底 + 上拉分页 IO | T4 |
| `apps/web-agent/src/app/session/page.tsx` | 改为消费上面两个 hook（瘦身，行为不变） | T3, T4 |
| `apps/web-agent/src/components/layouts/app-shell-layout.tsx` | 加可选 `rightPanel` 槽（向后兼容分支） | T5 |
| `apps/web-agent/src/components/im/agent-toggle.tsx` | 「Agent 建议」开关（内联样式按钮） | T6 |
| `apps/web-agent/src/components/im/im-companion-panel.tsx` | 伴生侧栏（复用 MessageList/ChatInput + 两个 hook + REST） | T6 |
| `apps/web-agent/messages/{zh,en}.json` | 侧栏文案 key（改） | T6 |
| `apps/web-agent/src/app/messages/page.tsx` | 接入侧栏：传 conversationId + onUseCandidate；rightPanel 渲染 | T7 |

---

## Task 1: 纯函数 `latestAssistantCandidate`（web-common，TDD）

**Files:**
- Create: `packages/web-common/src/im/companion.ts`
- Test: `packages/web-common/src/im/companion.spec.ts`
- Modify: `packages/web-common/src/index.ts`

**Interfaces:**
- Produces:
  - `interface CandidateMessage { role: "user" | "assistant" | "system"; content: string; streaming?: boolean; loading?: boolean; failed?: boolean }`
  - `latestAssistantCandidate(messages: CandidateMessage[]): string | null` —— 从尾部找第一条「已定稿的 assistant」（role==='assistant' 且非 streaming/loading/failed 且 content.trim() 非空）的 content；无则 null。

- [ ] **Step 1: 写失败测试**

`packages/web-common/src/im/companion.spec.ts`：
```ts
import { type CandidateMessage, latestAssistantCandidate } from "./companion";

const m = (p: Partial<CandidateMessage> & { role: CandidateMessage["role"] }): CandidateMessage => ({
  content: "",
  ...p,
});

describe("latestAssistantCandidate", () => {
  it("空列表返回 null", () => {
    expect(latestAssistantCandidate([])).toBeNull();
  });
  it("取最后一条已定稿 assistant 的 content", () => {
    expect(
      latestAssistantCandidate([
        m({ role: "user", content: "在吗" }),
        m({ role: "assistant", content: "第一版" }),
        m({ role: "user", content: "再改改" }),
        m({ role: "assistant", content: "第二版" }),
      ]),
    ).toBe("第二版");
  });
  it("跳过 streaming / loading / failed / 空内容的 assistant", () => {
    expect(
      latestAssistantCandidate([
        m({ role: "assistant", content: "已定稿" }),
        m({ role: "assistant", content: "流式中", streaming: true }),
        m({ role: "assistant", content: "", loading: true }),
        m({ role: "assistant", content: "失败了", failed: true }),
        m({ role: "assistant", content: "   " }),
      ]),
    ).toBe("已定稿");
  });
  it("只有 user 消息返回 null", () => {
    expect(latestAssistantCandidate([m({ role: "user", content: "x" })])).toBeNull();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @meshbot/web-common test -- companion`
Expected: FAIL（模块未定义）

- [ ] **Step 3: 实现纯函数**

`packages/web-common/src/im/companion.ts`：
```ts
/** 伴生 Agent 侧栏用的最小消息结构（与 web-agent 的 TimelineMessage 结构兼容）。 */
export interface CandidateMessage {
  role: "user" | "assistant" | "system";
  content: string;
  streaming?: boolean;
  loading?: boolean;
  failed?: boolean;
}

/**
 * 选「最新可发的候选回复文本」：从尾部往前找第一条已定稿的 assistant 消息
 * （非流式、非 loading 占位、非失败、内容非空白）的 content；没有则 null。
 * 供侧栏「发送到会话」取候选。
 */
export function latestAssistantCandidate(
  messages: CandidateMessage[],
): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (
      m.role === "assistant" &&
      !m.streaming &&
      !m.loading &&
      !m.failed &&
      m.content.trim() !== ""
    ) {
      return m.content;
    }
  }
  return null;
}
```

- [ ] **Step 4: 导出**

在 `packages/web-common/src/index.ts` 末尾追加（保持文件内导出风格）：
```ts
export { type CandidateMessage, latestAssistantCandidate } from "./im/companion";
```

- [ ] **Step 5: 运行确认通过**

Run: `pnpm --filter @meshbot/web-common test -- companion`
Expected: PASS（4 用例）

- [ ] **Step 6: typecheck + 提交**

Run: `pnpm --filter @meshbot/web-common typecheck`
Expected: PASS
```bash
git add packages/web-common/src/im/companion.ts packages/web-common/src/im/companion.spec.ts packages/web-common/src/index.ts
git commit -m "feat(web-common): latestAssistantCandidate 纯函数 —— 选最新可发候选（TDD）

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: 伴生会话 REST + react-query hooks

**Files:**
- Create: `apps/web-agent/src/rest/im-agent.ts`

**Interfaces:**
- Consumes: `apiClient`（`@meshbot/web-common`）；Plan 3a 的 `GET/PUT /api/im/:conversationId/agent-session`。
- Produces:
  - `interface AgentSession { sessionId: string; agentEnabled: boolean; convType: "channel" | "dm" }`
  - `fetchAgentSession(conversationId: string): Promise<AgentSession>`
  - `setAgentEnabled(conversationId: string, enabled: boolean): Promise<{ ok: true }>`
  - `agentSessionKey(conversationId: string): (string | null)[]`
  - `useAgentSession(conversationId: string | null)` → `UseQueryResult<AgentSession>`
  - `useSetAgentEnabled(conversationId: string)` → mutation（成功后 invalidate `agentSessionKey`）

- [ ] **Step 1: 实现 REST + hooks**

参照 `apps/web-agent/src/rest/model-config.ts`（useQuery/useMutation + invalidateQueries 范式）与 `rest/im.ts`（apiClient.get 范式）。`apps/web-agent/src/rest/im-agent.ts`：
```ts
"use client";

import { apiClient } from "@meshbot/web-common";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

/** 伴生会话信息（Plan 3a 后端返回）。 */
export interface AgentSession {
  sessionId: string;
  agentEnabled: boolean;
  convType: "channel" | "dm";
}

/** 取（或惰性建）某 IM 会话的伴生会话 id + 开关。 */
export async function fetchAgentSession(
  conversationId: string,
): Promise<AgentSession> {
  const { data } = await apiClient.get<AgentSession>(
    `/api/im/${conversationId}/agent-session`,
  );
  return data;
}

/** 切换某 IM 会话伴生 Agent 开关。 */
export async function setAgentEnabled(
  conversationId: string,
  enabled: boolean,
): Promise<{ ok: true }> {
  const { data } = await apiClient.put<{ ok: true }>(
    `/api/im/${conversationId}/agent-session`,
    { enabled },
  );
  return data;
}

/** 伴生会话 query key。 */
export function agentSessionKey(conversationId: string): string[] {
  return ["im-agent-session", conversationId];
}

/** 订阅某会话的伴生会话信息；conversationId 为空时不发请求。 */
export function useAgentSession(conversationId: string | null) {
  return useQuery({
    queryKey: conversationId
      ? agentSessionKey(conversationId)
      : ["im-agent-session", "none"],
    queryFn: () => fetchAgentSession(conversationId as string),
    enabled: !!conversationId,
  });
}

/** 切换伴生 Agent 开关；成功后刷新该会话伴生信息。 */
export function useSetAgentEnabled(conversationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) => setAgentEnabled(conversationId, enabled),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: agentSessionKey(conversationId) });
    },
  });
}
```

- [ ] **Step 2: typecheck + biome**

Run: `pnpm --filter @meshbot/web-agent typecheck && pnpm exec biome check apps/web-agent/src/rest/im-agent.ts`
Expected: PASS / clean

- [ ] **Step 3: Commit**

```bash
git add apps/web-agent/src/rest/im-agent.ts
git commit -m "feat(web-agent): 伴生会话 REST 客户端 + react-query hooks

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: 抽出 `useSessionStream` hook（行为保持重构）

把 `apps/web-agent/src/app/session/page.tsx` 里「历史拉取 + socket 订阅 + 13 个 run 事件 → 消息状态 + send/interrupt/loadMoreHistory」整体搬进新 hook。这是纯移动，不改逻辑；助手会话页改为消费它，行为必须完全一致。

**Files:**
- Create: `apps/web-agent/src/hooks/use-session-stream.ts`
- Modify: `apps/web-agent/src/app/session/page.tsx`

**Interfaces:**
- Consumes: `@/rest/session`（`appendMessage`/`fetchHistory`/`fetchPending`/`deletePendingMessage`）；`@/lib/socket`（`getSessionSocket`）；`@/atoms/session-usage`（`resetUsage`/`setInitialUsage`/`appendUsage`/`appendUsageByMessage` setter atoms）；`SESSION_WS_EVENTS` 与各 run 事件类型（`@meshbot/types-agent`）；`TimelineMessage`（`@/components/session/message-list`）。
- Produces:
```ts
export interface SessionStream {
  /** 全部消息（含 pending 队列）。 */
  messages: TimelineMessage[];
  /** 是否有 run 在跑。 */
  running: boolean;
  /** 压缩进行中：null=未压缩；reason 字符串=压缩中。 */
  compacting: null | "threshold" | "ctx-exceeded";
  /** 还有更早历史可上拉。 */
  hasMoreHistory: boolean;
  /** 单一消息写入口（同步 ref+state），供视图做局部变更（pending 删/改、重生成截断）。 */
  apply: (next: (prev: TimelineMessage[]) => TimelineMessage[]) => void;
  /** 发送一条消息：乐观插 pending user 气泡 + append 到后端。 */
  send: (msg: string) => Promise<void>;
  /** 中断当前 run。 */
  interrupt: () => void;
  /** 上拉加载更早历史（含滚动锚定，需传 scrollContainerRef）。 */
  loadMoreHistory: () => Promise<void>;
}

export function useSessionStream(
  sessionId: string | null,
  scrollContainerRef: React.RefObject<HTMLDivElement | null>,
): SessionStream
```

- [ ] **Step 1: 建 hook 文件，搬入流式逻辑**

新建 `apps/web-agent/src/hooks/use-session-stream.ts`。把 `session/page.tsx` 的以下部分**逐字搬入** hook（仅去掉与"视图/滚动/usage 显示"相关的内容，见下）：
- state/ref：`messages`、`running`、`compacting`、`hasMoreHistory` 及 `messagesRef`、`oldestMessageIdRef`、`hasMoreHistoryRef`、`loadingMoreRef`（源 `page.tsx:65-90` 中对应项；**不搬** `bottomRef`/`topSentinelRef`/`stickToBottom`/`initialScrollDoneRef`/`scrollContainerRef`/`draft`/`chatInputRef`/placeholder 相关 —— 那些是视图/滚动，留页面或进 Task 4）。
- `apply`（源 `page.tsx:116-123`）、`migrateHumanToTimeline`（`132-166`）、`upsertChunk`（`169-190`）。
- 主 `useEffect`（`192-625`）：包含「切 session 重置 → fetchHistory/fetchPending 合并 → getSessionSocket 订阅 13 事件 + compaction 3 事件 → cleanup off/unsubscribe」整段**逐字搬入**。其中 usage 写入（`resetUsage()`/`setInitialUsage(...)`/`appendUsage(e)`/`appendUsageByMessage(...)`）保留在 hook 内（hook 引入这些 setter atoms）。**差异**：原 `if (!sessionId) { router.replace("/assistant"); return; }`（`193-196`）改为 **hook 内 `if (!sessionId) return;`**（不跳转 —— 跳转是视图职责，留在页面；侧栏用 null sessionId 时 hook 须惰性 inert，不订阅不请求）。effect 依赖数组去掉 `router`。
- `handleSend`（`685-700`）→ 改名 `send`，逻辑不变（`crypto.randomUUID` + 乐观插入 + `appendMessage`）。
- `handleInterrupt`（`703-706`）→ 改名 `interrupt`，不变。
- `loadMoreHistory`（`783-825`）逐字搬入；其中 `scrollContainerRef.current` 改读 hook 入参 `scrollContainerRef`（签名已含）。
- 末尾 `return { messages, running, compacting, hasMoreHistory, apply, send, interrupt, loadMoreHistory };`。

hook 顶部导入与文件骨架：
```ts
"use client";

import {
  type RunChunkEvent,
  type RunDoneEvent,
  type RunErrorEvent,
  type RunHumanEvent,
  type RunInterruptedEvent,
  type RunReasoningChunkEvent,
  type RunReasoningDoneEvent,
  type RunToolCallEndEvent,
  type RunToolCallProgressEvent,
  type RunToolCallStartEvent,
  type RunUsageEvent,
  SESSION_WS_EVENTS,
} from "@meshbot/types-agent";
import { useSetAtom } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  appendUsageAtom,
  appendUsageByMessageAtom,
  resetUsageAtom,
  setInitialUsageAtom,
} from "@/atoms/session-usage";
import type { TimelineMessage } from "@/components/session/message-list";
import { getSessionSocket } from "@/lib/socket";
import {
  appendMessage,
  fetchHistory,
  fetchPending,
} from "@/rest/session";

export interface SessionStream {
  /* …如上 Interfaces… */
}

/**
 * 会话流式状态 hook：拉历史 + 订阅 SESSION_WS 事件 → 维护 TimelineMessage 列表、
 * running、compaction、历史分页，并暴露 send/interrupt/loadMoreHistory 与 apply。
 * sessionId 为 null 时惰性 inert（不请求不订阅）—— 供侧栏在伴生会话未就绪时安全挂载。
 */
export function useSessionStream(
  sessionId: string | null,
  scrollContainerRef: React.RefObject<HTMLDivElement | null>,
): SessionStream {
  // …搬入的 state / refs / apply / migrateHumanToTimeline / upsertChunk …
  // …主 useEffect（含 inert guard）…
  // …send / interrupt / loadMoreHistory …
  return { messages, running, compacting, hasMoreHistory, apply, send, interrupt, loadMoreHistory };
}
```
> 注意：`apply` 用 `useCallback([])`；`send`/`loadMoreHistory` 依赖 `sessionId`/`apply` 等，依赖数组照搬原 useCallback 的依赖。usage setter atoms 进主 effect 依赖数组（与原页面一致）。

- [ ] **Step 2: 会话页改为消费 hook**

改 `apps/web-agent/src/app/session/page.tsx`：
- 删除已搬走的 state/ref/`apply`/`migrateHumanToTimeline`/`upsertChunk`/主 effect/`handleSend`/`handleInterrupt`/`loadMoreHistory`。
- 顶部加 `import { useSessionStream } from "@/hooks/use-session-stream";`。
- 在组件内：保留 `scrollContainerRef`、`sessionId`，加 `null` 跳转守卫（视图职责）：
```ts
  const sessionId = searchParams.get("id");
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!sessionId) router.replace("/assistant");
  }, [sessionId, router]);
  const stream = useSessionStream(sessionId, scrollContainerRef);
```
- 用 `stream.messages` 派生 `timelineMessages`/`queuedMessages`（原 `627-634` 的 useMemo，改读 `stream.messages`）。
- `handleSend` → `stream.send`；`handleInterrupt` → `stream.interrupt`；`running` → `stream.running`；`compacting` → `stream.compacting`；`hasMoreHistory` → `stream.hasMoreHistory`。
- `handleDeletePending`/`handleEditPending`/`regenerateOptimisticCut` **留在页面**（它们要 `draft`/`t`/`chatInputRef`/`window.alert`/`window.confirm`，是视图职责），把其中的 `apply(...)` 改为 `stream.apply(...)`，`deletePendingMessage` 仍从 `@/rest/session` 导入。`loadMoreHistory` 调用处改 `stream.loadMoreHistory`。
- JSX 不变（仍渲染 MessageList/PendingList/ChatInput）。滚动相关（`bottomRef`/`topSentinelRef`/`stickToBottom`/两个滚动 effect/初次跳底/滚到底按钮/顶部哨兵 effect）**本任务保持原样留在页面**（Task 4 再抽）。usage 显示（`usageByMessage`/`sessionTotals` 读取 + token ring）保持原样留在页面。

- [ ] **Step 3: typecheck**

Run: `pnpm --filter @meshbot/web-agent typecheck`
Expected: PASS（无类型错误；hook 与页面装配一致）

- [ ] **Step 4: biome**

Run: `pnpm exec biome check apps/web-agent/src/hooks/use-session-stream.ts apps/web-agent/src/app/session/page.tsx`
Expected: clean（如有未用 import 残留，移除）

- [ ] **Step 5: 手动冒烟（行为回归）**

起 `pnpm dev:server-agent` + `pnpm dev:web-agent`，打开一个有历史的会话，确认与重构前一致：① 历史正常加载、上拉加载更早；② 发消息后乐观气泡 → run.human 迁移 → 流式 chunk/推理/工具调用正常渲染；③ 中断、失败重试、压缩 banner 行为不变。**任一不一致即视为重构破坏，回退本任务重做。**

- [ ] **Step 6: Commit**

```bash
git add apps/web-agent/src/hooks/use-session-stream.ts apps/web-agent/src/app/session/page.tsx
git commit -m "refactor(web-agent): 抽 useSessionStream hook（会话流式逻辑，行为保持）

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: 抽出 `useChatScroll` hook（行为保持重构）

把会话页的"吸底自动滚动 + 底部哨兵吸附检测 + 顶部哨兵上拉触发"三段滚动逻辑抽成 hook，供会话页与侧栏共用。

**Files:**
- Create: `apps/web-agent/src/hooks/use-chat-scroll.ts`
- Modify: `apps/web-agent/src/app/session/page.tsx`

**Interfaces:**
- Produces:
```ts
export interface ChatScroll {
  /** 是否吸附底部（决定是否自动跟随流式输出滚到底）。 */
  stickToBottom: boolean;
  /** 立即（instant）滚到底并恢复吸附（「滚到底」按钮用）。 */
  scrollToBottom: () => void;
}

export function useChatScroll(opts: {
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  bottomRef: React.RefObject<HTMLDivElement | null>;
  topSentinelRef: React.RefObject<HTMLDivElement | null>;
  /** 触发自动滚的依赖：可见消息列表（长度/末条变化即跟随）。 */
  messages: unknown[];
  /** 是否还有更早历史（false 时不挂顶部哨兵）。 */
  hasMore: boolean;
  /** 顶部哨兵进入视口时调用（上拉加载更早）。 */
  onLoadMore: () => void;
}): ChatScroll
```

- [ ] **Step 1: 建 hook 文件，搬入滚动逻辑**

新建 `apps/web-agent/src/hooks/use-chat-scroll.ts`。把 `session/page.tsx` 的以下部分搬入：
- `stickToBottom` state（源 `page.tsx:98`）、`initialScrollDoneRef`（`103`）。
- 自动滚 effect（`643-656`）：依赖从 `[timelineMessages, stickToBottom]` 改为 `[opts.messages, stickToBottom]`，refs 改读 `opts.bottomRef`。`timelineMessages.length === 0` 判空改 `opts.messages.length === 0`。
- 底部哨兵吸附 IO effect（`663-676`）：refs 改读 `opts.bottomRef`/`opts.scrollContainerRef`。
- 顶部哨兵上拉 effect（`828-842`）：依赖 `[onLoadMore, hasMore]` → `[opts.onLoadMore, opts.hasMore]`，`hasMoreHistory` 改 `opts.hasMore`，`loadMoreHistory()` 改 `opts.onLoadMore()`，ref 改 `opts.topSentinelRef`。
- `scrollToBottom`：`useCallback(() => { setStickToBottom(true); opts.bottomRef.current?.scrollIntoView({ behavior: "instant" }); }, [opts.bottomRef])`。
- `return { stickToBottom, scrollToBottom };`

骨架：
```ts
"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface ChatScroll {
  stickToBottom: boolean;
  scrollToBottom: () => void;
}

/**
 * 聊天滚动 hook：吸底自动跟随流式输出 + 底部哨兵吸附检测 + 顶部哨兵上拉加载更早。
 * 由调用方提供滚动容器 / 底部哨兵 / 顶部哨兵 refs 与消息依赖。
 */
export function useChatScroll(opts: {
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  bottomRef: React.RefObject<HTMLDivElement | null>;
  topSentinelRef: React.RefObject<HTMLDivElement | null>;
  messages: unknown[];
  hasMore: boolean;
  onLoadMore: () => void;
}): ChatScroll {
  const [stickToBottom, setStickToBottom] = useState(true);
  const initialScrollDoneRef = useRef(false);
  // …三个 effect（搬入）…
  const scrollToBottom = useCallback(() => {
    setStickToBottom(true);
    opts.bottomRef.current?.scrollIntoView({ behavior: "instant" });
  }, [opts.bottomRef]);
  return { stickToBottom, scrollToBottom };
}
```
> 注：原页面切 session 时 `initialScrollDoneRef.current = false`（在 `useSessionStream` 已搬走的主 effect 里）。重构后由 hook 内部管理：把"切会话重置 initialScrollDone"改为依赖 `opts.messages` 变空时复位——简化为 effect 内 `if (opts.messages.length === 0) { initialScrollDoneRef.current = false; return; }`（放自动滚 effect 顶部，等价于原「messages 清空后下次有内容走 instant」）。

- [ ] **Step 2: 会话页消费 useChatScroll**

改 `session/page.tsx`：删除 `stickToBottom`/`initialScrollDoneRef`/三段滚动 effect/`scrollToBottom` 内联逻辑。保留 `bottomRef`/`topSentinelRef`/`scrollContainerRef` 声明。加：
```ts
  const bottomRef = useRef<HTMLDivElement>(null);
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const { stickToBottom, scrollToBottom } = useChatScroll({
    scrollContainerRef,
    bottomRef,
    topSentinelRef,
    messages: timelineMessages,
    hasMore: stream.hasMoreHistory,
    onLoadMore: () => void stream.loadMoreHistory(),
  });
```
- 「滚到底」按钮 onClick 改调 `scrollToBottom()`（原 `907-910` 那段 setStickToBottom + scrollIntoView 替换为 `scrollToBottom()`）。
- JSX 中 `topSentinelRef`/`bottomRef` 绑定不变；`!stickToBottom &&` 显示滚到底按钮不变。

- [ ] **Step 3: typecheck + biome**

Run: `pnpm --filter @meshbot/web-agent typecheck && pnpm exec biome check apps/web-agent/src/hooks/use-chat-scroll.ts apps/web-agent/src/app/session/page.tsx`
Expected: PASS / clean

- [ ] **Step 4: 手动冒烟**

会话页：① 进会话自动跳底（instant，无闪烁）；② 流式输出时自动跟随到底；③ 手动上滚 → 停止跟随 + 出现「滚到底」按钮 → 点击回底；④ 上滚到顶触发加载更早且视口锚定不跳。与重构前一致。

- [ ] **Step 5: Commit**

```bash
git add apps/web-agent/src/hooks/use-chat-scroll.ts apps/web-agent/src/app/session/page.tsx
git commit -m "refactor(web-agent): 抽 useChatScroll hook（吸底+分页滚动，行为保持）

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: `AppShellLayout` 增加可选 `rightPanel` 槽

**Files:**
- Modify: `apps/web-agent/src/components/layouts/app-shell-layout.tsx`

**Interfaces:**
- Produces: `AppShellLayoutProps.rightPanel?: ReactNode` —— 提供时在内容卡右侧渲染一个固定宽列（`xl` 以上显示），主内容区仍是居中滚动列；不提供时布局与现在**逐字一致**。

- [ ] **Step 1: 加 prop + 向后兼容分支**

改 `app-shell-layout.tsx`：`AppShellLayoutProps` 加：
```ts
  /**
   * 右侧并列面板（如 IM 伴生 Agent 侧栏）。提供时内容卡分两列：
   * 左=居中滚动主区，右=固定宽面板（xl 以上显示）；不提供时布局不变。
   */
  rightPanel?: ReactNode;
```
解构入参加 `rightPanel`。把 `{header}` 之后的滚动容器渲染改为**按 `rightPanel` 分支**（无 panel 分支与现状逐字一致）：
```tsx
            {header}
            {rightPanel ? (
              <div className="flex min-h-0 flex-1 flex-row">
                <div
                  ref={scrollContainerRef}
                  className={cn(
                    "flex min-h-0 flex-1 flex-col overflow-y-auto",
                    className,
                  )}
                >
                  <div className="mx-auto flex w-full max-w-[900px] flex-1 flex-col p-4 lg:px-10">
                    {children}
                  </div>
                </div>
                <aside className="hidden w-[420px] shrink-0 flex-col border-l border-border xl:flex">
                  {rightPanel}
                </aside>
              </div>
            ) : (
              <div
                ref={scrollContainerRef}
                className={cn(
                  "flex min-h-0 flex-1 flex-col overflow-y-auto",
                  className,
                )}
              >
                <div className="mx-auto flex w-full max-w-[900px] flex-1 flex-col p-4 lg:px-10">
                  {children}
                </div>
              </div>
            )}
```

- [ ] **Step 2: typecheck + biome**

Run: `pnpm --filter @meshbot/web-agent typecheck && pnpm exec biome check apps/web-agent/src/components/layouts/app-shell-layout.tsx`
Expected: PASS / clean

- [ ] **Step 3: 手动冒烟（无回归）**

不传 `rightPanel` 时 `/session`、`/messages`、`/more`、`/` 各页布局与改前一致（居中、滚动、sticky 输入不变）。

- [ ] **Step 4: Commit**

```bash
git add apps/web-agent/src/components/layouts/app-shell-layout.tsx
git commit -m "feat(web-agent): AppShellLayout 增加可选 rightPanel 槽（向后兼容）

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: `ImCompanionPanel` 侧栏组件 + `AgentToggle` 开关 + i18n

**Files:**
- Create: `apps/web-agent/src/components/im/agent-toggle.tsx`
- Create: `apps/web-agent/src/components/im/im-companion-panel.tsx`
- Modify: `apps/web-agent/messages/zh.json`、`apps/web-agent/messages/en.json`

**Interfaces:**
- Consumes: `useAgentSession`/`useSetAgentEnabled`（T2）；`useSessionStream`（T3）；`useChatScroll`（T4）；`MessageList`、`TimelineMessage`（`@/components/session/message-list`）；`ChatInput`（`@/components/common/chat-input`）；`latestAssistantCandidate`（`@meshbot/web-common`）；`getSessionSocket` 不需要（发消息走 onUseCandidate）。
- Produces:
  - `AgentToggle({ enabled, onToggle, disabled }: { enabled: boolean; onToggle: (next: boolean) => void; disabled?: boolean })`
  - `ImCompanionPanel({ conversationId, onUseCandidate }: { conversationId: string; onUseCandidate: (text: string) => void })`

- [ ] **Step 1: i18n key（zh + en 同步）**

在 `apps/web-agent/messages/zh.json` 的 `messages` namespace 内加：
```json
    "agentPanelTitle": "Agent 助手",
    "agentSuggestion": "Agent 建议",
    "agentOn": "已开启",
    "agentOff": "已关闭",
    "agentSendToConversation": "发送到会话",
    "agentNoCandidate": "暂无可发送的候选回复",
    "agentInputPlaceholder": "和 Agent 继续沟通，精修回复…",
    "agentEmptyHint": "对端消息到达后，Agent 会在这里给出处理建议",
    "agentDisabledHint": "已关闭本会话的 Agent 建议"
```
在 `apps/web-agent/messages/en.json` 的 `messages` namespace 内加对应英文：
```json
    "agentPanelTitle": "Agent",
    "agentSuggestion": "Agent suggestions",
    "agentOn": "On",
    "agentOff": "Off",
    "agentSendToConversation": "Send to conversation",
    "agentNoCandidate": "No candidate reply to send yet",
    "agentInputPlaceholder": "Keep chatting with the agent to refine…",
    "agentEmptyHint": "When a peer message arrives, the agent's suggestion appears here",
    "agentDisabledHint": "Agent suggestions are off for this conversation"
```

- [ ] **Step 2: `AgentToggle`（内联样式开关，不引第三方依赖）**

`apps/web-agent/src/components/im/agent-toggle.tsx`：
```tsx
"use client";

import { cn } from "@meshbot/design";

/** 「Agent 建议」开关：内联样式的小型 toggle（不引第三方 Switch）。 */
export function AgentToggle({
  enabled,
  onToggle,
  disabled,
}: {
  enabled: boolean;
  onToggle: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      disabled={disabled}
      onClick={() => onToggle(!enabled)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50",
        enabled ? "bg-(--shell-accent)" : "bg-muted-foreground/30",
      )}
    >
      <span
        className={cn(
          "inline-block h-4 w-4 transform rounded-full bg-white transition-transform",
          enabled ? "translate-x-4" : "translate-x-0.5",
        )}
      />
    </button>
  );
}
```

- [ ] **Step 3: `ImCompanionPanel`**

`apps/web-agent/src/components/im/im-companion-panel.tsx`。它是一个完整迷你聊天视图（自带滚动容器），用 `useSessionStream(companionSessionId, scrollRef)` + `useChatScroll`，渲染 `MessageList`（指向伴生 sessionId）+ `ChatInput`（精修输入，onSend = stream.send）。顶栏含标题 + `AgentToggle` + 「发送到会话」按钮（取 `latestAssistantCandidate(stream.messages)` → `onUseCandidate`）。
```tsx
"use client";

import { latestAssistantCandidate } from "@meshbot/web-common";
import { useTranslations } from "next-intl";
import { useMemo, useRef, useState } from "react";
import { ChatInput } from "@/components/common/chat-input";
import { MessageList } from "@/components/session/message-list";
import { useChatScroll } from "@/hooks/use-chat-scroll";
import { useSessionStream } from "@/hooks/use-session-stream";
import { useAgentSession, useSetAgentEnabled } from "@/rest/im-agent";

/**
 * IM 伴生 Agent 侧栏：复用助手聊天的流式渲染，指向该会话的伴生 sessionId（Plan 3a）。
 * 展示 Agent 候选回复 / 执行过程，用户可在此继续对话精修；
 * 「发送到会话」取最新候选文本回填 IM 主输入框（左栏），由用户编辑后一键发出。
 * 「Agent 建议」开关切换该会话的伴生触发（默认开）。
 */
export function ImCompanionPanel({
  conversationId,
  onUseCandidate,
}: {
  conversationId: string;
  onUseCandidate: (text: string) => void;
}) {
  const t = useTranslations("messages");
  const { data: agentSession } = useAgentSession(conversationId);
  const toggleMutation = useSetAgentEnabled(conversationId);
  const sessionId = agentSession?.sessionId ?? null;

  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState("");

  const stream = useSessionStream(sessionId, scrollRef);
  const timelineMessages = useMemo(
    () => stream.messages.filter((m) => !m.pending),
    [stream.messages],
  );
  useChatScroll({
    scrollContainerRef: scrollRef,
    bottomRef,
    topSentinelRef,
    messages: timelineMessages,
    hasMore: stream.hasMoreHistory,
    onLoadMore: () => void stream.loadMoreHistory(),
  });

  const candidate = latestAssistantCandidate(stream.messages);
  // 乐观：开关本地态 = mutation variables 优先（点击后立即反映），否则后端值
  const enabled =
    toggleMutation.variables ?? agentSession?.agentEnabled ?? true;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <span className="text-sm font-medium">{t("agentPanelTitle")}</span>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {t("agentSuggestion")}
          </span>
          <AgentToggle
            enabled={enabled}
            disabled={toggleMutation.isPending || !agentSession}
            onToggle={(next) => toggleMutation.mutate(next)}
          />
        </div>
      </div>

      <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3">
        {stream.hasMoreHistory && <div ref={topSentinelRef} className="py-1" />}
        {timelineMessages.length === 0 ? (
          <div className="flex flex-1 items-center justify-center px-4 text-center text-xs text-muted-foreground">
            {enabled ? t("agentEmptyHint") : t("agentDisabledHint")}
          </div>
        ) : (
          <MessageList
            messages={timelineMessages}
            sessionId={sessionId ?? ""}
            running={stream.running}
            onRegenerateOptimisticCut={() => {}}
          />
        )}
        <div ref={bottomRef} />
      </div>

      <div className="border-t border-border p-2">
        <button
          type="button"
          disabled={!candidate}
          onClick={() => candidate && onUseCandidate(candidate)}
          className="mb-2 w-full rounded-md bg-(--shell-accent) px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          title={candidate ? undefined : t("agentNoCandidate")}
        >
          {t("agentSendToConversation")}
        </button>
        <ChatInput
          value={draft}
          onChange={setDraft}
          onSend={(msg) => {
            void stream.send(msg);
            setDraft("");
          }}
          isLoading={stream.running}
          placeholder={t("agentInputPlaceholder")}
        />
      </div>
    </div>
  );
}
```
> 文件顶部还需 `import { AgentToggle } from "@/components/im/agent-toggle";`（与上方 import 合并）。`MessageList` 的 `usageByMessage` 省略（侧栏不展示 token 明细，YAGNI）。`onRegenerateOptimisticCut` 传空函数（侧栏不支持重生成截断，YAGNI）。

- [ ] **Step 4: typecheck + biome + sync-locales**

Run: `pnpm --filter @meshbot/web-agent typecheck`
Expected: PASS
Run: `pnpm exec biome check apps/web-agent/src/components/im/agent-toggle.tsx apps/web-agent/src/components/im/im-companion-panel.tsx`
Expected: clean
Run: `pnpm sync:locales`（`tsx scripts/sync-locales.ts` —— 对齐/规范化 zh/en）
Expected: 无报错；若它改动了 locale 文件（重排/补齐），`git diff apps/web-agent/messages/` 确认仅为本次新增 key 的规范化，纳入提交

- [ ] **Step 5: Commit**

```bash
git add apps/web-agent/src/components/im/agent-toggle.tsx apps/web-agent/src/components/im/im-companion-panel.tsx apps/web-agent/messages/zh.json apps/web-agent/messages/en.json
git commit -m "feat(web-agent): IM 伴生 Agent 侧栏 + 建议开关 + 候选发送（复用会话流式 hook）

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: 接入 messages 页（rightPanel + 候选回填 IM 输入框）

**Files:**
- Modify: `apps/web-agent/src/app/messages/page.tsx`

**Interfaces:**
- Consumes: `ImCompanionPanel`（T6）；`AppShellLayout.rightPanel`（T5）；现有 IM 发送 `handleSend`（emit `IM_WS_EVENTS.send`）。
- Produces: 进入某会话时右侧出现伴生侧栏；侧栏「发送到会话」把候选回填 IM 输入框（左栏 `draft`），用户编辑后按发送即走现有 `im.send`。

- [ ] **Step 1: 传 onUseCandidate + 渲染 rightPanel**

改 `apps/web-agent/src/app/messages/page.tsx`：
- 顶部加 `import { ImCompanionPanel } from "@/components/im/im-companion-panel";`。
- 加候选回填回调（复用已有 `setDraft`/`chatInputRef`）：
```ts
  const useCandidate = useCallback(
    (text: string) => {
      setDraft(text);
      chatInputRef.current?.focus(text);
    },
    [],
  );
```
- `AppShellLayout` 加 `rightPanel`（仅在选中会话时）：
```tsx
    <AppShellLayout
      scrollContainerRef={scrollContainerRef}
      header={id ? <ImConversationHeader /> : undefined}
      rightPanel={
        id ? (
          <ImCompanionPanel conversationId={id} onUseCandidate={useCandidate} />
        ) : undefined
      }
    >
```
- 其余（IM 消息列表、IM 输入框 handleSend）不变。`handleSend` 现有「emit + setDraft("")」保留 —— 用户在回填后编辑再发送，发送后清空。

- [ ] **Step 2: typecheck + biome**

Run: `pnpm --filter @meshbot/web-agent typecheck && pnpm exec biome check apps/web-agent/src/app/messages/page.tsx`
Expected: PASS / clean

- [ ] **Step 3: 端到端手动冒烟**

起 server-main + server-agent + Redis + web-agent，两个账号互发：
1. 私信：账号 B 给 A 发「在吗」→ A 的 `/messages` 右侧侧栏出现伴生会话，Agent 自动跑出候选回复（流式可见）。
2. 在侧栏输入框追问精修 → Agent 多轮回复。
3. 点「发送到会话」→ 候选文本回填左侧 IM 输入框 → 编辑后发送 → B 收到。
4. 关「Agent 建议」开关 → 对端再发消息，侧栏不再自动跑（空态显示「已关闭」提示）；重开恢复。
5. 频道：未 @ 自己不触发；@ 自己触发。
6. `/session` 助手页仍正常（Task 3/4 回归）。

- [ ] **Step 4: Commit**

```bash
git add apps/web-agent/src/app/messages/page.tsx
git commit -m "feat(web-agent): messages 页接入伴生 Agent 侧栏（候选回填 IM 输入框）

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: 全量验证 + 收尾

- [ ] **Step 1: 全量 typecheck**

Run: `pnpm typecheck`
Expected: 全包 PASS

- [ ] **Step 2: 纯函数单测**

Run: `pnpm --filter @meshbot/web-common test`
Expected: PASS（含 companion 4 用例 + 既有 client 测试）

- [ ] **Step 3: 静态围栏全套 + i18n 对齐**

Run: `pnpm check`
Expected: 7 围栏全 0 新增 finding（check:dead 无新死导出等）
Run: `pnpm sync:locales`
Expected: zh/en 已对齐（无未提交改动；若有则为本次 key 规范化，提交之）

- [ ] **Step 4: biome 全量**

Run: `pnpm lint`
Expected: clean（或仅既有 warning）

- [ ] **Step 5: 端到端手动冒烟终检**

复跑 Task 7 Step 3 的 1–6 项全绿（这是前端无自动化测试下的主要验收手段）。

- [ ] **Step 6: 最终 Commit（如有零碎）**

```bash
git add -A && git commit -m "chore(web-agent): Phase 3b 伴生侧栏收尾（typecheck/围栏/i18n）" || echo "无额外改动"
```

---

## 自检记录（spec §6 覆盖）

- 侧栏复用聊天/消息组件指向伴生 sessionId（消息流/输入框/流式渲染）→ T3+T4 抽 hook、T6 面板复用 MessageList/ChatInput ✓
- 按 conversationId 取/建伴生会话（`GET /api/im/:id/agent-session` → sessionId + agentEnabled）→ T2 `useAgentSession` ✓
- 展示候选回复 / 执行过程 + 侧栏继续对话精修 → T6 面板（stream.send + MessageList 流式）✓
- 「发送到会话」按钮：取最新候选（可编辑）→ 经现有 im.send → T1 `latestAssistantCandidate` + T6 按钮 + T7 回填 IM 输入框（编辑后走 handleSend → im.send）✓
- 「Agent 建议」开关（`PUT /api/im/:id/agent-session`，默认开）→ T2 `useSetAgentEnabled` + T6 `AgentToggle` ✓
- 不改 IM 主消息流 UI；侧栏是并列新增面板（宽屏显示）→ T5 `rightPanel` 槽（xl 以上）+ T7 接入 ✓
- 绝不自动发 IM → 全程候选只填输入框，发送需用户点击 ✓
- 窄屏折叠 / token 明细 / 侧栏 pending 编辑 → YAGNI，不在本计划 ✓
- 任务面板 MCP → Phase 4，不在本计划 ✓
