# 问题选项（ask_question，HITL）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 加 `ask_question` 工具：agent 弹一组问题（1–4，每个带选项 label/description、单/多选、固定「其他」输入），挂起等用户提交，拿到选择续答。

**Architecture:** HITL 复用并泛化 `ConfirmationService`（`waitForDecision<T>`/`resolve<T>`，默认泛型 `ConfirmDecision` 使 im_send 零改动）；ask 自带 工具/`ASK_QUESTION_PORT`/`AskQuestionService`/`@Global AskQuestionModule`/`POST /answer` 端点/`AskQuestionCard`。镜像 im_send_message 全套。

**Tech Stack:** NestJS（server-agent，jest）/ libs/agent（vitest）/ Next.js+Jotai（web-agent，jest）/ Zod。

## Global Constraints

- **单例 ConfirmationService 不变量**：仍只由 `ImSendModule`（@Global）provide 唯一实例；`AskQuestionModule` **不得**重新 provide ConfirmationService（注入全局那个），否则 await/resolve 分裂、确认静默 no-op。
- **im_send 零回归**：`ConfirmationService` 泛型默认 `ConfirmDecision`，im_send 的 service/端点/spec **不改**；其全套测试必须仍绿。
- libs/agent 框架无关：`ask_question` 纯 `@Tool()`，只依赖 `ASK_QUESTION_PORT`（返回 string）。libs/types-* 纯 Zod/TS。
- 账号作用域：answer 端点 key 含 `account.getOrThrow()` 的 cloudUserId。
- fail-safe：超时（120s）/abort/未提交 → 非 answered。
- 中文 JSDoc；不在 `if` 前一行放注释；中文提交；commit 前 `pnpm check`。

---

## File Structure

**新建**：`libs/types-agent/src/ask-question.ts`(+spec)、`libs/agent/src/tools/ask-question.port.ts`、`libs/agent/src/tools/builtins/ask-question.tool.ts`(+test)、`apps/server-agent/src/services/ask-question.service.ts`(+spec)、`apps/server-agent/src/ask-question.module.ts`、`apps/web-agent/src/components/session/ask-question-card.tsx`。
**改**：`libs/types-agent/src/index.ts`、`libs/agent/src/index.ts`、`libs/agent/src/agent.module.ts`、`apps/server-agent/src/services/confirmation.service.ts`(+spec)、`apps/server-agent/src/controllers/session.controller.ts`、`apps/server-agent/src/dto/session.dto.ts`、`apps/server-agent/src/app.module.ts`、`apps/web-agent/src/rest/session.ts`、`apps/web-agent/src/components/session/tool-call-block.tsx`。

---

## Task 1: types-agent — ask/answer schema

**Files:** Create `libs/types-agent/src/ask-question.ts` + `ask-question.spec.ts`；Modify `libs/types-agent/src/index.ts`

**Interfaces:** Produces `askQuestionSchema` → `{ questions: AskQuestion[] }`；`answerQuestionsSchema` → `{ toolCallId; answers: AnswerItem[] }`；类型 `AskQuestion`、`AskQuestionInput`、`AnswerItem`、`AnswerQuestionsInput`。

- [ ] **Step 1: 写失败单测** — 创建 `libs/types-agent/src/ask-question.spec.ts`：

```ts
import { describe, expect, it } from "@jest/globals";
import { answerQuestionsSchema, askQuestionSchema } from "./ask-question";

describe("askQuestionSchema", () => {
  it("接受 1 个带选项的问题", () => {
    const p = askQuestionSchema.parse({
      questions: [
        { question: "选哪个?", options: [{ label: "A" }, { label: "B", description: "乙" }], multiSelect: false },
      ],
    });
    expect(p.questions).toHaveLength(1);
    expect(p.questions[0].options[1].description).toBe("乙");
  });
  it("questions 1–4，超出/为空报错", () => {
    expect(() => askQuestionSchema.parse({ questions: [] })).toThrow();
    const five = Array.from({ length: 5 }, () => ({ question: "q", options: [{ label: "A" }], multiSelect: false }));
    expect(() => askQuestionSchema.parse({ questions: five })).toThrow();
  });
  it("options 至少 1 项、question 非空", () => {
    expect(() => askQuestionSchema.parse({ questions: [{ question: "q", options: [], multiSelect: false }] })).toThrow();
    expect(() => askQuestionSchema.parse({ questions: [{ question: "", options: [{ label: "A" }], multiSelect: false }] })).toThrow();
  });
});

describe("answerQuestionsSchema", () => {
  it("接受 toolCallId + answers(selected + 可选 other)", () => {
    const p = answerQuestionsSchema.parse({
      toolCallId: "t",
      answers: [{ selected: ["A"], other: "自定义" }, { selected: [] }],
    });
    expect(p.answers[0].selected).toEqual(["A"]);
    expect(p.answers[1].other).toBeUndefined();
  });
  it("缺 toolCallId 报错", () => {
    expect(() => answerQuestionsSchema.parse({ answers: [] })).toThrow();
  });
});
```

