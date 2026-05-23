# Pending 消息删除与编辑 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给会话页 pending 区里的「未被 runner 接管」用户消息加上「删除」和「编辑」能力（编辑 = 删 + 把内容回填到输入框）。

**Architecture:** 后端新增 `DELETE /api/sessions/:sid/pending-messages/:mid` 单接口（删除时校验 status=pending，返 content 给前端用于编辑回填）。前端 ChatInput 改受控以接受外部灌入 draft；PendingList 引入 inFlightIds 防重复点击；会话页 + 首页持有 draft 状态。

**Tech Stack:** NestJS 后端 + TypeORM + SQLite；React/Next.js 前端 + Jotai + Axios；现有 `apiClient` 通过 `@meshbot/web-common` 复用。

**Spec:** [docs/superpowers/specs/2026-05-23-pending-message-delete-edit-design.md](../specs/2026-05-23-pending-message-delete-edit-design.md)

---

## File Structure

**后端：**
- Modify `libs/types-agent/src/session.ts` — 加 `DeletePendingResponseSchema/Response` + 导出
- Modify `apps/server-agent/src/services/session.service.ts` — 加 `deletePendingMessage`
- Modify `apps/server-agent/src/services/session.service.spec.ts` — 6 个新测试
- Modify `apps/server-agent/src/controllers/session.controller.ts` — `@Delete(":id/pending-messages/:messageId")`

**前端：**
- Modify `apps/web-agent/src/rest/session.ts` — 加 `deletePendingMessage` client
- Modify `apps/web-agent/src/components/common/chat-input.tsx` — 改受控（value/onChange props，contentEditable 同步 innerText）+ 暴露 `focus()` via ref
- Modify `apps/web-agent/src/components/session/pending-list.tsx` — `inFlightIds` 状态、async 回调签名
- Modify `apps/web-agent/src/app/session/page.tsx` — draft state、chatInputRef、handleDeletePending / handleEditPending
- Modify `apps/web-agent/src/app/page.tsx` — draft state 接 ChatInput 受控接口

---

## Task 1: 后端 — 加 DeletePendingResponseSchema

**Files:**
- Modify: `libs/types-agent/src/session.ts`

- [ ] **Step 1: 在 `RunUsageEventSchema` 之后、`SessionTopicSchema` 之前插入新 schema**

打开 `libs/types-agent/src/session.ts`，找到现有 `RunUsageEventSchema`（应在 130~140 行左右），在它之后插入：

```ts
/**
 * DELETE /api/sessions/:sessionId/pending-messages/:messageId 响应载荷。
 * 返回 content 让前端在「编辑」场景下回填输入框。
 */
export const DeletePendingResponseSchema = z.object({
  deleted: z.literal(true),
  content: z.string(),
});
export type DeletePendingResponse = z.infer<typeof DeletePendingResponseSchema>;
```

- [ ] **Step 2: typecheck**

Run: `pnpm --filter @meshbot/types-agent typecheck`
Expected: 无错误退出。

- [ ] **Step 3: Commit**

```bash
git add libs/types-agent/src/session.ts
git commit -m "feat(types-agent): 新增 DeletePendingResponse schema"
```

---

## Task 2: 后端 Service — 写失败的单元测试

**Files:**
- Modify: `apps/server-agent/src/services/session.service.spec.ts`

- [ ] **Step 1: 在文件末尾的最后一个 `it(` 之后、`});` 闭合 describe 之前，加 6 个新测试**

先查看现有结构（找到 describe 结尾大括号位置）：

Run: `tail -20 apps/server-agent/src/services/session.service.spec.ts`

应能看到 `});` 闭合最外层 `describe`。在它之前插入：

