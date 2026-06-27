# Agent 感知前端状态（UI-Context Awareness）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用户在桌面端任意页面问助手时，前端把当前 UI 状态拼成隐藏的 `<llmuse>…</llmuse>` 块前置进消息（UI 隐藏、LLM 可见），并给 agent 三个只读 IM 工具按需拉取频道/私聊记录、未读概览、成员。

**Architecture:** 方案 A——`<llmuse>` 块是用户消息 content 的一部分（前端组装、前端按语法剥离、存进 `session_messages` + 喂 graph）。系统提示加一段始终在场的 `LLMUSE_GUIDE` 解释该块语义。IM 工具守 libs/agent 框架无关边界：libs/agent 定义 `IM_CONTEXT_PORT` 端口，server-agent 用 `CloudImService` 绑定。

**Tech Stack:** TypeScript / NestJS（server-agent）/ LangGraph（libs/agent）/ Next.js + Jotai（web-agent）/ Zod / jest（types-agent + web-agent `.ts` 单测）/ vitest（libs/agent）。

## Global Constraints

- libs/agent 框架无关：只允许 `@Injectable()` + 生命周期钩子；禁止 `@InjectRepository` / `@Entity` / `@Controller` / NestJS HTTP / TypeORM 装饰器。I/O 经端口注入。
- libs/types-* 禁止依赖 NestJS / TypeORM（纯 Zod / TS）。
- 公开方法写中文 JSDoc。
- 不在 `if` 前一行放注释（Biome 会破坏结构）。
- 提交信息用中文 + conventional commits；commit 前跑 `pnpm check`。
- 块边界：**只对「用户→助手」轮次**注入 `<llmuse>`；IM 频道发给同事的消息（`im.send`）绝不注入。
- 本期 IM 工具**只读**（无 `im_send_message`）。
- 工具账号作用域不变量：所有 IM 工具经 `AccountContextService.getOrThrow()` 守账号隔离（由 `CloudImService.withToken` 保证）。
- 标签字面量单一来源：`libs/types-agent` 的 `LLMUSE_OPEN`/`LLMUSE_CLOSE`，前端组装/剥离与系统提示三处共用。

---

## File Structure

**新建：**
- `libs/types-agent/src/llmuse.ts` — `<llmuse>` 标签常量 + 纯 `stripLlmuse()`。
- `libs/types-agent/src/llmuse.spec.ts` — 上面的 jest 单测。
- `libs/types-agent/src/im-tools.ts` — 三个 IM 工具的 Zod 入参 schema。
- `libs/types-agent/src/im-tools.spec.ts` — schema jest 单测。
- `apps/web-agent/src/lib/llmuse.ts` — 前端纯函数：`describeRoute()` + `formatLlmuseBlock()`。
- `apps/web-agent/src/lib/llmuse.test.ts` — 前端纯函数 jest 单测。
- `apps/web-agent/src/hooks/use-llmuse-prefix.ts` — 读路由 + 会话 atom，返回 `prefix(text)` 的 hook。
- `libs/agent/src/tools/im-context.port.ts` — `IM_CONTEXT_PORT` 端口接口。
- `libs/agent/src/tools/builtins/im-unread-overview.tool.ts` — 未读概览工具。
- `libs/agent/src/tools/builtins/im-read-conversation.tool.ts` — 读会话记录工具。
- `libs/agent/src/tools/builtins/im-list-members.tool.ts` — 频道成员工具。
- `libs/agent/tests/unit/im-tools.test.ts` — 三个工具的 vitest 单测。
- `libs/agent/src/prompt/llmuse-guide.ts` — 始终在场的 `LLMUSE_GUIDE` 系统说明常量。
- `apps/server-agent/src/im-context.module.ts` — `@Global` 绑定 `IM_CONTEXT_PORT`（含可单测的 `createImContextPort`）。
- `apps/server-agent/src/im-context.module.spec.ts` — `createImContextPort` 适配器 jest 单测。

**修改：**
- `libs/types-agent/src/index.ts` — re-export `./llmuse`、`./im-tools`。
- `libs/agent/src/index.ts` — re-export `./tools/im-context.port`。
- `libs/agent/src/agent.module.ts` — providers 注册三个 IM 工具。
- `libs/agent/src/graph/graph-runner.service.ts:255-260` — systemPrompt 数组加 `LLMUSE_GUIDE`。
- `libs/agent/tests/unit/context-builder.test.ts` — 加首轮系统提示含 `<llmuse>` 说明的断言。
- `apps/web-agent/src/components/session/message-list.tsx:170-173` — 渲染前 `stripLlmuse(m.content)`。
- `apps/web-agent/src/components/im/assistant-dock.tsx:88-101` — `handleSend` 前置 prefix。
- `apps/web-agent/src/components/session/assistant-conversation-body.tsx:219` — `onSend` 前置 prefix。
- `apps/web-agent/src/app/assistant/page.tsx:54` — `createSession` 前置 prefix。
- `apps/web-agent/src/components/im/new-message-view.tsx:56` — 助手分支 `createSession` 前置 prefix。
- `apps/server-agent/src/im.module.ts:27-28` — 导出 `CloudImService`。
- `apps/server-agent/src/app.module.ts` — imports 注册 `ImContextModule`。

---

## Task 1: 共享 `<llmuse>` 语法（types-agent 常量 + stripLlmuse）

**Files:**
- Create: `libs/types-agent/src/llmuse.ts`
- Test: `libs/types-agent/src/llmuse.spec.ts`
- Modify: `libs/types-agent/src/index.ts`

**Interfaces:**
- Produces: `LLMUSE_OPEN = "<llmuse>"`, `LLMUSE_CLOSE = "</llmuse>"`, `stripLlmuse(content: string): string`（移除所有 `<llmuse>…</llmuse>` 块及其后紧邻换行，再 `trimStart`）。