- [ ] **Step 2: 跑测试确认失败** — `pnpm test -- libs/types-agent/src/ask-question.spec.ts`（FAIL，模块不存在）。

- [ ] **Step 3: 实现** — 创建 `libs/types-agent/src/ask-question.ts`：

```ts
import { z } from "zod";

/** 单个选项：label + 可选一行解释。 */
export const askOptionSchema = z.object({
  label: z.string().min(1),
  description: z.string().optional(),
});

/** 单个问题：文本 + 可选短标签 + 选项 + 单/多选。 */
export const askQuestionItemSchema = z.object({
  question: z.string().min(1),
  header: z.string().optional(),
  options: z.array(askOptionSchema).min(1),
  multiSelect: z.boolean(),
});
export type AskQuestion = z.infer<typeof askQuestionItemSchema>;

/** ask_question 入参：1–4 个问题。 */
export const askQuestionSchema = z.object({
  questions: z.array(askQuestionItemSchema).min(1).max(4),
});
export type AskQuestionInput = z.infer<typeof askQuestionSchema>;

/** 单个问题的回答：选中的 option label（单选 ≤1）+ 「其他」文本。 */
export const answerItemSchema = z.object({
  selected: z.array(z.string()),
  other: z.string().optional(),
});
export type AnswerItem = z.infer<typeof answerItemSchema>;

/** POST /answer 入参。 */
export const answerQuestionsSchema = z.object({
  toolCallId: z.string().min(1),
  answers: z.array(answerItemSchema),
});
export type AnswerQuestionsInput = z.infer<typeof answerQuestionsSchema>;
```

- [ ] **Step 4: 跑通过** — 同 Step 2 命令，PASS。
- [ ] **Step 5: 导出 + 提交** — index.ts 加 `export * from "./ask-question";`；

```bash
pnpm turbo typecheck --filter=@meshbot/types-agent
git add libs/types-agent/src/ask-question.ts libs/types-agent/src/ask-question.spec.ts libs/types-agent/src/index.ts
git commit -m "feat(types-agent): ask_question / answer 端点 schema"
```

---

## Task 2: ConfirmationService 泛型化（im_send 零回归）

**Files:** Modify `apps/server-agent/src/services/confirmation.service.ts` + `confirmation.service.spec.ts`

**Interfaces:** Produces `waitForDecision<T = ConfirmDecision>(key, signal, timeoutMs): Promise<T | "timeout" | "aborted">`；`resolve<T = ConfirmDecision>(key, decision: T): boolean`。`ConfirmDecision` / `AwaitOutcome` 保留（im_send 用）。

- [ ] **Step 1: 写失败单测** — 在 `confirmation.service.spec.ts` 末尾（最后一个 `it` 之后、`});` 之前）加泛型用例：

```ts
  it("泛型 resolve/waitForDecision 支持任意 payload（非 send/cancel）", async () => {
    const svc = new ConfirmationService();
    const ac = new AbortController();
    const p = svc.waitForDecision<{ answers: string[] }>("k", ac.signal, 10_000);
    expect(svc.resolve<{ answers: string[] }>("k", { answers: ["A", "B"] })).toBe(true);
    await expect(p).resolves.toEqual({ answers: ["A", "B"] });
  });
```