```ts
  it("deletePendingMessage 删 status=pending 返回 content", async () => {
    const { sessionId } = await service.createSession({ content: "m1" });
    const messageId = randomUUID();
    await service.appendMessage(sessionId, { messageId, content: "to delete" });
    const res = await service.deletePendingMessage(sessionId, messageId);
    expect(res).toEqual({ content: "to delete" });
    const remaining = await service.listActivePending(sessionId);
    expect(remaining.find((m) => m.id === messageId)).toBeUndefined();
  });

  it("deletePendingMessage 对 status=processing 抛 ConflictException", async () => {
    const { sessionId } = await service.createSession({ content: "m1" });
    const claimed = await service.claimPending(sessionId);
    expect(claimed[0].status).toBe("processing");
    await expect(
      service.deletePendingMessage(sessionId, claimed[0].id),
    ).rejects.toThrow(ConflictException);
  });

  it("deletePendingMessage 对 status=failed 抛 ConflictException", async () => {
    const { sessionId } = await service.createSession({ content: "m1" });
    const claimed = await service.claimPending(sessionId);
    await service.markFailed([claimed[0].id]);
    await expect(
      service.deletePendingMessage(sessionId, claimed[0].id),
    ).rejects.toThrow(ConflictException);
  });

  it("deletePendingMessage 对 status=processed 抛 ConflictException", async () => {
    const { sessionId } = await service.createSession({ content: "m1" });
    const claimed = await service.claimPending(sessionId);
    await service.markProcessed([claimed[0].id]);
    await expect(
      service.deletePendingMessage(sessionId, claimed[0].id),
    ).rejects.toThrow(ConflictException);
  });

  it("deletePendingMessage 对不存在的 messageId 抛 NotFoundException", async () => {
    const { sessionId } = await service.createSession({ content: "m1" });
    await expect(
      service.deletePendingMessage(sessionId, randomUUID()),
    ).rejects.toThrow(NotFoundException);
  });

  it("deletePendingMessage 跨 session 删抛 NotFoundException（不暴露存在性）", async () => {
    const { sessionId: sA } = await service.createSession({ content: "a" });
    const { sessionId: sB } = await service.createSession({ content: "b" });
    const messageId = randomUUID();
    await service.appendMessage(sB, { messageId, content: "in b" });
    // 用 sessionA 去删 sessionB 的消息
    await expect(
      service.deletePendingMessage(sA, messageId),
    ).rejects.toThrow(NotFoundException);
    // 确认消息仍在 sessionB
    const stillInB = await service.listActivePending(sB);
    expect(stillInB.find((m) => m.id === messageId)).toBeDefined();
  });
```

- [ ] **Step 2: 把 `ConflictException` 加入 import**

文件顶部 import 行当前是：

```ts
import { NotFoundException } from "@nestjs/common";
```

改为：

```ts
import { ConflictException, NotFoundException } from "@nestjs/common";
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm --filter @meshbot/server-agent test -- session.service.spec`
Expected: 6 个新测试全部 FAIL（提示 `service.deletePendingMessage is not a function`）

- [ ] **Step 4: Commit（红测试）**

```bash
git add apps/server-agent/src/services/session.service.spec.ts
git commit -m "test(session): deletePendingMessage 6 个失败测试"
```

---

## Task 3: 后端 Service — 实现 deletePendingMessage

**Files:**
- Modify: `apps/server-agent/src/services/session.service.ts`

- [ ] **Step 1: 修改 import，加上 ConflictException**

打开 `apps/server-agent/src/services/session.service.ts`，把第 7 行的 import：

```ts
import { Injectable, NotFoundException } from "@nestjs/common";
```

改为：

```ts
import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
```

- [ ] **Step 2: 在 `appendMessage` 方法之后、`findSessionOrFail` 之前插入新方法**

找到 `appendMessage` 方法（约 60-74 行）的闭合 `}` 之后，加上：

```ts
  /**
   * 删除一条 pending 消息。仅 status=pending 可删，其余状态返 Conflict。
   * 单表读+删；用 WHERE id+sessionId+status='pending' 三件套保证原子，防止
   * 「读到 pending → delete 之间 runner claim」窗口。
   *
   * 返回原 content，让前端在「编辑」场景回填输入框。
   */
  async deletePendingMessage(
    sessionId: string,
    messageId: string,
  ): Promise<{ content: string }> {
    const row = await this.pendingRepo.findOneBy({ id: messageId, sessionId });
    if (!row) {
      throw new NotFoundException(`PendingMessage ${messageId} not found`);
    }
    if (row.status !== "pending") {
      throw new ConflictException(
        `PendingMessage ${messageId} 已处于 ${row.status} 状态，无法删除`,
      );
    }
    const res = await this.pendingRepo.delete({
      id: messageId,
      sessionId,
      status: "pending",
    });
    if (!res.affected) {
      // 上面 find 之后 runner 可能刚 claim → delete 0 行
      throw new ConflictException(
        `PendingMessage ${messageId} 已开始处理，无法删除`,
      );
    }
    return { content: row.content };
  }
```

