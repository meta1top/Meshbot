# assistant 消息 action row Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在会话视图每条 assistant 消息下方加 hover 显示的操作行（复制 / 用量 tooltip / 点赞 / 不喜欢），点赞/不喜欢持久化到后端。

**Architecture:** 反馈存进现有 `SessionMessage.metadata` JSON 列（`{ feedback: "up"|"down" }`），新增 `POST /api/sessions/:id/messages/:messageId/feedback` 端点 + `SessionMessageService.setFeedback`；history 响应额外带回每条 assistant 的 `feedback`，前端新组件 `AssistantMessageActions` 复用 `UserMessageActions` 的 copy/hover 范式 + design `Tooltip`，并替换原纯文字用量行。

**Tech Stack:** NestJS + TypeORM(better-sqlite3) + Zod(`@meshbot/types-agent`) + Jest；Next.js + next-intl + lucide-react + `@meshbot/design` Tooltip + axios(`@meshbot/web-common`)。

---

## File Structure

**修改：**
- `libs/types-agent/src/session.ts` — 加 `MessageFeedbackSchema`/类型；`HistoryMessageSchema` 加 `feedback`
- `apps/server-agent/src/dto/session.dto.ts` — 加 `MessageFeedbackDto`
- `apps/server-agent/src/services/session-message.service.ts` — 加 `setFeedback`
- `apps/server-agent/src/controllers/session.controller.ts` — 加 feedback 端点；history 映射带出 `feedback`
- `apps/web-agent/src/rest/session.ts` — 加 `setMessageFeedback`
- `apps/web-agent/messages/zh.json` + `en.json` — 加 `session.actions.*`
- `apps/web-agent/src/components/session/message-list.tsx` — `TimelineMessage` 加 `feedback`；用 `AssistantMessageActions` 替换纯文字用量行；删 `renderUsageLine`
- `apps/web-agent/src/app/session/page.tsx` — history→timeline 映射带入 `feedback`

**新建：**
- `apps/server-agent/src/services/session-message-feedback.spec.ts`
- `apps/web-agent/src/components/session/assistant-message-actions.tsx`

---

## Task 1: types-agent — feedback schema + history 字段

**Files:**
- Modify: `libs/types-agent/src/session.ts`

- [ ] **Step 1: 加 MessageFeedbackSchema（放在 HistoryResponseSchema 附近，文件合适位置即可）**

```typescript
/** 消息反馈：点赞 up / 不喜欢 down / 取消 null。 */
export const MessageFeedbackSchema = z.object({
  feedback: z.enum(["up", "down"]).nullable(),
});
export type MessageFeedbackInput = z.infer<typeof MessageFeedbackSchema>;
```

- [ ] **Step 2: 给 HistoryMessageSchema 加 feedback 字段**

把现有（`libs/types-agent/src/session.ts:102-123`）：
```typescript
  metadata: z
    .object({
      kind: z.literal("compaction"),
      removedCount: z.number(),
      fromMessageId: z.string(),
      toMessageId: z.string(),
    })
    .nullable()
    .optional(),
});
export type HistoryMessage = z.infer<typeof HistoryMessageSchema>;
```
改为（在 `metadata` 之后、`})` 之前插入 `feedback`）：
```typescript
  metadata: z
    .object({
      kind: z.literal("compaction"),
      removedCount: z.number(),
      fromMessageId: z.string(),
      toMessageId: z.string(),
    })
    .nullable()
    .optional(),
  /** assistant 消息反馈（点赞/不喜欢）；其余为 null/缺省。 */
  feedback: z.enum(["up", "down"]).nullable().optional(),
});
export type HistoryMessage = z.infer<typeof HistoryMessageSchema>;
```

- [ ] **Step 3: typecheck**

Run: `pnpm --filter @meshbot/types-agent typecheck`
Expected: 通过。

- [ ] **Step 4: Commit**

```bash
git add libs/types-agent/src/session.ts
git commit -m "feat(types-agent): 加消息反馈 schema + history feedback 字段"
```

---

## Task 2: SessionMessageService.setFeedback + 单测

**Files:**
- Modify: `apps/server-agent/src/services/session-message.service.ts`
- Test: `apps/server-agent/src/services/session-message-feedback.spec.ts`