- [ ] **Step 2: 跑确认失败** — `pnpm test -- apps/server-agent/src/services/confirmation.service.spec.ts`（FAIL：当前 `resolve`/`waitForDecision` 非泛型，TS 编译错或类型不符）。

- [ ] **Step 3: 实现泛型化** — 改 `confirmation.service.ts`：① `pending` 改 `Map<string, (d: unknown) => void>`；② `waitForDecision` 加 `<T = ConfirmDecision>`、返回 `Promise<T | "timeout" | "aborted">`、内部 `this.pending.set(key, (decision) => { cleanup(); resolve(decision as T); })`、`if (signal.aborted) return Promise.resolve("aborted");`；③ `resolve` 加 `<T = ConfirmDecision>(key: string, decision: T)`。`ConfirmDecision`/`AwaitOutcome` 定义保留不动。改后全文：

```ts
import { Injectable } from "@nestjs/common";

/** 用户对一次待审批工具调用的决定（im_send 默认载荷）。 */
export type ConfirmDecision = { action: "send" | "cancel"; content?: string };

/** im_send 的 waitForDecision 结果（默认泛型下的便捷别名）。 */
export type AwaitOutcome = ConfirmDecision | "timeout" | "aborted";

/**
 * 内存确认管理（通用 HITL 挂起核心）：工具挂起时 waitForDecision 注册 deferred 并
 * race（超时 + abort）；前端经 confirm/answer 端点 resolve 解锁。decision 泛型，
 * 默认 ConfirmDecision 以兼容 im_send；ask_question 传自己的载荷。单用户本地轨，无需持久化。
 */
@Injectable()
export class ConfirmationService {
  private readonly pending = new Map<string, (d: unknown) => void>();

  /** 确认 key：账号 + 会话 + 工具调用，三段唯一，含 cloudUserId 防跨账号解锁。 */
  static key(cloudUserId: string, sessionId: string, toolCallId: string): string {
    return `${cloudUserId}:${sessionId}:${toolCallId}`;
  }

  /** 注册并等待用户决定；race 超时 + abort；任一路径都清理注册项。 */
  waitForDecision<T = ConfirmDecision>(
    key: string,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<T | "timeout" | "aborted"> {
    if (signal.aborted) {
      return Promise.resolve("aborted");
    }
    return new Promise<T | "timeout" | "aborted">((resolve) => {
      const cleanup = () => {
        this.pending.delete(key);
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve("timeout");
      }, timeoutMs);
      const onAbort = () => {
        cleanup();
        resolve("aborted");
      };
      signal.addEventListener("abort", onAbort);
      this.pending.set(key, (decision) => {
        cleanup();
        resolve(decision as T);
      });
    });
  }

  /** 解锁某 key 的等待。key 不存在 → no-op 返回 false。 */
  resolve<T = ConfirmDecision>(key: string, decision: T): boolean {
    const fn = this.pending.get(key);
    if (!fn) {
      return false;
    }
    fn(decision);
    return true;
  }
}
```

- [ ] **Step 4: 跑通过 + im_send 回归** —
  - `pnpm test -- apps/server-agent/src/services/confirmation.service.spec.ts`（PASS，含新泛型用例）。
  - 回归：`pnpm test -- apps/server-agent/src/services/im-send.service.spec.ts apps/server-agent/src/controllers/session-confirm.controller.spec.ts`（im_send 全绿，零改动）。
  - `pnpm turbo typecheck --filter=@meshbot/server-agent`（绿——im_send 默认泛型 ConfirmDecision，调用处不报错）。

- [ ] **Step 5: 提交**

```bash
git add apps/server-agent/src/services/confirmation.service.ts apps/server-agent/src/services/confirmation.service.spec.ts
git commit -m "refactor(server-agent): ConfirmationService 泛型化(默认 ConfirmDecision，im_send 零改)"
```

---

## Task 3: libs/agent — ASK_QUESTION_PORT + 工具 + 注册

**Files:** Create `libs/agent/src/tools/ask-question.port.ts`、`libs/agent/src/tools/builtins/ask-question.tool.ts`、`libs/agent/tests/unit/ask-question.tool.test.ts`；Modify `libs/agent/src/index.ts`、`libs/agent/src/agent.module.ts`