- [ ] **Step 3: 运行测试确认全部通过**

Run: `pnpm --filter @meshbot/server-agent test -- session.service.spec`
Expected: 全部 PASS（包括上一轮 6 个新测试）

- [ ] **Step 4: 跑全包 typecheck**

Run: `pnpm --filter @meshbot/server-agent typecheck`
Expected: 0 errors

- [ ] **Step 5: Commit**

```bash
git add apps/server-agent/src/services/session.service.ts
git commit -m "feat(session): SessionService.deletePendingMessage"
```

---

## Task 4: 后端 Controller — 暴露 DELETE 接口

**Files:**
- Modify: `apps/server-agent/src/controllers/session.controller.ts`

- [ ] **Step 1: 改 import，加 Delete**

把第 7 行：

```ts
import { Body, Controller, Get, Param, Post } from "@nestjs/common";
```

改为：

```ts
import { Body, Controller, Delete, Get, Param, Post } from "@nestjs/common";
```

并把第 5 行（types-agent 的 type-only import）加入 `DeletePendingResponse`：

当前：
```ts
import type {
  HistoryResponse,
  MessageUsage,
  PendingResponse,
} from "@meshbot/types-agent";
```

改为：
```ts
import type {
  DeletePendingResponse,
  HistoryResponse,
  MessageUsage,
  PendingResponse,
} from "@meshbot/types-agent";
```

- [ ] **Step 2: 在 `pending` 方法（@Get(":id/pending")）之后追加新 endpoint**

找到 `pending` 方法的闭合 `}`（约第 104 行），在它之后、`}` 闭合 class 之前插入：

```ts
  /** 删除一条 pending 消息。仅 status=pending 可删；其余状态返 409。 */
  @Delete(":id/pending-messages/:messageId")
  async deletePending(
    @Param("id") sessionId: string,
    @Param("messageId") messageId: string,
  ): Promise<DeletePendingResponse> {
    const { content } = await this.sessions.deletePendingMessage(
      sessionId,
      messageId,
    );
    return { deleted: true, content };
  }
```

- [ ] **Step 3: typecheck**

Run: `pnpm --filter @meshbot/server-agent typecheck`
Expected: 0 errors

- [ ] **Step 4: 手动验证接口（dev server 起着的话）**

Run（一行）:
```bash
curl -i -X DELETE http://127.0.0.1:3100/api/sessions/nonexistent/pending-messages/nope
```
Expected: HTTP 404

- [ ] **Step 5: Commit**

```bash
git add apps/server-agent/src/controllers/session.controller.ts
git commit -m "feat(session): DELETE /api/sessions/:sid/pending-messages/:mid"
```

---

## Task 5: 前端 REST client — deletePendingMessage

**Files:**
- Modify: `apps/web-agent/src/rest/session.ts`

- [ ] **Step 1: 修改顶部 import**

把第 3 行：

```ts
import type { HistoryResponse, PendingResponse } from "@meshbot/types-agent";
```

改为：

```ts
import type {
  DeletePendingResponse,
  HistoryResponse,
  PendingResponse,
} from "@meshbot/types-agent";
```

- [ ] **Step 2: 在文件末尾（`retrySession` 之后）追加新函数**

```ts
/**
 * 删除一条 pending 消息。仅 status=pending 可删。
 * 返回 content 给「编辑」场景：删完后把内容回填输入框。
 */
export async function deletePendingMessage(
  sessionId: string,
  messageId: string,
): Promise<DeletePendingResponse> {
  const { data } = await apiClient.delete<DeletePendingResponse>(
    `/api/sessions/${sessionId}/pending-messages/${messageId}`,
  );
  return data;
}
```

- [ ] **Step 3: typecheck**

Run: `pnpm --filter @meshbot/web-agent typecheck`
Expected: 0 errors

- [ ] **Step 4: Commit**