> setFeedback 是单表 update，无需 `@Transactional`；公开非事务方法，命名无约束。

- [ ] **Step 1: 写失败测试**

`apps/server-agent/src/services/session-message-feedback.spec.ts`:
```typescript
import { NotFoundException } from "@nestjs/common";
import { DataSource } from "typeorm";
import { SessionMessage } from "../entities/session-message.entity";
import { SessionMessageService } from "./session-message.service";

describe("SessionMessageService.setFeedback", () => {
  let ds: DataSource;
  let svc: SessionMessageService;

  beforeEach(async () => {
    ds = new DataSource({
      type: "better-sqlite3",
      database: ":memory:",
      entities: [SessionMessage],
      synchronize: true,
    });
    await ds.initialize();
    const repo = ds.getRepository(SessionMessage);
    svc = new SessionMessageService(repo);
    await repo.insert({
      id: "a1",
      sessionId: "s1",
      role: "assistant",
      content: "hi",
      reasoning: null,
      toolCalls: null,
      toolCallId: null,
      metadata: null,
      createdAt: new Date(),
    });
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it("设 up 写入 metadata，置 null 清空", async () => {
    await svc.setFeedback("s1", "a1", "up");
    let row = await svc.findByIdOrFail("a1");
    expect(JSON.parse(row.metadata as string)).toEqual({ feedback: "up" });

    await svc.setFeedback("s1", "a1", null);
    row = await svc.findByIdOrFail("a1");
    expect(row.metadata).toBeNull();
  });

  it("messageId 不属于该 session → NotFound", async () => {
    await expect(svc.setFeedback("other", "a1", "down")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test -- session-message-feedback`
Expected: FAIL（`setFeedback is not a function`）。

- [ ] **Step 3: 实现**

在 `apps/server-agent/src/services/session-message.service.ts` 类内追加（`NotFoundException` 已在该文件 import；若没有则补 `import { NotFoundException } from "@nestjs/common";`）：
```typescript
  /**
   * 设置 assistant 消息反馈。feedback=null 清空。
   * 校验 messageId 属于 sessionId（否则 NotFound）。metadata 单表 update。
   */
  async setFeedback(
    sessionId: string,
    messageId: string,
    feedback: "up" | "down" | null,
  ): Promise<void> {
    const row = await this.repo.findOneBy({ id: messageId });
    if (!row || row.sessionId !== sessionId) {
      throw new NotFoundException(
        `SessionMessage ${messageId} not found in session ${sessionId}`,
      );
    }
    await this.repo.update(
      { id: messageId },
      { metadata: feedback ? JSON.stringify({ feedback }) : null },
    );
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test -- session-message-feedback`
Expected: PASS（2 个用例）。

- [ ] **Step 5: Commit**

```bash
git add apps/server-agent/src/services/session-message.service.ts apps/server-agent/src/services/session-message-feedback.spec.ts
git commit -m "feat(server-agent): SessionMessageService.setFeedback + 单测"
```

---

## Task 3: feedback 端点 + DTO + history 带出 feedback

**Files:**
- Modify: `apps/server-agent/src/dto/session.dto.ts`
- Modify: `apps/server-agent/src/controllers/session.controller.ts`

- [ ] **Step 1: 加 DTO**

在 `apps/server-agent/src/dto/session.dto.ts`：import 增加 `MessageFeedbackSchema`，并追加 DTO 类：
```typescript
import { createZodDto } from "@meshbot/common";
import {
  AppendMessageSchema,
  CreateSessionSchema,
  MessageFeedbackSchema,
  SessionPatchSchema,
} from "@meshbot/types-agent";

/** POST /api/sessions 入参 DTO。 */
export class CreateSessionDto extends createZodDto(CreateSessionSchema) {}

/** POST /api/sessions/:id/messages 入参 DTO。 */
export class AppendMessageDto extends createZodDto(AppendMessageSchema) {}

/** PATCH /api/sessions/:id 入参 DTO（title / pinned 至少传一项）。 */
export class SessionPatchDto extends createZodDto(SessionPatchSchema) {}

/** POST /api/sessions/:id/messages/:messageId/feedback 入参 DTO。 */
export class MessageFeedbackDto extends createZodDto(MessageFeedbackSchema) {}
```