- [ ] **Step 1: 写失败单测**

创建 `libs/types-agent/src/llmuse.spec.ts`：

```ts
import { describe, expect, it } from "@jest/globals";
import { LLMUSE_CLOSE, LLMUSE_OPEN, stripLlmuse } from "./llmuse";

describe("stripLlmuse", () => {
  it("剥离前置块 + 紧邻换行，保留用户原文", () => {
    const raw = `${LLMUSE_OPEN}\n页面: 消息\n${LLMUSE_CLOSE}\n帮我看一下`;
    expect(stripLlmuse(raw)).toBe("帮我看一下");
  });

  it("无块时原样返回", () => {
    expect(stripLlmuse("普通消息")).toBe("普通消息");
  });

  it("剥离多个块", () => {
    const raw = `${LLMUSE_OPEN}a${LLMUSE_CLOSE}\n${LLMUSE_OPEN}b${LLMUSE_CLOSE}\n正文`;
    expect(stripLlmuse(raw)).toBe("正文");
  });

  it("未闭合标签不误伤正文（无闭合即不剥离）", () => {
    const raw = `${LLMUSE_OPEN}没有闭合的正文`;
    expect(stripLlmuse(raw)).toBe(`${LLMUSE_OPEN}没有闭合的正文`);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test -- libs/types-agent/src/llmuse.spec.ts`
Expected: FAIL —— `Cannot find module './llmuse'`。

- [ ] **Step 3: 实现**

创建 `libs/types-agent/src/llmuse.ts`：

```ts
/** `<llmuse>` 隐藏块的开/闭标签（前端组装/剥离 + 系统提示三处共用的单一来源）。 */
export const LLMUSE_OPEN = "<llmuse>";
export const LLMUSE_CLOSE = "</llmuse>";

const LLMUSE_BLOCK_RE = /<llmuse>[\s\S]*?<\/llmuse>\n*/g;

/**
 * 剥离消息文本里所有 `<llmuse>…</llmuse>` 块（及块后紧邻换行），返回用户可见正文。
 *
 * 用于前端渲染助手会话消息时隐藏该块。未闭合标签不匹配，原样保留，避免误伤正文。
 */
export function stripLlmuse(content: string): string {
  return content.replace(LLMUSE_BLOCK_RE, "").trimStart();
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test -- libs/types-agent/src/llmuse.spec.ts`
Expected: PASS（4 个用例）。

- [ ] **Step 5: 导出**

在 `libs/types-agent/src/index.ts` 现有 `export * from "./quick-assistant";` 同处追加：

```ts
export * from "./llmuse";
```

- [ ] **Step 6: typecheck + 提交**

```bash
pnpm turbo typecheck --filter=@meshbot/types-agent
git add libs/types-agent/src/llmuse.ts libs/types-agent/src/llmuse.spec.ts libs/types-agent/src/index.ts
git commit -m "feat(types-agent): <llmuse> 标签常量 + stripLlmuse 纯函数"
```

---

## Task 2: 前端块格式化（describeRoute + formatLlmuseBlock 纯函数）

**Files:**
- Create: `apps/web-agent/src/lib/llmuse.ts`
- Test: `apps/web-agent/src/lib/llmuse.test.ts`

**Interfaces:**
- Consumes: `LLMUSE_OPEN` / `LLMUSE_CLOSE`（Task 1）。
- Produces:
  - `type LlmuseConversation = { id: string; type: "channel" | "dm"; name: string; unread: number }`
  - `describeRoute(pathname: string, isAssistant: boolean): string`（返回人类可读页面名）
  - `formatLlmuseBlock(ctx: { pageLabel: string; conversation: LlmuseConversation | null }): string`（返回完整 `<llmuse>…</llmuse>` 块字符串，末尾无换行）

- [ ] **Step 1: 写失败单测**

创建 `apps/web-agent/src/lib/llmuse.test.ts`：

```ts
import { describe, expect, it } from "@jest/globals";
import { describeRoute, formatLlmuseBlock } from "./llmuse";

describe("describeRoute", () => {
  it("助手会话页", () => {
    expect(describeRoute("/messages", true)).toBe("助手会话");
  });
  it("消息页", () => {
    expect(describeRoute("/messages", false)).toBe("消息");
  });
  it("日程页", () => {
    expect(describeRoute("/schedule", false)).toBe("日程");
  });
  it("未知页回退路径", () => {
    expect(describeRoute("/foo", false)).toBe("/foo");
  });
});

describe("formatLlmuseBlock", () => {
  it("含会话上下文", () => {
    const block = formatLlmuseBlock({
      pageLabel: "消息",
      conversation: { id: "321", type: "channel", name: "产品研发", unread: 5 },
    });
    expect(block).toContain("<llmuse>");
    expect(block).toContain("页面: 消息");
    expect(block).toContain("会话: 产品研发 (channel, id=321), 未读 5");
    expect(block).toContain("</llmuse>");
  });
  it("无会话只放页面行", () => {
    const block = formatLlmuseBlock({ pageLabel: "日程", conversation: null });
    expect(block).toContain("页面: 日程");
    expect(block).not.toContain("会话:");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test -- apps/web-agent/src/lib/llmuse.test.ts`
Expected: FAIL —— `Cannot find module './llmuse'`。

- [ ] **Step 3: 实现**

创建 `apps/web-agent/src/lib/llmuse.ts`：