```bash
git add apps/web-agent/src/rest/session.ts
git commit -m "feat(web-agent): deletePendingMessage REST client"
```

---

## Task 6: ChatInput 改受控 + 暴露 focus() ref

**Files:**
- Modify: `apps/web-agent/src/components/common/chat-input.tsx`

ChatInput 内部用 `contentEditable` div + 自管 `value` state。受控化要求：
- 把内部 state 移除，value 由 props 提供
- contentEditable.innerText 在 `useEffect` 里跟 `value` 同步（外部 setValue 时同步 DOM）
- 用 `forwardRef` + `useImperativeHandle` 暴露 `focus()` 方法

- [ ] **Step 1: 整体替换 ChatInput 组件**

把整个文件替换为：

```tsx
"use client";

import { cn, Tooltip, TooltipContent, TooltipTrigger } from "@meshbot/design";
import { Paperclip, Send, Square } from "lucide-react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";

interface ChatInputProps {
  /** 受控值。父组件维护 draft state。 */
  value: string;
  /** 受控 change。 */
  onChange: (next: string) => void;
  onSend?: (message: string) => void;
  onInterrupt?: () => void;
  isLoading?: boolean;
  placeholder?: string;
  modelName?: string;
  tokenUsage?: {
    current: number;
    max: number;
    /** 分项明细（可选）—— 提供时 Tooltip 展示详细分解。 */
    breakdown?: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      reasoningTokens: number;
      callCount: number;
    };
  };
}

/** 父组件通过 ref 调用的方法。 */
export interface ChatInputHandle {
  focus: () => void;
}

export const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(
  function ChatInput(
    {
      value,
      onChange,
      onSend,
      onInterrupt,
      isLoading = false,
      placeholder = "Describe a task or ask a question",
      modelName,
      tokenUsage,
    },
    ref,
  ) {
    const editorRef = useRef<HTMLDivElement>(null);

    // 当外部 value 与 DOM innerText 不一致时同步（外部灌 draft 时触发）
    useEffect(() => {
      const el = editorRef.current;
      if (!el) return;
      if (el.innerText !== value) {
        el.innerText = value;
      }
    }, [value]);

    useImperativeHandle(ref, () => ({
      focus: () => {
        editorRef.current?.focus();
      },
    }));

    const handleInput = useCallback(() => {
      const el = editorRef.current;
      if (!el) return;
      onChange(el.innerText);
    }, [onChange]);

    const handleSend = useCallback(() => {
      const trimmed = value.trim();
      if (!trimmed) return;
      onSend?.(trimmed);
      onChange("");
      const el = editorRef.current;
      if (el) {
        el.innerText = "";
      }
    }, [value, onSend, onChange]);

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          handleSend();
        }
      },
      [handleSend],
    );

    const handleInterrupt = useCallback(() => {
      onInterrupt?.();
    }, [onInterrupt]);

    const hasContent = value.trim().length > 0;

    const tokenPercent = tokenUsage
      ? Math.min((tokenUsage.current / tokenUsage.max) * 100, 100)
      : 0;

    return (
      <div className="rounded-none border border-border bg-card">
        <div className="flex items-center gap-2 px-3 py-2">
          <div className="relative w-full">
            {!hasContent && (
              <div className="pointer-events-none absolute left-0 top-0 py-1.5 text-sm text-muted-foreground">
                {placeholder}
              </div>
            )}
            <div
              ref={editorRef}
              role="textbox"
              aria-multiline="true"
              tabIndex={0}
              contentEditable
              onInput={handleInput}
              onKeyDown={handleKeyDown}
              className={cn(
                "min-h-[24px] max-h-[200px] w-full overflow-y-auto bg-transparent py-1.5 text-sm text-foreground outline-none empty:before:text-muted-foreground",
              )}
              style={{ wordBreak: "break-word" }}
            />
          </div>

          {isLoading && (
            <button
              type="button"
              onClick={handleInterrupt}
              className="flex h-8 w-8 shrink-0 items-center justify-center text-destructive transition-colors hover:text-destructive/80"
              title="Stop generating"
            >
              <Square className="h-4 w-4 fill-current" />
            </button>
          )}
          <button
            type="button"
            onClick={handleSend}
            disabled={!hasContent}
            className={cn(
              "flex h-8 w-8 shrink-0 items-center justify-center transition-colors",
              hasContent
                ? "text-foreground hover:text-foreground/80"
                : "text-muted-foreground",
            )}
            title="Send message"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>

        <div className="flex items-center justify-between border-t border-border px-3 py-1.5">
          <button
            type="button"
            className="flex h-5 w-5 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
            title="添加附件"
          >
            <Paperclip className="h-3.5 w-3.5" />
          </button>

          {tokenUsage && (
            <div className="flex items-center gap-2">
              {modelName && (
                <span className="text-xs text-muted-foreground">{modelName}</span>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="h-4 w-4 cursor-pointer">
                    <svg
                      className="h-full w-full -rotate-90"
                      viewBox="0 0 36 36"
                      role="img"
                      aria-label="Token usage"
                    >
                      <path
                        className="text-border"
                        d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="4"
                      />
                      <path
                        className="text-accent transition-all"
                        d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                        fill="none"
                        stroke="currentColor"
                        strokeDasharray={`${tokenPercent}, 100`}
                        strokeWidth="4"
                      />
                    </svg>
                  </div>
                </TooltipTrigger>
                <TooltipContent>
                  {tokenUsage.breakdown ? (
                    <div className="space-y-0.5 text-xs">
                      <div>
                        总计 {tokenUsage.current.toLocaleString()} /{" "}
                        {tokenUsage.max.toLocaleString()}
                      </div>
                      <div>
                        输入 {tokenUsage.breakdown.inputTokens.toLocaleString()}
                        {tokenUsage.breakdown.cacheReadTokens > 0 &&
                          `（缓存 ${tokenUsage.breakdown.cacheReadTokens.toLocaleString()}）`}
                      </div>
                      <div>
                        输出 {tokenUsage.breakdown.outputTokens.toLocaleString()}
                        {tokenUsage.breakdown.reasoningTokens > 0 &&
                          `（推理 ${tokenUsage.breakdown.reasoningTokens.toLocaleString()}）`}
                      </div>
                      <div>{tokenUsage.breakdown.callCount} 次调用</div>
                    </div>
                  ) : (
                    <>
                      {tokenUsage.current.toLocaleString()} /{" "}
                      {tokenUsage.max.toLocaleString()}
                    </>
                  )}
                </TooltipContent>
              </Tooltip>
            </div>
          )}
        </div>
      </div>
    );
  },
);
```