**Interfaces:** Consumes `askQuestionSchema`/`AskQuestionInput`（Task 1）。Produces `ASK_QUESTION_PORT`、`AskQuestionPort.ask({sessionId, toolCallId}, signal): Promise<string>`；工具名 `ask_question`。

- [ ] **Step 1: 端口** — 创建 `libs/agent/src/tools/ask-question.port.ts`：

```ts
/**
 * ASK_QUESTION_PORT —— libs/agent → server-agent 解耦端口（HITL 问题选项）。
 * ask_question 工具经此端口「弹问题卡、挂起等用户提交」；server-agent 实现复用
 * ConfirmationService 挂起。无 server-agent 环境（测试）可不注入。
 */
export const ASK_QUESTION_PORT = Symbol("ASK_QUESTION_PORT");

/** 弹问题卡并等用户回答端口。 */
export interface AskQuestionPort {
  /** 挂起等用户提交；返回结果 JSON 字符串：
   *  {"status":"answered", answers:[...]} | {"status":"timeout"|"interrupted"}。 */
  ask(
    params: { sessionId: string; toolCallId: string },
    signal: AbortSignal,
  ): Promise<string>;
}
```

- [ ] **Step 2: 写失败单测** — 创建 `libs/agent/tests/unit/ask-question.tool.test.ts`：

```ts
import { describe, expect, it, vi } from "vitest";
import type { AskQuestionPort } from "../../src/tools/ask-question.port";
import { AskQuestionTool } from "../../src/tools/builtins/ask-question.tool";

describe("ask_question tool", () => {
  it("把 ctx.sessionId/toolCallId/signal 透传给 port.ask 并原样返回", async () => {
    const port: AskQuestionPort = {
      ask: vi.fn().mockResolvedValue('{"status":"answered","answers":[]}'),
    };
    const tool = new AskQuestionTool(port);
    expect(tool.name).toBe("ask_question");
    const signal = new AbortController().signal;
    const out = await tool.execute(
      { questions: [{ question: "q", options: [{ label: "A" }], multiSelect: false }] },
      { sessionId: "s1", toolCallId: "tc1", signal } as never,
    );
    expect(out).toBe('{"status":"answered","answers":[]}');
    expect(port.ask).toHaveBeenCalledWith({ sessionId: "s1", toolCallId: "tc1" }, signal);
  });
});
```

- [ ] **Step 3: 跑确认失败** — `cd libs/agent && npx vitest run tests/unit/ask-question.tool.test.ts`（FAIL）。

- [ ] **Step 4: 实现工具** — 创建 `libs/agent/src/tools/builtins/ask-question.tool.ts`：

```ts
import { type AskQuestionInput, askQuestionSchema } from "@meshbot/types-agent";
import { Inject, Injectable } from "@nestjs/common";
import { ASK_QUESTION_PORT, type AskQuestionPort } from "../ask-question.port";
import { Tool } from "../tool.decorator";
import type { MeshbotTool, ToolContext } from "../tool.types";

@Injectable()
@Tool()
export class AskQuestionTool implements MeshbotTool<AskQuestionInput, string> {
  readonly name = "ask_question";
  readonly description =
    "Ask the user to choose among explicit options when you genuinely need their " +
    "decision. Provide 1-4 questions, each with clear option labels (and optional " +
    "description), single- or multi-select. An 'other' free-text input is always added. " +
    "The call blocks until the user submits. Do NOT use for things you can decide " +
    "yourself or single-fact lookups. Returns JSON: status answered (with answers) / " +
    "timeout / interrupted.";
  readonly schema = askQuestionSchema;

  constructor(@Inject(ASK_QUESTION_PORT) private readonly port: AskQuestionPort) {}

  /** 弹问题卡、挂起等用户提交；返回 {status, answers} JSON 字符串。 */
  execute(_args: AskQuestionInput, ctx: ToolContext): Promise<string> {
    return this.port.ask(
      { sessionId: ctx.sessionId, toolCallId: ctx.toolCallId },
      ctx.signal,
    );
  }
}
```