- [ ] **Step 2: 加端点**

在 `apps/server-agent/src/controllers/session.controller.ts`：
- import 增加 `MessageFeedbackSchema`（来自 `@meshbot/types-agent`）与 `MessageFeedbackDto`（来自 `../dto/session.dto`，与 `AppendMessageDto` 等并列）。
- 在 `regenerate` 方法（`session.controller.ts:178-186`）之后追加：
```typescript
  @Post(":sessionId/messages/:messageId/feedback")
  async feedback(
    @Param("sessionId") sessionId: string,
    @Param("messageId") messageId: string,
    @Body() body: MessageFeedbackDto,
  ): Promise<{ feedback: "up" | "down" | null }> {
    const { feedback } = MessageFeedbackSchema.parse(body);
    await this.sessionMessages.setFeedback(sessionId, messageId, feedback);
    return { feedback };
  }
```

- [ ] **Step 3: history 映射带出 feedback**

在 `apps/server-agent/src/controllers/session.controller.ts` 的 history 方法里，把构建 `base` 的片段（`session.controller.ts:112-124`）：
```typescript
        const base = {
          id: r.id,
          role: r.role as "user" | "assistant" | "system",
          content: r.content,
          ...(r.reasoning ? { reasoning: r.reasoning } : {}),
          metadata: r.metadata
            ? (JSON.parse(r.metadata) as {
                kind: "compaction";
                removedCount: number;
                fromMessageId: string;
                toMessageId: string;
              })
            : null,
        };
```
改为（先解析一次 metadata，再分别取 compaction 与 feedback）：
```typescript
        const meta = r.metadata
          ? (JSON.parse(r.metadata) as Record<string, unknown>)
          : null;
        const fb =
          meta && (meta.feedback === "up" || meta.feedback === "down")
            ? (meta.feedback as "up" | "down")
            : null;
        const base = {
          id: r.id,
          role: r.role as "user" | "assistant" | "system",
          content: r.content,
          ...(r.reasoning ? { reasoning: r.reasoning } : {}),
          metadata:
            meta && meta.kind === "compaction"
              ? (meta as unknown as {
                  kind: "compaction";
                  removedCount: number;
                  fromMessageId: string;
                  toMessageId: string;
                })
              : null,
          feedback: fb,
        };
```

- [ ] **Step 4: typecheck + 单元测试回归**

Run: `pnpm --filter @meshbot/server-agent typecheck && pnpm test -- session-message-feedback`
Expected: typecheck 通过；测试仍 2 passed。

- [ ] **Step 5: Commit**

```bash
git add apps/server-agent/src/dto/session.dto.ts apps/server-agent/src/controllers/session.controller.ts
git commit -m "feat(server-agent): /messages/:id/feedback 端点 + history 带出 feedback"
```

---

## Task 4: 前端 rest helper

**Files:**
- Modify: `apps/web-agent/src/rest/session.ts`

- [ ] **Step 1: 追加 helper（仿 `regenerateMessage`，在文件末尾）**

```typescript
/** 设置 assistant 消息反馈（点赞 up / 不喜欢 down / 取消 null）。 */
export async function setMessageFeedback(
  sessionId: string,
  messageId: string,
  feedback: "up" | "down" | null,
): Promise<{ feedback: "up" | "down" | null }> {
  const { data } = await apiClient.post<{ feedback: "up" | "down" | null }>(
    `/api/sessions/${sessionId}/messages/${messageId}/feedback`,
    { feedback },
  );
  return data;
}
```

- [ ] **Step 2: typecheck**

Run: `pnpm --filter @meshbot/web-agent typecheck`
Expected: 通过。

- [ ] **Step 3: Commit**

```bash
git add apps/web-agent/src/rest/session.ts
git commit -m "feat(web-agent): setMessageFeedback rest helper"
```

---

## Task 5: i18n —— session.actions.*

**Files:**
- Modify: `apps/web-agent/messages/zh.json`
- Modify: `apps/web-agent/messages/en.json`