```ts
import { LLMUSE_CLOSE, LLMUSE_OPEN } from "@meshbot/types-agent";

/** `<llmuse>` 块里描述的当前会话上下文（频道/私聊）。 */
export interface LlmuseConversation {
  id: string;
  type: "channel" | "dm";
  name: string;
  unread: number;
}

/** 路由 → 人类可读页面名。未知路径回退原始 pathname。 */
export function describeRoute(pathname: string, isAssistant: boolean): string {
  if (pathname.startsWith("/messages"))
    return isAssistant ? "助手会话" : "消息";
  if (pathname.startsWith("/schedule")) return "日程";
  if (pathname.startsWith("/skills")) return "技能";
  if (pathname.startsWith("/settings")) return "设置";
  if (pathname.startsWith("/more")) return "更多";
  return pathname;
}

/** 组装隐藏 `<llmuse>` 块：页面行 + 可选会话行。末尾不带换行（拼接方负责）。 */
export function formatLlmuseBlock(ctx: {
  pageLabel: string;
  conversation: LlmuseConversation | null;
}): string {
  const lines = [`页面: ${ctx.pageLabel}`];
  if (ctx.conversation) {
    const c = ctx.conversation;
    lines.push(`会话: ${c.name} (${c.type}, id=${c.id}), 未读 ${c.unread}`);
  }
  return `${LLMUSE_OPEN}\n${lines.join("\n")}\n${LLMUSE_CLOSE}`;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test -- apps/web-agent/src/lib/llmuse.test.ts`
Expected: PASS（6 个用例）。

- [ ] **Step 5: 提交**

```bash
pnpm turbo typecheck --filter=@meshbot/web-agent
git add apps/web-agent/src/lib/llmuse.ts apps/web-agent/src/lib/llmuse.test.ts
git commit -m "feat(web-agent): formatLlmuseBlock/describeRoute 纯函数"
```

---

## Task 3: 前端 prefix hook + 接入所有助手发送入口

**Files:**
- Create: `apps/web-agent/src/hooks/use-llmuse-prefix.ts`
- Modify: `apps/web-agent/src/components/im/assistant-dock.tsx`
- Modify: `apps/web-agent/src/components/session/assistant-conversation-body.tsx`
- Modify: `apps/web-agent/src/app/assistant/page.tsx`
- Modify: `apps/web-agent/src/components/im/new-message-view.tsx`

**Interfaces:**
- Consumes: `describeRoute` / `formatLlmuseBlock`（Task 2）、`currentConversationAtom`（`apps/web-agent/src/atoms/im.ts`）、`ConversationSummary`（`@meshbot/types`）。
- Produces: `useLlmusePrefix(): (text: string) => string`（把当前 UI 状态块前置到 text；无可用上下文时原样返回 text）。

- [ ] **Step 1: 实现 hook**

创建 `apps/web-agent/src/hooks/use-llmuse-prefix.ts`：

```ts
"use client";

import { useAtomValue } from "jotai";
import { usePathname, useSearchParams } from "next/navigation";
import { useCallback } from "react";
import { currentConversationAtom } from "@/atoms/im";
import {
  describeRoute,
  formatLlmuseBlock,
  type LlmuseConversation,
} from "@/lib/llmuse";

/**
 * 返回一个把当前前端 UI 状态拼成隐藏 `<llmuse>` 块并前置到消息的函数。
 *
 * 读取当前路由（页面）+ 当前打开的会话（频道/私聊及未读），仅用于「用户→助手」发送。
 */
export function useLlmusePrefix(): (text: string) => string {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const isAssistant = searchParams.get("kind") === "assistant";
  const conv = useAtomValue(currentConversationAtom);

  return useCallback(
    (text: string) => {
      const conversation: LlmuseConversation | null = conv
        ? {
            id: conv.id,
            type: conv.type,
            name: conv.name ?? conv.peer?.displayName ?? conv.id,
            unread: conv.unreadCount,
          }
        : null;
      const block = formatLlmuseBlock({
        pageLabel: describeRoute(pathname, isAssistant),
        conversation,
      });
      return `${block}\n${text}`;
    },
    [pathname, isAssistant, conv],
  );
}
```

- [ ] **Step 2: 接入 assistant-dock（一处覆盖 createSession + stream.send 两条路径）**

`apps/web-agent/src/components/im/assistant-dock.tsx`，在组件内取 hook，并在 `handleSend` 顶部统一 prefix。把现有（约 88-101 行）：

```typescript
  const handleSend = useCallback(
    async (body: string) => {
      if (!sessionId) {
        const res = await createSession(body, "quick");
        setSessionId(res.sessionId);
        return;
      }
      await stream.send(body);
    },
    [sessionId, stream, setSessionId],
  );
```

改为：

```typescript
  const prefix = useLlmusePrefix();
  const handleSend = useCallback(
    async (body: string) => {
      const text = prefix(body);
      if (!sessionId) {
        const res = await createSession(text, "quick");
        setSessionId(res.sessionId);
        return;
      }
      await stream.send(text);
    },
    [sessionId, stream, setSessionId, prefix],
  );
```

并在文件顶部 import：`import { useLlmusePrefix } from "@/hooks/use-llmuse-prefix";`

- [ ] **Step 3: 接入 assistant-conversation-body**

`apps/web-agent/src/components/session/assistant-conversation-body.tsx`：组件内加 `const prefix = useLlmusePrefix();`，把第 219 行 `onSend={stream.send}` 改为：

```tsx
          onSend={(t) => stream.send(prefix(t))}
```

顶部 import：`import { useLlmusePrefix } from "@/hooks/use-llmuse-prefix";`

- [ ] **Step 4: 接入 assistant/page.tsx（新建主会话首条）**

`apps/web-agent/src/app/assistant/page.tsx`：组件内加 `const prefix = useLlmusePrefix();`，把第 54 行 `const { sessionId, session } = await createSession(msg);` 改为：

```tsx
      const { sessionId, session } = await createSession(prefix(msg));
```

顶部 import：`import { useLlmusePrefix } from "@/hooks/use-llmuse-prefix";`