- [ ] **Step 5: 跑通过** — 同 Step 3，PASS。
- [ ] **Step 6: 导出 + 注册** —
  - `libs/agent/src/index.ts`：仿 `IM_SEND_PORT` 导出处加 `export { ASK_QUESTION_PORT } from "./tools/ask-question.port";` 与 `export type { AskQuestionPort } from "./tools/ask-question.port";`（先 `rg -n "IM_SEND_PORT" libs/agent/src/index.ts` 确认风格）。
  - `agent.module.ts`：import `AskQuestionTool` + providers 数组（`ImSendMessageTool,` 之后）加 `AskQuestionTool,`。
- [ ] **Step 7: typecheck + 提交**

```bash
pnpm turbo typecheck --filter=@meshbot/agent
git add libs/agent/src/tools/ask-question.port.ts libs/agent/src/tools/builtins/ask-question.tool.ts libs/agent/tests/unit/ask-question.tool.test.ts libs/agent/src/index.ts libs/agent/src/agent.module.ts
git commit -m "feat(agent): ask_question 工具 + ASK_QUESTION_PORT"
```

---

## Task 4: server-agent — AskQuestionService + module + answer 端点

**Files:** Create `apps/server-agent/src/services/ask-question.service.ts` + `ask-question.service.spec.ts`、`apps/server-agent/src/ask-question.module.ts`；Modify `apps/server-agent/src/controllers/session.controller.ts`、`apps/server-agent/src/dto/session.dto.ts`、`apps/server-agent/src/app.module.ts`

**Interfaces:** Consumes `ASK_QUESTION_PORT`/`AskQuestionPort`（Task 3）、`answerQuestionsSchema`（Task 1）、`ConfirmationService`（Task 2，全局）、`AccountContextService`。Produces `POST /api/sessions/:sessionId/answer`。

- [ ] **Step 1: 写失败单测** — 创建 `apps/server-agent/src/services/ask-question.service.spec.ts`：

```ts
import type { AccountContextService } from "@meshbot/agent";
import { ConfirmationService } from "./confirmation.service";
import { AskQuestionService } from "./ask-question.service";

function make(outcome: unknown) {
  const confirmation = { waitForDecision: jest.fn().mockResolvedValue(outcome) } as unknown as ConfirmationService;
  const account = { getOrThrow: () => "u1" } as AccountContextService;
  return new AskQuestionService(confirmation, account);
}
const params = { sessionId: "s1", toolCallId: "tc1" };

describe("AskQuestionService.ask", () => {
  it("answered → 返回 status answered + answers", async () => {
    const svc = make({ answers: [{ selected: ["A"], other: "" }] });
    const out = JSON.parse(await svc.ask(params, new AbortController().signal));
    expect(out.status).toBe("answered");
    expect(out.answers).toEqual([{ selected: ["A"], other: "" }]);
  });
  it("timeout → status timeout", async () => {
    const out = JSON.parse(await make("timeout").ask(params, new AbortController().signal));
    expect(out.status).toBe("timeout");
  });
  it("aborted → status interrupted", async () => {
    const out = JSON.parse(await make("aborted").ask(params, new AbortController().signal));
    expect(out.status).toBe("interrupted");
  });
});
```

- [ ] **Step 2: 跑确认失败** — `pnpm test -- apps/server-agent/src/services/ask-question.service.spec.ts`（FAIL）。

- [ ] **Step 3: 实现 service** — 创建 `apps/server-agent/src/services/ask-question.service.ts`：

```ts
import { AccountContextService } from "@meshbot/agent";
import type { AskQuestionPort } from "@meshbot/agent";
import type { AnswerItem } from "@meshbot/types-agent";
import { Injectable } from "@nestjs/common";
import { ConfirmationService } from "./confirmation.service";

/** 用户提交的回答载荷（answer 端点 resolve 的内容）。 */
export type AnswerPayload = { answers: AnswerItem[] };

/** 问题卡挂起超时（无人提交则 fail-safe 不算回答）。 */
export const ASK_CONFIRM_TIMEOUT_MS = 120_000;

/**
 * ASK_QUESTION_PORT 实现：经 ConfirmationService 挂起等用户提交，返回 {status} JSON。
 */
@Injectable()
export class AskQuestionService implements AskQuestionPort {
  constructor(
    private readonly confirmation: ConfirmationService,
    private readonly account: AccountContextService,
  ) {}

  /** 挂起等用户提交答案；超时/中断 fail-safe。 */
  async ask(
    params: { sessionId: string; toolCallId: string },
    signal: AbortSignal,
  ): Promise<string> {
    const key = ConfirmationService.key(
      this.account.getOrThrow(),
      params.sessionId,
      params.toolCallId,
    );
    const outcome = await this.confirmation.waitForDecision<AnswerPayload>(
      key,
      signal,
      ASK_CONFIRM_TIMEOUT_MS,
    );
    if (outcome === "timeout") {
      return JSON.stringify({ status: "timeout" });
    }
    if (outcome === "aborted") {
      return JSON.stringify({ status: "interrupted" });
    }
    return JSON.stringify({ status: "answered", answers: outcome.answers });
  }
}
```