> 用量 tooltip 复用现有 `session.usage.*`（inputLabel/outputLabel/cacheLabel/reasoningLabel/totalLabel），只新增 `session.actions.*`。zh/en 必须对称。

- [ ] **Step 1: zh.json —— 在 `"session"` 块内（`"usage"` 对象之后）加 `"actions"`**

在 `apps/web-agent/messages/zh.json` 的 `session.usage { ... }` 之后插入：
```json
    "actions": {
      "copy": "复制",
      "copied": "已复制",
      "usage": "用量",
      "like": "赞",
      "dislike": "不喜欢"
    },
```
（确保前一项 `"usage": { ... }` 末尾有逗号；`actions` 后接 `compaction` 块。）

- [ ] **Step 2: en.json —— 同位置加对称 `"actions"`**

```json
    "actions": {
      "copy": "Copy",
      "copied": "Copied",
      "usage": "Usage",
      "like": "Like",
      "dislike": "Dislike"
    },
```

- [ ] **Step 3: JSON 合法 + locales 对齐**

Run:
```bash
node -e "JSON.parse(require('fs').readFileSync('apps/web-agent/messages/zh.json','utf8'));JSON.parse(require('fs').readFileSync('apps/web-agent/messages/en.json','utf8'));console.log('valid')"
pnpm sync:locales -- --check
```
Expected: 打印 `valid`；sync:locales 结尾 `Done (missing=0, asymmetric=0)`。

- [ ] **Step 4: Commit**

```bash
git add apps/web-agent/messages/zh.json apps/web-agent/messages/en.json
git commit -m "feat(web-agent): session.actions i18n 文案"
```

---

## Task 6: AssistantMessageActions 组件

**Files:**
- Create: `apps/web-agent/src/components/session/assistant-message-actions.tsx`

- [ ] **Step 1: 写组件**

`apps/web-agent/src/components/session/assistant-message-actions.tsx`:
```typescript
"use client";

import { cn, Tooltip, TooltipContent, TooltipTrigger } from "@meshbot/design";
import type { MessageUsage } from "@meshbot/types-agent";
import { Check, Copy, Info, ThumbsDown, ThumbsUp } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useState } from "react";
import { formatTokens } from "@/lib/format-tokens";
import { setMessageFeedback } from "@/rest/session";

interface Props {
  sessionId: string;
  messageId: string;
  content: string;
  /** 该条 assistant 的单次 LLM 用量；无则不显示用量图标。 */
  usage?: MessageUsage;
  /** 初始反馈态（来自 history）。 */
  feedback?: "up" | "down" | null;
}

const BTN =
  "rounded p-1 text-muted-foreground hover:bg-foreground/5 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40";

/**
 * assistant 气泡下方操作行：复制 / 用量 tooltip / 点赞 / 不喜欢。
 * hover 消息容器（外层 .group）才显示。点赞/不喜欢互斥 toggle，乐观 + 持久化。
 */
export function AssistantMessageActions({
  sessionId,
  messageId,
  content,
  usage,
  feedback,
}: Props) {
  const t = useTranslations("session");
  const [copied, setCopied] = useState(false);
  const [current, setCurrent] = useState<"up" | "down" | null>(
    feedback ?? null,
  );
  const [busy, setBusy] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("复制失败", err);
    }
  }, [content]);

  const handleFeedback = useCallback(
    async (next: "up" | "down") => {
      if (busy) return;
      const target = current === next ? null : next;
      const prev = current;
      setCurrent(target);
      setBusy(true);
      try {
        await setMessageFeedback(sessionId, messageId, target);
      } catch (err) {
        console.error("反馈失败", err);
        setCurrent(prev);
      } finally {
        setBusy(false);
      }
    },
    [busy, current, sessionId, messageId],
  );

  return (
    <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
      <button
        type="button"
        onClick={handleCopy}
        title={copied ? t("actions.copied") : t("actions.copy")}
        className={BTN}
      >
        {copied ? (
          <Check className="h-3.5 w-3.5" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
      </button>

      {usage && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" title={t("actions.usage")} className={BTN}>
              <Info className="h-3.5 w-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>
            <div className="space-y-0.5 text-xs">
              <div>{usage.model}</div>
              <div>
                {t("usage.inputLabel")} {formatTokens(usage.inputTokens)}
                {usage.cacheReadTokens > 0 &&
                  `（${t("usage.cacheLabel")} ${formatTokens(usage.cacheReadTokens)}）`}
              </div>
              <div>
                {t("usage.outputLabel")} {formatTokens(usage.outputTokens)}
                {usage.reasoningTokens > 0 &&
                  `（${t("usage.reasoningLabel")} ${formatTokens(usage.reasoningTokens)}）`}
              </div>
              <div>
                {t("usage.totalLabel")} {formatTokens(usage.totalTokens)}
              </div>
            </div>
          </TooltipContent>
        </Tooltip>
      )}

      <button
        type="button"
        onClick={() => handleFeedback("up")}
        disabled={busy}
        title={t("actions.like")}
        className={cn(BTN, current === "up" && "text-accent hover:text-accent")}
      >
        <ThumbsUp className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={() => handleFeedback("down")}
        disabled={busy}
        title={t("actions.dislike")}
        className={cn(
          BTN,
          current === "down" && "text-accent hover:text-accent",
        )}
      >
        <ThumbsDown className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
```