- [ ] **Step 5: 接入 new-message-view（仅助手分支）**

`apps/web-agent/src/components/im/new-message-view.tsx`：组件内加 `const prefix = useLlmusePrefix();`，把第 56 行 `const res = await createSession(body);` 改为：

```tsx
      const res = await createSession(prefix(body));
```

（**注意**：本文件中 `getEventsSocket().emit(IM_WS_EVENTS.send, …)` 的两处 IM 发送分支**不要**加 prefix——那是发给同事的消息。）

顶部 import：`import { useLlmusePrefix } from "@/hooks/use-llmuse-prefix";`

- [ ] **Step 6: typecheck + 提交**

Run: `pnpm turbo typecheck --filter=@meshbot/web-agent`
Expected: PASS（无类型错误）。

```bash
git add apps/web-agent/src/hooks/use-llmuse-prefix.ts apps/web-agent/src/components/im/assistant-dock.tsx apps/web-agent/src/components/session/assistant-conversation-body.tsx apps/web-agent/src/app/assistant/page.tsx apps/web-agent/src/components/im/new-message-view.tsx
git commit -m "feat(web-agent): 用户→助手消息前置 <llmuse> UI 状态块"
```

---

## Task 4: 前端渲染时剥离 `<llmuse>` 块

**Files:**
- Modify: `apps/web-agent/src/components/session/message-list.tsx`

**Interfaces:**
- Consumes: `stripLlmuse`（Task 1，从 `@meshbot/types-agent`）。

> MessageList 同时被主助手会话视图与随手问 dock 复用，改这一处即覆盖两者。

- [ ] **Step 1: 改渲染**

`apps/web-agent/src/components/session/message-list.tsx`，把第 170-173 行：

```tsx
                  <MarkdownContent
                    text={m.content}
                    streaming={m.role === "assistant" && m.streaming}
                  />
```

改为：

```tsx
                  <MarkdownContent
                    text={stripLlmuse(m.content)}
                    streaming={m.role === "assistant" && m.streaming}
                  />
```

顶部 import：`import { stripLlmuse } from "@meshbot/types-agent";`

- [ ] **Step 2: typecheck + 提交**

Run: `pnpm turbo typecheck --filter=@meshbot/web-agent`
Expected: PASS。

```bash
git add apps/web-agent/src/components/session/message-list.tsx
git commit -m "feat(web-agent): 助手消息渲染剥离 <llmuse> 块"
```

---

## Task 5: types-agent —— IM 工具入参 schema

**Files:**
- Create: `libs/types-agent/src/im-tools.ts`
- Test: `libs/types-agent/src/im-tools.spec.ts`
- Modify: `libs/types-agent/src/index.ts`

**Interfaces:**
- Produces:
  - `imReadConversationSchema` → `{ conversationId: string; limit?: number; before?: string }`
  - `imListMembersSchema` → `{ conversationId: string }`
  - `imUnreadOverviewSchema` → `{}`（无参）
  - 对应 `ImReadConversationInput` / `ImListMembersInput` 类型。

- [ ] **Step 1: 写失败单测**

创建 `libs/types-agent/src/im-tools.spec.ts`：

```ts
import { describe, expect, it } from "@jest/globals";
import {
  imListMembersSchema,
  imReadConversationSchema,
  imUnreadOverviewSchema,
} from "./im-tools";

describe("im-tools schema", () => {
  it("readConversation 必填 conversationId，limit 可选正整数", () => {
    expect(imReadConversationSchema.parse({ conversationId: "1" })).toEqual({
      conversationId: "1",
    });
    expect(
      imReadConversationSchema.parse({ conversationId: "1", limit: 20 }).limit,
    ).toBe(20);
    expect(() => imReadConversationSchema.parse({})).toThrow();
    expect(() =>
      imReadConversationSchema.parse({ conversationId: "1", limit: 0 }),
    ).toThrow();
  });

  it("listMembers 必填 conversationId", () => {
    expect(imListMembersSchema.parse({ conversationId: "1" })).toEqual({
      conversationId: "1",
    });
    expect(() => imListMembersSchema.parse({})).toThrow();
  });

  it("unreadOverview 无参", () => {
    expect(imUnreadOverviewSchema.parse({})).toEqual({});
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test -- libs/types-agent/src/im-tools.spec.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

创建 `libs/types-agent/src/im-tools.ts`：

```ts
import { z } from "zod";

/** im_read_conversation 入参。 */
export const imReadConversationSchema = z.object({
  conversationId: z.string().min(1),
  limit: z.number().int().positive().max(100).optional(),
  before: z.string().optional(),
});
export type ImReadConversationInput = z.infer<typeof imReadConversationSchema>;

/** im_list_members 入参。 */
export const imListMembersSchema = z.object({
  conversationId: z.string().min(1),
});
export type ImListMembersInput = z.infer<typeof imListMembersSchema>;