- [ ] **Step 4: 跑通过** — 同 Step 2，PASS（3 用例）。

- [ ] **Step 5: @Global module** — 创建 `apps/server-agent/src/ask-question.module.ts`：

```ts
import { ASK_QUESTION_PORT } from "@meshbot/agent";
import { Global, Module } from "@nestjs/common";
import { AskQuestionService } from "./services/ask-question.service";

/**
 * @Global ask_question 模块：绑定 ASK_QUESTION_PORT 到 AskQuestionService。
 * ConfirmationService / AccountContextService 由全局模块提供（ImSendModule @Global
 * 导出唯一 ConfirmationService 实例，此处注入同一个，勿重复 provide）。
 */
@Global()
@Module({
  providers: [
    AskQuestionService,
    { provide: ASK_QUESTION_PORT, useExisting: AskQuestionService },
  ],
  exports: [ASK_QUESTION_PORT],
})
export class AskQuestionModule {}
```

- [ ] **Step 6: 注册 module + answer 端点 + DTO** —
  - `app.module.ts`：import `AskQuestionModule`，在 imports 数组 `ImSendModule` 之后加（先 `rg -n "ImSendModule" apps/server-agent/src/app.module.ts` 定位）。
  - `dto/session.dto.ts`：import `answerQuestionsSchema` + 加 `export class AnswerQuestionsDto extends createZodDto(answerQuestionsSchema) {}`。
  - `session.controller.ts`：import `answerQuestionsSchema`（@meshbot/types-agent）、`AnswerQuestionsDto`（../dto/session.dto），在现有 `confirm` 方法之后加：

```ts
  /** 提交一组问题的回答，解锁挂起的 ask_question 工具。 */
  @Post(":sessionId/answer")
  @ApiOperation({ summary: "提交 ask_question 的回答" })
  answer(
    @Param("sessionId") sessionId: string,
    @Body() body: AnswerQuestionsDto,
  ): { ok: true } {
    const { toolCallId, answers } = answerQuestionsSchema.parse(body);
    const key = ConfirmationService.key(
      this.account.getOrThrow(),
      sessionId,
      toolCallId,
    );
    this.confirmation.resolve(key, { answers });
    return { ok: true };
  }
```

- [ ] **Step 7: typecheck + 提交**

```bash
pnpm turbo typecheck --filter=@meshbot/server-agent
git add apps/server-agent/src/services/ask-question.service.ts apps/server-agent/src/services/ask-question.service.spec.ts apps/server-agent/src/ask-question.module.ts apps/server-agent/src/controllers/session.controller.ts apps/server-agent/src/dto/session.dto.ts apps/server-agent/src/app.module.ts
git commit -m "feat(server-agent): AskQuestionService + @Global 绑定 + POST /answer"
```

---

## Task 5: web-agent — confirmAnswers + AskQuestionCard + 特判

**Files:** Modify `apps/web-agent/src/rest/session.ts`、`apps/web-agent/src/components/session/tool-call-block.tsx`；Create `apps/web-agent/src/components/session/ask-question-card.tsx`

**Interfaces:** Consumes `AskQuestion`/`AnswerItem`（@meshbot/types-agent）、`ToolCallView`（./message-list）、`apiClient`。

- [ ] **Step 1: rest 封装** — `apps/web-agent/src/rest/session.ts` 仿 `confirmSend` 加：