- [ ] **Step 2: typecheck**

Run: `pnpm --filter @meshbot/web-agent typecheck`
Expected: 通过。

- [ ] **Step 3: Commit**

```bash
git add apps/web-agent/src/components/session/assistant-message-actions.tsx
git commit -m "feat(web-agent): AssistantMessageActions 组件（复制/用量/点赞/不喜欢）"
```

---

## Task 7: 接入 message-list + 透传 feedback

**Files:**
- Modify: `apps/web-agent/src/components/session/message-list.tsx`
- Modify: `apps/web-agent/src/app/session/page.tsx`

- [ ] **Step 1: TimelineMessage 加 feedback 字段**

在 `apps/web-agent/src/components/session/message-list.tsx` 的 `TimelineMessage` 接口（`message-list.tsx:25-59`）里，`metadata` 字段之后、接口结束 `}` 之前追加：
```typescript
  /** assistant 反馈态（来自 history）：up=点赞 down=不喜欢 null=未评价。 */
  feedback?: "up" | "down" | null;
```

- [ ] **Step 2: import AssistantMessageActions**

在 message-list.tsx 顶部 import 区加：
```typescript
import { AssistantMessageActions } from "./assistant-message-actions";
```

- [ ] **Step 3: 用 actions 替换纯文字用量行**

把 message-list.tsx 的 assistant 用量块（`message-list.tsx:166-171`）：
```typescript
              {m.role === "assistant" &&
                m.content &&
                usageByMessage?.[m.id] && (
                  <div className="text-[11px] text-muted-foreground">
                    {renderUsageLine(usageByMessage[m.id], t)}
                  </div>
                )}
```
替换为：
```typescript
              {m.role === "assistant" && m.content && !m.streaming && (
                <AssistantMessageActions
                  sessionId={sessionId}
                  messageId={m.id}
                  content={m.content}
                  usage={usageByMessage?.[m.id]}
                  feedback={m.feedback}
                />
              )}
```

- [ ] **Step 4: 删除现已无用的 renderUsageLine + 清理无用 import**

删除 `renderUsageLine` 函数（`message-list.tsx:273-289` 整个函数）。然后检查 `formatTokens` 是否在文件内还有其它使用：
Run: `grep -n "formatTokens\|renderUsageLine" apps/web-agent/src/components/session/message-list.tsx`
- 若 `formatTokens` 仅剩 import 行（无其它调用），删掉它的 import。
- 若 `t` 参数仅 renderUsageLine 用到而其它地方仍用 `t`，保留 `useTranslations`。
（biome 会报未用变量/导入；以 `pnpm --filter @meshbot/web-agent typecheck` + 提交时 lint-staged 为准，确保无 unused。）

- [ ] **Step 5: session/page.tsx —— history→timeline 映射带入 feedback**