/** im_unread_overview 入参（无参）。 */
export const imUnreadOverviewSchema = z.object({});
export type ImUnreadOverviewInput = z.infer<typeof imUnreadOverviewSchema>;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test -- libs/types-agent/src/im-tools.spec.ts`
Expected: PASS。

- [ ] **Step 5: 导出 + 提交**

在 `libs/types-agent/src/index.ts` 追加：

```ts
export * from "./im-tools";
```

```bash
pnpm turbo typecheck --filter=@meshbot/types-agent
git add libs/types-agent/src/im-tools.ts libs/types-agent/src/im-tools.spec.ts libs/types-agent/src/index.ts
git commit -m "feat(types-agent): IM 工具入参 schema"
```

---

## Task 6: libs/agent —— IM_CONTEXT_PORT 端口

**Files:**
- Create: `libs/agent/src/tools/im-context.port.ts`
- Modify: `libs/agent/src/index.ts`

**Interfaces:**
- Produces:
  - `IM_CONTEXT_PORT: symbol`
  - `interface ImContextPort { unreadOverview(): Promise<string>; readConversation(conversationId: string, opts?: { limit?: number; before?: string }): Promise<string>; listMembers(conversationId: string): Promise<string>; }`
  - 端口方法返回**已序列化的 string**，使 libs/agent 不依赖 IM schema（格式化在 server-agent 实现方）。

- [ ] **Step 1: 实现端口**

创建 `libs/agent/src/tools/im-context.port.ts`：

```ts
/**
 * IM_CONTEXT_PORT —— libs/agent → server-agent 解耦端口。
 *
 * IM 工具不直接依赖 server-agent 的 CloudImService / IM schema，而是经此端口取数：
 * server-agent 用 CloudImService 实现并绑定（格式化为紧凑 JSON 字符串）。
 * 无 server-agent 环境（测试）可不注入。
 */
export const IM_CONTEXT_PORT = Symbol("IM_CONTEXT_PORT");

/** IM 上下文只读端口；返回已序列化 JSON 字符串（直接作 ToolMessage 内容）。 */
export interface ImContextPort {
  /** 所有会话 + 未读概览。 */
  unreadOverview(): Promise<string>;
  /** 某频道/私聊的历史消息（limit 默认实现方决定）。 */
  readConversation(
    conversationId: string,
    opts?: { limit?: number; before?: string },
  ): Promise<string>;
  /** 频道成员列表。 */
  listMembers(conversationId: string): Promise<string>;
}
```

- [ ] **Step 2: 导出**

在 `libs/agent/src/index.ts` 现有端口导出处（如 `export * from "./tools/quick-assistant.port";` 旁）追加：

```ts
export * from "./tools/im-context.port";
```

> 若 `index.ts` 用具名 re-export 而非 `export *`，则按其风格补 `IM_CONTEXT_PORT` 与 `ImContextPort`。先 `rg -n "quick-assistant.port" libs/agent/src/index.ts` 确认风格。

- [ ] **Step 3: typecheck + 提交**

```bash
pnpm turbo typecheck --filter=@meshbot/agent
git add libs/agent/src/tools/im-context.port.ts libs/agent/src/index.ts
git commit -m "feat(agent): IM_CONTEXT_PORT 只读端口"
```

---

## Task 7: libs/agent —— 三个 IM 工具 + 注册

**Files:**
- Create: `libs/agent/src/tools/builtins/im-unread-overview.tool.ts`
- Create: `libs/agent/src/tools/builtins/im-read-conversation.tool.ts`
- Create: `libs/agent/src/tools/builtins/im-list-members.tool.ts`
- Test: `libs/agent/tests/unit/im-tools.test.ts`
- Modify: `libs/agent/src/agent.module.ts`

**Interfaces:**
- Consumes: `IM_CONTEXT_PORT` / `ImContextPort`（Task 6）、`imReadConversationSchema` 等（Task 5）、`MeshbotTool` / `ToolContext`（`../tool.types`）、`@Tool`（`../tool.decorator`）。
- Produces: 工具名 `im_unread_overview` / `im_read_conversation` / `im_list_members`。

- [ ] **Step 1: 写失败单测**

创建 `libs/agent/tests/unit/im-tools.test.ts`：

```ts
import { describe, expect, it, vi } from "vitest";
import type { ImContextPort } from "../../src/tools/im-context.port";
import { ImListMembersTool } from "../../src/tools/builtins/im-list-members.tool";
import { ImReadConversationTool } from "../../src/tools/builtins/im-read-conversation.tool";
import { ImUnreadOverviewTool } from "../../src/tools/builtins/im-unread-overview.tool";

const ctx = {} as never;

function makePort(): ImContextPort {
  return {
    unreadOverview: vi.fn().mockResolvedValue("[overview]"),
    readConversation: vi.fn().mockResolvedValue("[msgs]"),
    listMembers: vi.fn().mockResolvedValue("[members]"),
  };
}