```ts
/** 提交 ask_question 的回答（每问题 {selected, other}，按 question 顺序）。 */
export async function confirmAnswers(
  sessionId: string,
  toolCallId: string,
  answers: { selected: string[]; other?: string }[],
): Promise<{ ok: true }> {
  const { data } = await apiClient.post<{ ok: true }>(
    `/api/sessions/${sessionId}/answer`,
    { toolCallId, answers },
  );
  return data;
}
```

- [ ] **Step 2: AskQuestionCard** — 创建 `apps/web-agent/src/components/session/ask-question-card.tsx`：

```tsx
"use client";

import type { AskQuestion } from "@meshbot/types-agent";
import { Check, Loader2, Send } from "lucide-react";
import { useState } from "react";
import { confirmAnswers } from "@/rest/session";
import type { ToolCallView } from "./message-list";

const OTHER = "__other__";

/** ask_question 的问题卡：每问题单/多选 + 「其他」输入，提交后解锁工具。 */
export function AskQuestionCard({
  tool,
  sessionId,
}: {
  tool: ToolCallView;
  sessionId: string;
}) {
  const questions =
    ((tool.args ?? {}) as { questions?: AskQuestion[] }).questions ?? [];
  const [picks, setPicks] = useState<Record<number, Set<string>>>({});
  const [others, setOthers] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);

  const pending = tool.status === "running";
  const result = parseStatus(tool.result);

  const toggle = (qi: number, label: string, multi: boolean) => {
    setPicks((prev) => {
      const cur = new Set(prev[qi] ?? []);
      if (multi) {
        if (cur.has(label)) {
          cur.delete(label);
        } else {
          cur.add(label);
        }
      } else {
        cur.clear();
        cur.add(label);
      }
      return { ...prev, [qi]: cur };
    });
  };

  const submit = async () => {
    setBusy(true);
    const answers = questions.map((_q, qi) => {
      const sel = [...(picks[qi] ?? [])];
      const hasOther = sel.includes(OTHER);
      const selected = sel.filter((s) => s !== OTHER);
      const other = hasOther ? others[qi]?.trim() || undefined : undefined;
      return { selected, other };
    });
    try {
      await confirmAnswers(sessionId, tool.toolCallId, answers);
    } catch {
      setBusy(false);
    }
  };

  if (!pending) {
    return (
      <div className="flex w-full items-center gap-2 rounded-[8px] border border-border bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
        <Check className="h-3 w-3" /> {terminalLabel(result)}
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col gap-3 rounded-[8px] border border-border bg-muted/30 px-3 py-2">
      {questions.map((q, qi) => (
        <div key={q.question} className="flex flex-col gap-1.5">
          {q.header ? (
            <div className="text-[11px] font-semibold text-muted-foreground">{q.header}</div>
          ) : null}
          <div className="text-sm font-medium text-foreground">{q.question}</div>
          <div className="flex flex-col gap-1">
            {q.options.map((o) => (
              <Choice
                key={o.label}
                label={o.label}
                description={o.description}
                checked={picks[qi]?.has(o.label) ?? false}
                multi={q.multiSelect}
                onToggle={() => toggle(qi, o.label, q.multiSelect)}
              />
            ))}
            <Choice
              label="其他"
              checked={picks[qi]?.has(OTHER) ?? false}
              multi={q.multiSelect}
              onToggle={() => toggle(qi, OTHER, q.multiSelect)}
            />
            {picks[qi]?.has(OTHER) ? (
              <input
                value={others[qi] ?? ""}
                onChange={(e) => setOthers((p) => ({ ...p, [qi]: e.target.value }))}
                placeholder="自定义输入…"
                className="ml-5 rounded-md border border-border bg-background px-2 py-1 text-sm outline-none focus:border-primary"
              />
            ) : null}
          </div>
        </div>
      ))}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={submit}
          disabled={busy}
          className="flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />} 提交
        </button>
      </div>
    </div>
  );
}

function Choice({
  label,
  description,
  checked,
  multi,
  onToggle,
}: {
  label: string;
  description?: string;
  checked: boolean;
  multi: boolean;
  onToggle: () => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2 text-sm">
      <input
        type={multi ? "checkbox" : "radio"}
        checked={checked}
        onChange={onToggle}
        className="mt-1"
      />
      <span>
        <span className="text-foreground">{label}</span>
        {description ? (
          <span className="block text-xs text-muted-foreground">{description}</span>
        ) : null}
      </span>
    </label>
  );
}

function parseStatus(result?: string): string | null {
  if (!result) return null;
  try {
    return (JSON.parse(result) as { status?: string }).status ?? null;
  } catch {
    return null;
  }
}

function terminalLabel(status: string | null): string {
  switch (status) {
    case "answered":
      return "已提交";
    case "timeout":
      return "未回答（超时）";
    case "interrupted":
      return "已中断";
    default:
      return "已结束";
  }
}
```