定位 history（`fetchHistory` / `HistoryMessage`）转换成 `TimelineMessage` 的位置：
Run: `grep -rn "fetchHistory\|role:\|reasoning:\|toolCalls:" apps/web-agent/src/app/session/page.tsx | head -30`
找到把后端 history message（记为 `h`/`m`）映射为 timeline 对象的那处（对象里出现 `id:`、`role:`、`content:`、`metadata:` 等字段赋值）。在该对象字面量里追加一行：
```typescript
            feedback: h.feedback ?? null,
```
（变量名以该处实际形参为准——可能是 `h`、`msg` 或 `m`；只在「由 HistoryMessage 构造 TimelineMessage」这一处加，socket 新建的 assistant 消息无需加，默认 undefined→视为未评价。）

- [ ] **Step 6: typecheck**

Run: `pnpm --filter @meshbot/web-agent typecheck`
Expected: 通过（无 unused、无类型错误）。

- [ ] **Step 7: Commit**

```bash
git add apps/web-agent/src/components/session/message-list.tsx apps/web-agent/src/app/session/page.tsx
git commit -m "feat(web-agent): assistant 气泡接入 action row + 透传 feedback"
```

---

## Task 8: 整体验证

**Files:** 无（验证）

- [ ] **Step 1: 类型 + 单测 + 围栏 + locales**

Run:
```bash
pnpm typecheck
pnpm test -- session-message-feedback
pnpm check
pnpm sync:locales -- --check
```
Expected: typecheck 全过；feedback 单测 2 passed；6 围栏 green（check:repo：新端点经 `SessionMessageService`，未注入 Repo）；locales `missing=0, asymmetric=0`。

- [ ] **Step 2: 手动验证**

启动 `pnpm dev:server-agent` + `pnpm dev:web-agent`，进一个有 assistant 回复的会话：
- hover assistant 气泡 → 下方出现操作行：复制 / 用量(有 usage 时) / 点赞 / 不喜欢；流式生成中不显示。
- 点复制 → 剪贴板得到该条 markdown 原文，图标 2s 变 Check。
- hover 用量 Info → tooltip 显示 model + 输入/输出/总计（缓存/推理 token >0 时追加）；原纯文字用量行已消失。
- 点赞高亮；再点取消；点不喜欢切换为不喜欢。刷新会话 → 反馈态保留。

- [ ] **Step 3: 收尾**

Run: `git log --oneline -8`
确认 7 个功能 commit 就位。计划完成。

---

## Self-Review

**Spec coverage：**
- 复制 → Task 6（handleCopy）+ Task 7（接入）。✓
- 用量 icon+tooltip 取代文字行 → Task 6（Tooltip）+ Task 7 Step 3/4（替换 + 删 renderUsageLine）。✓
- 点赞/不喜欢互斥 toggle + 持久化 → Task 1（schema）+ Task 2（setFeedback）+ Task 3（端点 + history feedback）+ Task 4（rest）+ Task 6（toggle 乐观）+ Task 7 Step 5（初始态透传）。✓
- hover 才显示 → Task 6（`opacity-0 group-hover:opacity-100`，外层 `.group` 已存在于 message-list:109）。✓
- 刷新保留 → metadata 持久化（Task 2）+ history 带出（Task 3）+ timeline 透传（Task 7 Step 5）+ 组件初始态（Task 6）。✓
- i18n → Task 5（actions）+ 复用 usage.*。✓

**Placeholder scan：** 无 TBD；每步给完整代码/命令。Task 7 Step 5 的变量名因 mapping 处未取到 verbatim 而留了「以实际形参为准」的判断说明 + 定位 grep（整合性任务，非占位）。

**Type consistency：** `feedback: "up"|"down"|null` 贯穿 schema(Task1)/service(Task2)/endpoint(Task3)/rest(Task4)/component(Task6)/TimelineMessage(Task7) 一致；`MessageFeedbackSchema`/`MessageFeedbackDto`/`MessageFeedbackInput` 命名一致；`setMessageFeedback`(前端) vs `setFeedback`(后端 service) 命名有意区分、各自自洽；`MessageUsage` 复用既有类型。

**已知整合点（非阻塞）：** Task 7 Step 5 需在 session/page.tsx 实际的 history→timeline 映射处补 `feedback`；用 grep 定位，字段名 `feedback` 固定，仅源变量名随上下文。