describe("IM tools", () => {
  it("im_unread_overview 调端口 unreadOverview 并原样返回", async () => {
    const port = makePort();
    const tool = new ImUnreadOverviewTool(port);
    expect(tool.name).toBe("im_unread_overview");
    expect(await tool.execute({}, ctx)).toBe("[overview]");
    expect(port.unreadOverview).toHaveBeenCalledOnce();
  });

  it("im_read_conversation 透传 conversationId + limit/before", async () => {
    const port = makePort();
    const tool = new ImReadConversationTool(port);
    expect(tool.name).toBe("im_read_conversation");
    const out = await tool.execute(
      { conversationId: "321", limit: 20 },
      ctx,
    );
    expect(out).toBe("[msgs]");
    expect(port.readConversation).toHaveBeenCalledWith("321", {
      limit: 20,
      before: undefined,
    });
  });

  it("im_list_members 透传 conversationId", async () => {
    const port = makePort();
    const tool = new ImListMembersTool(port);
    expect(tool.name).toBe("im_list_members");
    expect(await tool.execute({ conversationId: "321" }, ctx)).toBe(
      "[members]",
    );
    expect(port.listMembers).toHaveBeenCalledWith("321");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd libs/agent && npx vitest run tests/unit/im-tools.test.ts`
Expected: FAIL —— 工具模块不存在。

- [ ] **Step 3: 实现三个工具**

创建 `libs/agent/src/tools/builtins/im-unread-overview.tool.ts`：

```ts
import { imUnreadOverviewSchema } from "@meshbot/types-agent";
import { Inject } from "@nestjs/common";
import { IM_CONTEXT_PORT, type ImContextPort } from "../im-context.port";
import { Tool } from "../tool.decorator";
import type { MeshbotTool, ToolContext } from "../tool.types";

@Tool()
export class ImUnreadOverviewTool
  implements MeshbotTool<Record<string, never>, string>
{
  readonly name = "im_unread_overview";
  readonly description =
    "List all the user's IM conversations (channels + DMs) with their unread counts. " +
    "Use when the user asks what is unhandled / how many unread messages they have.";
  readonly schema = imUnreadOverviewSchema;

  constructor(
    @Inject(IM_CONTEXT_PORT) private readonly port: ImContextPort,
  ) {}

  /** 返回所有会话 + 未读概览（JSON 字符串）。 */
  execute(_args: Record<string, never>, _ctx: ToolContext): Promise<string> {
    return this.port.unreadOverview();
  }
}
```

创建 `libs/agent/src/tools/builtins/im-read-conversation.tool.ts`：

```ts
import {
  type ImReadConversationInput,
  imReadConversationSchema,
} from "@meshbot/types-agent";
import { Inject } from "@nestjs/common";
import { IM_CONTEXT_PORT, type ImContextPort } from "../im-context.port";
import { Tool } from "../tool.decorator";
import type { MeshbotTool, ToolContext } from "../tool.types";

@Tool()
export class ImReadConversationTool
  implements MeshbotTool<ImReadConversationInput, string>
{
  readonly name = "im_read_conversation";
  readonly description =
    "Read recent messages of a specific IM channel or DM by conversationId " +
    "(the `id` shown in the <llmuse> context or page URL). " +
    "Optional `limit` (max 100) and `before` (message-id cursor for older pages).";
  readonly schema = imReadConversationSchema;

  constructor(
    @Inject(IM_CONTEXT_PORT) private readonly port: ImContextPort,
  ) {}

  /** 拉某会话历史消息（JSON 字符串）。 */
  execute(args: ImReadConversationInput, _ctx: ToolContext): Promise<string> {
    return this.port.readConversation(args.conversationId, {
      limit: args.limit,
      before: args.before,
    });
  }
}
```

创建 `libs/agent/src/tools/builtins/im-list-members.tool.ts`：

```ts
import {
  type ImListMembersInput,
  imListMembersSchema,
} from "@meshbot/types-agent";
import { Inject } from "@nestjs/common";
import { IM_CONTEXT_PORT, type ImContextPort } from "../im-context.port";
import { Tool } from "../tool.decorator";
import type { MeshbotTool, ToolContext } from "../tool.types";

@Tool()
export class ImListMembersTool
  implements MeshbotTool<ImListMembersInput, string>
{
  readonly name = "im_list_members";
  readonly description =
    "List the members of an IM channel by conversationId. " +
    "Use to find out who a colleague is in the current channel.";
  readonly schema = imListMembersSchema;

  constructor(
    @Inject(IM_CONTEXT_PORT) private readonly port: ImContextPort,
  ) {}

  /** 拉频道成员（JSON 字符串）。 */
  execute(args: ImListMembersInput, _ctx: ToolContext): Promise<string> {
    return this.port.listMembers(args.conversationId);
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd libs/agent && npx vitest run tests/unit/im-tools.test.ts`
Expected: PASS（3 个用例）。

- [ ] **Step 5: 注册到 AgentModule**

`libs/agent/src/agent.module.ts`：顶部加 import：

```ts
import { ImUnreadOverviewTool } from "./tools/builtins/im-unread-overview.tool";
import { ImReadConversationTool } from "./tools/builtins/im-read-conversation.tool";
import { ImListMembersTool } from "./tools/builtins/im-list-members.tool";
```

在 `providers` 数组里 `RenameQuickAssistantTool,` 之后加：

```ts
    ImUnreadOverviewTool,
    ImReadConversationTool,
    ImListMembersTool,
```

- [ ] **Step 6: typecheck + 提交**

```bash
pnpm turbo typecheck --filter=@meshbot/agent
git add libs/agent/src/tools/builtins/im-unread-overview.tool.ts libs/agent/src/tools/builtins/im-read-conversation.tool.ts libs/agent/src/tools/builtins/im-list-members.tool.ts libs/agent/tests/unit/im-tools.test.ts libs/agent/src/agent.module.ts
git commit -m "feat(agent): 三个只读 IM 工具（未读概览/读会话/成员）"
```

---

## Task 8: server-agent —— 绑定 IM_CONTEXT_PORT

**Files:**
- Create: `apps/server-agent/src/im-context.module.ts`
- Test: `apps/server-agent/src/im-context.module.spec.ts`
- Modify: `apps/server-agent/src/im.module.ts`
- Modify: `apps/server-agent/src/app.module.ts`

**Interfaces:**
- Consumes: `IM_CONTEXT_PORT` / `ImContextPort`（Task 6）、`CloudImService`（`./services/cloud-im.service`，方法 `listConversations()` / `getMessages(id, before?, limit?)` / `listChannelMembers(id)`）。
- Produces: 全局可注入的 `IM_CONTEXT_PORT`；可单测的 `createImContextPort(cloudIm): ImContextPort`。

- [ ] **Step 1: 写失败单测**

创建 `apps/server-agent/src/im-context.module.spec.ts`：

```ts
import type { CloudImService } from "./services/cloud-im.service";
import { createImContextPort } from "./im-context.module";

function makeCloudIm() {
  return {
    listConversations: jest.fn().mockResolvedValue([
      {
        id: "321",
        type: "channel",
        name: "产品研发",
        peer: null,
        unreadCount: 5,
      },
    ]),
    getMessages: jest.fn().mockResolvedValue({ messages: [], hasMore: false }),
    listChannelMembers: jest.fn().mockResolvedValue([{ userId: "u1" }]),
  } as unknown as CloudImService;
}

describe("createImContextPort", () => {
  it("unreadOverview 返回紧凑 JSON（id/type/name/unread）", async () => {
    const cloudIm = makeCloudIm();
    const port = createImContextPort(cloudIm);
    const out = JSON.parse(await port.unreadOverview());
    expect(out).toEqual([
      { id: "321", type: "channel", name: "产品研发", unread: 5 },
    ]);
  });

  it("readConversation 把 limit(number) 转 string 传 getMessages(id, before, limit)", async () => {
    const cloudIm = makeCloudIm();
    const port = createImContextPort(cloudIm);
    await port.readConversation("321", { limit: 20 });
    expect(cloudIm.getMessages).toHaveBeenCalledWith("321", undefined, "20");
  });

  it("listMembers 透传并序列化", async () => {
    const cloudIm = makeCloudIm();
    const port = createImContextPort(cloudIm);
    const out = JSON.parse(await port.listMembers("321"));
    expect(out).toEqual([{ userId: "u1" }]);
    expect(cloudIm.listChannelMembers).toHaveBeenCalledWith("321");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test -- apps/server-agent/src/im-context.module.spec.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现 module + 适配器**

创建 `apps/server-agent/src/im-context.module.ts`：

```ts
import { IM_CONTEXT_PORT, type ImContextPort } from "@meshbot/agent";
import { Global, Module } from "@nestjs/common";
import { ImModule } from "./im.module";
import { CloudImService } from "./services/cloud-im.service";

/**
 * 把 CloudImService 适配为 libs/agent 的 ImContextPort：取数 + 紧凑序列化为 JSON 字符串。
 * 抽成独立函数便于单测（无需起 Nest 容器）。
 */
export function createImContextPort(cloudIm: CloudImService): ImContextPort {
  return {
    async unreadOverview() {
      const convs = await cloudIm.listConversations();
      return JSON.stringify(
        convs.map((c) => ({
          id: c.id,
          type: c.type,
          name: c.name ?? c.peer?.displayName ?? c.id,
          unread: c.unreadCount,
        })),
      );
    },
    async readConversation(conversationId, opts) {
      const page = await cloudIm.getMessages(
        conversationId,
        opts?.before,
        opts?.limit != null ? String(opts.limit) : undefined,
      );
      return JSON.stringify(page);
    },
    async listMembers(conversationId) {
      return JSON.stringify(await cloudIm.listChannelMembers(conversationId));
    },
  };
}

/**
 * @Global IM 上下文模块：把 IM_CONTEXT_PORT 绑定到 CloudImService。
 *
 * @Global 让 AgentModule 内的 IM 工具解析此端口（同 QuickAssistantModule 范式）。
 */
@Global()
@Module({
  imports: [ImModule],
  providers: [
    {
      provide: IM_CONTEXT_PORT,
      useFactory: (cloudIm: CloudImService) => createImContextPort(cloudIm),
      inject: [CloudImService],
    },
  ],
  exports: [IM_CONTEXT_PORT],
})
export class ImContextModule {}
```

- [ ] **Step 4: 让 ImModule 导出 CloudImService**

`apps/server-agent/src/im.module.ts`：在 `@Module({...})` 里 `providers: [...]` 之后加一行 `exports`（若已有 exports 则追加 `CloudImService`）：

```ts
  providers: [CloudImService, EventsGateway, ImAgentService, SidebarService],
  exports: [CloudImService],
})
export class ImModule {}
```

- [ ] **Step 5: 在 app.module 注册 ImContextModule**

`apps/server-agent/src/app.module.ts`：顶部 import `import { ImContextModule } from "./im-context.module";`，在 `imports` 数组里 `ImModule` 之后加 `ImContextModule`。先 `rg -n "ImModule" apps/server-agent/src/app.module.ts` 定位。

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm test -- apps/server-agent/src/im-context.module.spec.ts`
Expected: PASS（3 个用例）。

- [ ] **Step 7: typecheck + 提交**

```bash
pnpm turbo typecheck --filter=@meshbot/server-agent
git add apps/server-agent/src/im-context.module.ts apps/server-agent/src/im-context.module.spec.ts apps/server-agent/src/im.module.ts apps/server-agent/src/app.module.ts
git commit -m "feat(server-agent): 绑定 IM_CONTEXT_PORT（CloudImService 适配）"
```

---

## Task 9: 后端系统提示 —— LLMUSE_GUIDE 始终在场

**Files:**
- Create: `libs/agent/src/prompt/llmuse-guide.ts`
- Modify: `libs/agent/src/graph/graph-runner.service.ts`
- Test: `libs/agent/tests/unit/context-builder.test.ts`

**Interfaces:**
- Consumes: 由 `graph-runner` 在首轮 systemPrompt 数组里拼接（与 `getPrompt("system")` / `buildMemorySection()` 同处）。
- Produces: `LLMUSE_GUIDE: string`（解释 `<llmuse>` 块语义 + 引导调 im_* 工具）。

- [ ] **Step 1: 实现常量**

创建 `libs/agent/src/prompt/llmuse-guide.ts`：

```ts
/**
 * 始终在场的系统说明：解释用户消息里可能出现的 `<llmuse>` 块。
 *
 * 与 MEMORY_GUIDE 同样在首轮系统提示里注入并随会话留存。
 */
export const LLMUSE_GUIDE = `用户的消息开头可能包含一个 <llmuse>...</llmuse> 块，描述用户此刻的前端界面状态（当前页面、打开的频道/私聊及其 id 与未读数）。这是给你的上下文，用来理解用户"正在看什么"，不要在回复里原样复述它。

当你需要更深入的信息时，调用 IM 工具：
- im_unread_overview：列出所有会话与未读数；
- im_read_conversation：按 id 读某频道/私聊的最近消息；
- im_list_members：列出某频道成员。`;
```

- [ ] **Step 2: 在 graph-runner 拼接**

`libs/agent/src/graph/graph-runner.service.ts`，把第 255-260 行：

```ts
    const systemPrompt = [
      this.promptService.getPrompt("system"),
      this.contextBuilder.buildMemorySection(),
    ]
      .filter(Boolean)
      .join("\n\n");
```

改为：

```ts
    const systemPrompt = [
      this.promptService.getPrompt("system"),
      this.contextBuilder.buildMemorySection(),
      LLMUSE_GUIDE,
    ]
      .filter(Boolean)
      .join("\n\n");
```

顶部 import：`import { LLMUSE_GUIDE } from "../prompt/llmuse-guide";`

- [ ] **Step 3: 写断言（复用既有 working 套件）**

在 `libs/agent/tests/unit/context-builder.test.ts` 的 `describe("ContextBuilder core 记忆注入系统提示", …)` 内，仿第 162 行「首轮系统提示含 MEMORY_GUIDE」用例，追加：

```ts
  it("首轮系统提示含 <llmuse> 说明", async () => {
    const { graphRunner, threadState, ctx } = makeGs({
      readCore: () => "用户偏好简洁",
    });
    const threadId = await graphRunner.startSession({ model: "fake" });
    await ctx.run(TEST_ACCOUNT, async () => {
      for await (const _ of graphRunner.streamMessage(threadId, [
        { id: "pm-1", content: "hi" },
      ])) {
        // 消费完
      }
    });
    const snapshot = await ctx.run(TEST_ACCOUNT, () =>
      threadState.getMessagesSnapshot(threadId),
    );
    const sysMsgs = snapshot.filter(
      (m) => m._getType() === "system" && m.id !== "system:ctx",
    );
    const content =
      sysMsgs.length > 0 && typeof sysMsgs[0].content === "string"
        ? sysMsgs[0].content
        : "";
    expect(content).toContain("<llmuse>");
  });
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd libs/agent && npx vitest run tests/unit/context-builder.test.ts`
Expected: PASS（含新用例；其余 context-builder 用例保持通过）。

- [ ] **Step 5: typecheck + 提交**

```bash
pnpm turbo typecheck --filter=@meshbot/agent
git add libs/agent/src/prompt/llmuse-guide.ts libs/agent/src/graph/graph-runner.service.ts libs/agent/tests/unit/context-builder.test.ts
git commit -m "feat(agent): 系统提示注入 LLMUSE_GUIDE（始终在场）"
```

---

## Task 10: 集成验证（boot + 全量测试 + 静态围栏）

> Task 8 新增了 `@Global` provider（DI 变更）。按项目铁律：typecheck/单测会漏 DI 启动崩溃，必须真启 server-agent 验证。

**Files:** 无（验证）。

- [ ] **Step 1: 全量单测**

Run: `pnpm test`
Expected: 新增用例全绿；libs/agent vitest 维持既有基线失败数（约 9 个：agent.module DI + supervisor.node + graph-runner mock），**不得新增**失败。如有新增，diff 失败集合定位。

- [ ] **Step 2: 全包 typecheck**

Run: `pnpm typecheck`
Expected: 全绿。

- [ ] **Step 3: 真启 server-agent 验证 DI（关键）**

Run: `pnpm dev:server-agent`（或构建后 `node dist/main.js`），观察启动日志直到监听 3100，无 Nest DI 解析报错（尤其 `IM_CONTEXT_PORT` / `CloudImService` 解析）。确认后 Ctrl-C。
Expected: 正常启动，无 `Nest can't resolve dependencies` / `UnknownDependenciesException`。

- [ ] **Step 4: 静态围栏**

Run: `pnpm check`
Expected: exit 0（新增 finding 为 0；既有基线 unchanged）。

- [ ] **Step 5: 手动冒烟（端到端）**

启动 server-agent + `pnpm dev:web-agent`，登录后：
1. 进入某频道，打开随手问 dock，问"帮我看看这个频道最近在聊什么"。
2. 预期：助手回复贴合该频道；用户那条消息在 UI 上**看不到** `<llmuse>` 块；（可在 LangSmith 或日志）确认喂给 LLM 的 HumanMessage 含 `<llmuse>` 块且 agent 调用了 `im_read_conversation`。
3. 在非会话页（如 /schedule）问助手，确认 `<llmuse>` 只含页面行、无会话行。

- [ ] **Step 6: 最终提交（如有冒烟修正）**

```bash
git add -A
git commit -m "test(agent): UI-Context Awareness 集成验证修正"
```

---

## Self-Review（已核对）

- **Spec 覆盖**：①机制（Task 1-4、9）②`<llmuse>` 内容（Task 2）③前端组装+剥离（Task 3、4）④后端系统提示（Task 9）⑤三个只读工具（Task 5-8）⑥数据流（Task 10 冒烟）⑦边界：仅助手轮注入（Task 3 含 new-message-view IM 分支不注入的提醒）、companion 不注入（companion 走 ImAgentService 的 kick，不经前端 prefix，天然不注入）、工具全会话可用（注册在 AgentModule，无 kind 过滤）⑧测试（每 Task 自带）。
- **占位符**：无 TBD/TODO；每个代码步给出完整代码与确切命令/预期。
- **类型一致**：`ImContextPort` 三方法签名（`unreadOverview()` / `readConversation(id, {limit?,before?})` / `listMembers(id)`）在 Task 6 定义、Task 7 工具调用、Task 8 适配器实现三处一致；`createImContextPort` 名称在 Task 8 module 与 spec 一致；`stripLlmuse` / `formatLlmuseBlock` / `LLMUSE_OPEN` 跨 Task 1/2/4 一致。