- [ ] **Step 2: typecheck**

Run: `pnpm --filter @meshbot/web-agent typecheck`
Expected: 失败，会报两处调用 ChatInput 的地方（page.tsx、session/page.tsx）缺 `value` 和 `onChange` props。这是预期 —— 下一个 task 修复。

- [ ] **Step 3: Commit（受控接口先落地，调用点 Task 7/8 修）**

```bash
git add apps/web-agent/src/components/common/chat-input.tsx
git commit -m "refactor(chat-input): 改受控（value/onChange）+ 暴露 focus() ref"
```

注意：本 commit 暂时让 build 处于失败状态，下一个 task 立即修复。如果你正在用 pre-commit hook 验 typecheck（看 package.json `lint-staged` 仅做 biome），应该不会阻塞 commit。如果阻塞，连 Task 7 + Task 8 一起做完再 commit。

---

## Task 7: 首页接 ChatInput 受控

**Files:**
- Modify: `apps/web-agent/src/app/page.tsx`

- [ ] **Step 1: 在 useState 处加 draft**

把当前的：

```ts
const [sending, setSending] = useState(false);
```

改为：

```ts
const [sending, setSending] = useState(false);
const [draft, setDraft] = useState("");
```

- [ ] **Step 2: 给 ChatInput 加 value / onChange props**

找到底部 `<ChatInput` 块，把：

```tsx
<ChatInput
  onSend={handleSend}
  isLoading={sending}
  modelName="Flash · Medium"
  tokenUsage={{ current: 12, max: 128 }}
/>
```

改为：

```tsx
<ChatInput
  value={draft}
  onChange={setDraft}
  onSend={handleSend}
  isLoading={sending}
  modelName="Flash · Medium"
  tokenUsage={{ current: 12, max: 128 }}
/>
```