- [ ] **Step 3: tool-call-block 特判** — `tool-call-block.tsx`：import `AskQuestionCard`，在现有 `im_send_message` 特判（`useState(open)` 之后）**之后**加：

```tsx
  if (tool.name === "ask_question" && tool.status !== "streaming") {
    return <AskQuestionCard tool={tool} sessionId={sessionId} />;
  }
```

- [ ] **Step 4: typecheck + 提交**

```bash
pnpm turbo typecheck --filter=@meshbot/web-agent
git add apps/web-agent/src/rest/session.ts apps/web-agent/src/components/session/ask-question-card.tsx apps/web-agent/src/components/session/tool-call-block.tsx
git commit -m "feat(web-agent): ask_question 问题卡（单/多选 + 其他）+ confirmAnswers"
```

---

## Task 6: 集成验证（boot + 全量 + 围栏）

> Task 4 新增 `@Global AskQuestionModule`（DI 变更）+ 工具注入 ASK_QUESTION_PORT。按铁律真启 server-agent 验证。

- [ ] **Step 1: 全包 typecheck** — `pnpm typecheck`，全绿。
- [ ] **Step 2: 全量 jest** — `pnpm test`：新增 ask 单测绿；**im_send 全套仍绿（回归）**；2 个失败套件仍是预存在基线（session.e2e、use-global-events.spec），零新增。
- [ ] **Step 3: libs/agent vitest** — `cd libs/agent && npx vitest run`：9 基线不变 + 新 ask-question.tool.test 绿。
- [ ] **Step 4: 真启 server-agent（关键）** — `pnpm dev:server-agent`：观察无 Nest DI 报错（尤其 `ASK_QUESTION_PORT` / `ConfirmationService` 单例）、迁移无关、启动 successfully started + 监听 3100。确认后停。
- [ ] **Step 5: 静态围栏** — `pnpm check`，exit 0（tx-fence `conversation.service.ts:280` 预存在基线 unchanged=1）。
- [ ] **Step 6: 手动冒烟（可选，需登录）** — 让助手在需要决策处调 ask_question：出现问题卡（单/多选 + 其他）→ 选/填 → 提交 → 助手据选择续答；另测超时/Stop 行为。

---

## Self-Review（已核对）

- **Spec 覆盖**：§2 HITL-B 泛化（Task 2，默认泛型使 im_send 零改）；§3 schema（Task 1）；§4 工具（Task 3）；§5 端口（Task 3）；§6 service+module+端点（Task 4）；§7 前端卡（Task 5）；§9 边界（fail-safe Task 4 timeout/aborted、账号作用域 key、单例 ConfirmationService 仍 ImSendModule 唯一 provide）；§10 测试（含 im_send 回归 Task 2/6 + boot Task 6）。
- **占位符**：无 TBD/TODO；每代码步完整代码 + 命令 + 预期。
- **类型一致**：`AskQuestionPort.ask({sessionId,toolCallId}, signal)` 在 port 定义（Task 3）、工具调用（Task 3）、AskQuestionService 实现（Task 4）三处一致；`AnswerPayload`/`AnswerItem`（selected/other）在 service、端点 resolve、前端 confirmAnswers/卡 一致；工具名 `"ask_question"` 在工具、tool-call-block 特判两处一致；`ConfirmationService.waitForDecision<T>/resolve<T>` 默认 `ConfirmDecision` 与 im_send 零改一致。
- **单例不变量**：AskQuestionModule 不 provide ConfirmationService（注入 ImSendModule @Global 导出的唯一实例）——Task 4 module 明确不含 ConfirmationService provider。