- [ ] **Step 3: typecheck（首页应过；session 页可能仍报错）**

Run: `pnpm --filter @meshbot/web-agent typecheck`
Expected: 仍报一处 session/page.tsx 缺 props 的错。

- [ ] **Step 4: Commit**

```bash
git add apps/web-agent/src/app/page.tsx
git commit -m "refactor(home): 首页 ChatInput 接受控接口"
```

---

## Task 8: 会话页 — draft state + chatInputRef + handler

**Files:**
- Modify: `apps/web-agent/src/app/session/page.tsx`

- [ ] **Step 1: 修改顶部 React import，加 useImperativeHandle 不需要（父用），但需 useRef 已有**

文件第 13-21 行附近的 React import 当前包含 `useState`、`useEffect`、`useRef`、`useMemo`、`useCallback`、`Suspense`。无需加新 import。

- [ ] **Step 2: 修改 rest/session import，加 deletePendingMessage**

找到当前：

```ts
import {
  appendMessage,
  fetchHistory,
  fetchPending,
  retrySession,
} from "@/rest/session";
```

改为：

```ts
import {
  appendMessage,
  deletePendingMessage,
  fetchHistory,
  fetchPending,
  retrySession,
} from "@/rest/session";
```

- [ ] **Step 3: import ChatInputHandle**

找到当前：

```ts
import { ChatInput } from "@/components/common/chat-input";
```

改为：

```ts
import {
  ChatInput,
  type ChatInputHandle,
} from "@/components/common/chat-input";
```

- [ ] **Step 4: 加 draft 和 chatInputRef 状态（紧跟现有 messagesRef、running 等）**

找到这段（约 51-54 行）：

```ts
  const [messages, setMessages] = useState<TimelineMessage[]>([]);
  const [running, setRunning] = useState(false);
  const messagesRef = useRef<TimelineMessage[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
```

紧跟在 `bottomRef` 之后插入：

```ts
  const [draft, setDraft] = useState("");
  const chatInputRef = useRef<ChatInputHandle>(null);
```

- [ ] **Step 5: 在 handleRetry 上方添加 handleDeletePending 和 handleEditPending**

先找到 `handleRetry` 位置（约 423-431 行）。在它之前插入：

```ts
  /**
   * 删除一条 pending 消息。
   * - 200：本地从 messages 移除
   * - 404：消息已不存在，本地也移除（兜底）
   * - 409：runner 已开始处理；不动本地，依赖 onHuman 自然推动状态收敛
   * - 其他错误：alert 提示
   */
  const handleDeletePending = useCallback(
    async (id: string) => {
      if (!sessionId) return;
      try {
        await deletePendingMessage(sessionId, id);
        apply((prev) => prev.filter((m) => m.id !== id));
      } catch (err) {
        const status =
          err instanceof Error &&
          "response" in err &&
          typeof (err as { response?: { status?: number } }).response?.status ===
            "number"
            ? (err as { response: { status: number } }).response.status
            : undefined;
        if (status === 404) {
          apply((prev) => prev.filter((m) => m.id !== id));
        } else if (status === 409) {
          window.alert("消息已开始处理，无法删除");
        } else {
          console.error("删除 pending 失败", err);
          window.alert("网络错误，请重试");
        }
      }
    },
    [sessionId, apply],
  );

  /**
   * 编辑 = 删 + 把内容回填输入框 + focus。
   * 若输入框已有非空 draft，confirm 后才覆盖。
   */
  const handleEditPending = useCallback(
    async (id: string) => {
      if (!sessionId) return;
      if (draft.trim() && !window.confirm("覆盖当前输入框内容？")) return;
      try {
        const { content } = await deletePendingMessage(sessionId, id);
        apply((prev) => prev.filter((m) => m.id !== id));
        setDraft(content);
        chatInputRef.current?.focus();
      } catch (err) {
        const status =
          err instanceof Error &&
          "response" in err &&
          typeof (err as { response?: { status?: number } }).response?.status ===
            "number"
            ? (err as { response: { status: number } }).response.status
            : undefined;
        if (status === 404) {
          apply((prev) => prev.filter((m) => m.id !== id));
        } else if (status === 409) {
          window.alert("消息已开始处理，无法编辑");
        } else {
          console.error("编辑 pending 失败", err);
          window.alert("网络错误，请重试");
        }
      }
    },
    [sessionId, draft, apply],
  );
```

- [ ] **Step 6: 修改 PendingList 的调用**

找到（约 437-444 行）：

```tsx
        {queuedMessages.length > 0 && (
          <div className="mb-2">
            <PendingList
              messages={queuedMessages}
              onDelete={() => console.warn("删除待处理消息：即将支持")}
              onEdit={() => console.warn("编辑待处理消息：即将支持")}
            />
          </div>
        )}
```

改为：

```tsx
        {queuedMessages.length > 0 && (
          <div className="mb-2">
            <PendingList
              messages={queuedMessages}
              onDelete={handleDeletePending}
              onEdit={handleEditPending}
            />
          </div>
        )}
```

- [ ] **Step 7: 修改 ChatInput 调用，加受控 props + ref**

找到 `<ChatInput`（约 446-460 行），把：

```tsx
        <ChatInput
          onSend={handleSend}
          onInterrupt={handleInterrupt}
          isLoading={running}
          tokenUsage={{
```

改为：

```tsx
        <ChatInput
          ref={chatInputRef}
          value={draft}
          onChange={setDraft}
          onSend={handleSend}
          onInterrupt={handleInterrupt}
          isLoading={running}
          tokenUsage={{
```

- [ ] **Step 8: typecheck**

Run: `pnpm --filter @meshbot/web-agent typecheck`
Expected: 0 errors

- [ ] **Step 9: Commit**

```bash
git add apps/web-agent/src/app/session/page.tsx
git commit -m "feat(session): pending 删除/编辑 handler + ChatInput 受控接入"
```

---

## Task 9: PendingList — inFlightIds 状态 + async 回调

**Files:**
- Modify: `apps/web-agent/src/components/session/pending-list.tsx`

- [ ] **Step 1: 整体替换 pending-list.tsx**

```tsx
"use client";

import { Loader2, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import type { TimelineMessage } from "./message-list";

interface PendingListProps {
  messages: TimelineMessage[];
  /** 删除回调；async，await 期间该行按钮禁用 + 显示 loading。 */
  onDelete?: (id: string) => Promise<void>;
  /** 编辑回调；async，期间该行按钮禁用 + 显示 loading。 */
  onEdit?: (id: string) => Promise<void>;
}

/**
 * 待处理用户消息列表。渲染在 ChatInput 上方，区别于聊天区气泡。
 *
 * 仅显示 status === "pending"（runner 未认领）的消息。inFlight 期间禁用该行按钮、
 * 删除图标变为转圈，避免重复点击。
 */
export function PendingList({ messages, onDelete, onEdit }: PendingListProps) {
  const [inFlight, setInFlight] = useState<Set<string>>(new Set());

  const run = async (id: string, fn?: (id: string) => Promise<void>) => {
    if (!fn) return;
    if (inFlight.has(id)) return;
    setInFlight((s) => new Set(s).add(id));
    try {
      await fn(id);
    } finally {
      setInFlight((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
    }
  };

  if (messages.length === 0) return null;
  return (
    <ul className="flex flex-col border-t border-border/60">
      {messages.map((m) => {
        const busy = inFlight.has(m.id);
        return (
          <li
            key={m.id}
            className="group flex items-center justify-between gap-2 border-b border-border/60 px-2 py-1.5 text-xs text-muted-foreground"
          >
            <span className="truncate">{m.content}</span>
            <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
              <button
                type="button"
                aria-label="编辑"
                disabled={busy}
                className="p-1 text-muted-foreground/60 hover:text-foreground disabled:opacity-40 disabled:hover:text-muted-foreground/60"
                onClick={() => run(m.id, onEdit)}
              >
                <Pencil className="h-3 w-3" />
              </button>
              <button
                type="button"
                aria-label="删除"
                disabled={busy}
                className="p-1 text-muted-foreground/60 hover:text-destructive disabled:opacity-40 disabled:hover:text-muted-foreground/60"
                onClick={() => run(m.id, onDelete)}
              >
                {busy ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Trash2 className="h-3 w-3" />
                )}
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
```

- [ ] **Step 2: typecheck**

Run: `pnpm --filter @meshbot/web-agent typecheck`
Expected: 0 errors

- [ ] **Step 3: Commit**

```bash
git add apps/web-agent/src/components/session/pending-list.tsx
git commit -m "feat(pending-list): inFlightIds 禁用重复点 + 删除按钮 loading 状态"
```

---

## Task 10: 手测 + 修复 + 最终提交

- [ ] **Step 1: 起 server + web-agent**

Run（两个独立终端）:
```bash
pnpm dev:server-agent
pnpm dev:web-agent
```

Expected: server agent 在 3100 端口，web-agent 在 3001 端口。

- [ ] **Step 2: 跑场景 A — 删除 pending 消息**

1. 在 web-agent 发一条「请等 10 秒再回」让 LLM 跑长一点
2. LLM 还在 streaming 时，连发 2 条消息「A」「B」 → pending 区出现两条
3. hover 「B」行，点删除 → 转圈 → 消失
4. 等第一条完成 → 「A」走 pending → processing → assistant
5. 期望：B 不被处理；A 正常处理

如果失败：检查 server 日志、浏览器 console / Network 面板。

- [ ] **Step 3: 跑场景 B — 编辑 pending 消息**

1. 同上，先有长流 + 1 条 pending「Hello」
2. 输入框为空，点 hello 行编辑 → 输入框出现「Hello」+ focus
3. 修改为「Hello world」+ 发送
4. 期望：原 Hello 被删；新 Hello world 排队

- [ ] **Step 4: 跑场景 C — 编辑时输入框已有 draft**

1. 在场景 B 之前，先在输入框打一段「abc」（不发送）
2. 点编辑 hello → 弹 confirm「覆盖当前输入框内容？」
3. 取消 → 输入框仍是 abc，hello 仍在 pending 区
4. 再点 → 确定 → 输入框变 Hello

- [ ] **Step 5: 跑场景 D — 重复点删除按钮**

观察 inflight 期间按钮 disabled + 转圈，多点几次不重复发请求（Network 面板看请求计数）。

- [ ] **Step 6: 如有 bug 修复 + 单独 commit**

按发现的问题写补丁，每个 bug 单独 commit。

- [ ] **Step 7: 最终验证**

Run: `pnpm turbo run typecheck --filter=@meshbot/web-agent --filter=@meshbot/server-agent --filter=@meshbot/types-agent`
Expected: 全部 PASS

Run: `pnpm --filter @meshbot/server-agent test -- session.service.spec`
Expected: 全部 PASS（含 6 个新测试）

- [ ] **Step 8: 如无更多改动，本 Task 不需要 commit**

---

## Self-Review 笔记（plan 作者自查）

**Spec 覆盖**：
- ✅ 后端 DELETE 接口（Task 4）+ 200/404/409 区分（Task 3 + 4）
- ✅ Service 单元测试 6 个用例（Task 2 + 3）
- ✅ 前端 REST client（Task 5）
- ✅ ChatInput 受控（Task 6）+ focus ref（Task 6）
- ✅ PendingList inFlightIds + loading（Task 9）
- ✅ 会话页 handler（Task 8）—— delete + edit 都覆盖
- ✅ draft 非空 confirm（Task 8 Step 5）
- ✅ 编辑 messageId 不复用（spec 说明 + handleSend 用 crypto.randomUUID，原逻辑不动）
- ✅ 首页 ChatInput 受控（Task 7）
- ✅ Toast 系统降级到 window.alert（spec 已允许）

**类型一致性**：
- `DeletePendingResponse` 在 types-agent / server controller / web rest 三处使用名字一致
- `ChatInputHandle.focus()` 在 ChatInput 定义 + session page 调用一致
- `handleDeletePending` / `handleEditPending` 命名在 page + PendingList 调用一致

**Placeholder 扫描**：无 TBD / 「类似 Task X」 / 不带代码的步骤。所有代码块都是完整可用的。

**遗漏与降级**：
- 不引入 sonner / toast 组件 —— 用 `window.alert` 作 MVP。后续替换为 toast 是 follow-up
- 不刷新 fetchPending：spec 第 6 节说明依赖 onHuman 自然收敛，不引入新 refetch 路径
