# 助手发送 IM 回复（im_send_message + HITL 确认）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让助手能调 `im_send_message` 把回复发到某频道/私聊，但发出前在 UI 弹一张可编辑确认卡，用户点「发送」后工具才经既有 relay 真正发出，并把结果回传给 agent 续答。

**Architecture:** 应用层挂起 HITL——`im_send_message`（libs/agent）的 execute 调 `IM_SEND_PORT.confirmAndSend`，server-agent 的 `ImSendService` 在 `ConfirmationService` 注册一个按 `cloudUserId:sessionId:toolCallId` 命名的 deferred 并 await（race 超时 + abort）；前端把这次 tool-call 渲染成可编辑卡，[发送]/[取消] → `POST /api/sessions/:sessionId/confirm` → 解锁 deferred → `ImSendService` 经既有 `ImRelayClientService.send` 发出；工具返回 `{status}` JSON。

**Tech Stack:** NestJS（server-agent）/ LangGraph 自定义图（libs/agent）/ Next.js + Jotai（web-agent）/ Zod / jest（types-agent + server-agent + web-agent `.ts`）/ vitest（libs/agent）。

## Global Constraints

- libs/agent 框架无关：只 `@Injectable()`/`@Tool()`/`@Inject()`；禁 TypeORM/HTTP/`@Controller`。I/O 经端口。
- libs/types-* 纯 Zod/TS，无 NestJS/TypeORM。
- 公开方法中文 JSDoc；不在 `if` 前一行放注释（Biome 会破坏）。
- 提交中文 + conventional commits；commit 前 `pnpm check`。
- **安全 fail-safe**：超时（`IM_SEND_CONFIRM_TIMEOUT_MS = 120_000`）/ abort / 未点击，默认**不发**。
- **作用域**：发送经 `ImRelayClientService.send(account.getOrThrow(), {conversationId, content})`（账号作用域）；confirm key 含 `cloudUserId`，跨账号无法解锁。
- **复用既有发送通道**（`ImRelayClientService.send`，登录即连）；不新增 REST 发送端点、不新增 ws 事件、不动 companion 自动发帖。
- 确认态全内存，无新 TypeORM entity。
- 工具结果是给 LLM 的字符串；同时前端可 `JSON.parse` 出 `{status}` 渲染终态。

---

## File Structure

**新建：**
- `libs/agent/src/tools/im-send.port.ts` — `IM_SEND_PORT` + `ImSendPort` 接口。
- `libs/agent/src/tools/builtins/im-send-message.tool.ts` — `im_send_message` 工具。
- `libs/agent/tests/unit/im-send-message.tool.test.ts` — 工具 vitest 单测。
- `apps/server-agent/src/services/confirmation.service.ts` — 内存确认管理（register/race/resolve）。
- `apps/server-agent/src/services/confirmation.service.spec.ts` — jest 单测。
- `apps/server-agent/src/services/im-send.service.ts` — `IM_SEND_PORT` 实现（confirmAndSend 编排）。
- `apps/server-agent/src/services/im-send.service.spec.ts` — jest 单测。
- `apps/server-agent/src/im-send.module.ts` — `@Global` 绑定 `IM_SEND_PORT` + 导出 `ConfirmationService`。
- `apps/web-agent/src/components/session/im-send-confirm-card.tsx` — 可编辑确认卡组件。

**修改：**
- `libs/types-agent/src/im-tools.ts` — 加 `imSendMessageSchema`；`libs/types-agent/src/session.ts`（或新 `confirm.ts`）加 `confirmToolCallSchema`。
- `libs/agent/src/index.ts` — re-export `im-send.port`。
- `libs/agent/src/agent.module.ts` — providers 注册 `ImSendMessageTool`。
- `apps/server-agent/src/dto/session.dto.ts` — 加 `ConfirmToolCallDto`。
- `apps/server-agent/src/controllers/session.controller.ts` — 加 `POST :sessionId/confirm` + 注入 `ConfirmationService`/`AccountContextService`。
- `apps/server-agent/src/app.module.ts` — imports 注册 `ImSendModule`。
- `apps/web-agent/src/rest/session.ts` — 加 `confirmSend()`。
- `apps/web-agent/src/components/session/tool-call-block.tsx` — 特判 `im_send_message` → 渲染确认卡；加 `sessionId` prop。
- `apps/web-agent/src/components/session/message-list.tsx` — 给 `ToolCallBlock` 传 `sessionId`。

---

## Task 1: types-agent —— im_send_message 入参 + confirm 端点 schema

**Files:**
- Modify: `libs/types-agent/src/im-tools.ts`
- Create: `libs/types-agent/src/confirm.ts`
- Modify: `libs/types-agent/src/index.ts`
- Test: `libs/types-agent/src/confirm.spec.ts`

**Interfaces:**
- Produces: `imSendMessageSchema` → `{conversationId: string; content: string}` + `ImSendMessageInput`；`confirmToolCallSchema` → `{toolCallId: string; decision: "send"|"cancel"; content?: string}` + `ConfirmToolCallInput`。

- [ ] **Step 1: 写失败单测**

创建 `libs/types-agent/src/confirm.spec.ts`：

```ts
import { describe, expect, it } from "@jest/globals";
import { imSendMessageSchema } from "./im-tools";
import { confirmToolCallSchema } from "./confirm";

describe("imSendMessageSchema", () => {
  it("conversationId + content 必填非空", () => {
    expect(
      imSendMessageSchema.parse({ conversationId: "1", content: "hi" }),
    ).toEqual({ conversationId: "1", content: "hi" });
    expect(() => imSendMessageSchema.parse({ conversationId: "1" })).toThrow();
    expect(() =>
      imSendMessageSchema.parse({ conversationId: "1", content: "" }),
    ).toThrow();
  });
});

describe("confirmToolCallSchema", () => {
  it("decision 限 send/cancel；content 可选", () => {
    expect(
      confirmToolCallSchema.parse({ toolCallId: "t", decision: "send" }),
    ).toEqual({ toolCallId: "t", decision: "send" });
    expect(
      confirmToolCallSchema.parse({
        toolCallId: "t",
        decision: "send",
        content: "改后的",
      }).content,
    ).toBe("改后的");
    expect(() =>
      confirmToolCallSchema.parse({ toolCallId: "t", decision: "nope" }),
    ).toThrow();
    expect(() => confirmToolCallSchema.parse({ decision: "send" })).toThrow();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test -- libs/types-agent/src/confirm.spec.ts`
Expected: FAIL —— `imSendMessageSchema` / `confirmToolCallSchema` 不存在。

- [ ] **Step 3: 实现**

在 `libs/types-agent/src/im-tools.ts` 末尾追加：

```ts
/** im_send_message 入参（写侧；发出前经用户确认）。 */
export const imSendMessageSchema = z.object({
  conversationId: z.string().min(1),
  content: z.string().min(1),
});
export type ImSendMessageInput = z.infer<typeof imSendMessageSchema>;
```

创建 `libs/types-agent/src/confirm.ts`：

```ts
import { z } from "zod";

/** POST /api/sessions/:sessionId/confirm 请求体：确认/取消一次待审批的工具调用。 */
export const confirmToolCallSchema = z.object({
  toolCallId: z.string().min(1),
  decision: z.enum(["send", "cancel"]),
  content: z.string().optional(),
});
export type ConfirmToolCallInput = z.infer<typeof confirmToolCallSchema>;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test -- libs/types-agent/src/confirm.spec.ts`
Expected: PASS。

- [ ] **Step 5: 导出 + 提交**

在 `libs/types-agent/src/index.ts` 现有 `export * from "./im-tools";` 旁追加 `export * from "./confirm";`（`im-tools` 已导出，无需重复）。

```bash
pnpm turbo typecheck --filter=@meshbot/types-agent
git add libs/types-agent/src/im-tools.ts libs/types-agent/src/confirm.ts libs/types-agent/src/confirm.spec.ts libs/types-agent/src/index.ts
git commit -m "feat(types-agent): im_send_message 入参 + confirm 端点 schema"
```

---

## Task 2: libs/agent —— IM_SEND_PORT 端口

**Files:**
- Create: `libs/agent/src/tools/im-send.port.ts`
- Modify: `libs/agent/src/index.ts`

**Interfaces:**
- Produces: `IM_SEND_PORT: symbol`；`interface ImSendPort { confirmAndSend(params: { sessionId: string; toolCallId: string; conversationId: string; content: string }, signal: AbortSignal): Promise<string> }`（返回结果 JSON 字符串）。

- [ ] **Step 1: 实现端口**

创建 `libs/agent/src/tools/im-send.port.ts`：

```ts
/**
 * IM_SEND_PORT —— libs/agent → server-agent 解耦端口（写侧 + HITL 确认）。
 *
 * im_send_message 工具经此端口「请求确认并发送」：server-agent 实现负责弹卡等待、
 * 用户确认后经 relay 真正发出。无 server-agent 环境（测试）可不注入。
 */
export const IM_SEND_PORT = Symbol("IM_SEND_PORT");

/** 助手发送 IM 消息（发出前经用户 HITL 确认）端口。 */
export interface ImSendPort {
  /**
   * 请求用户确认并（确认后）发送。返回结果 JSON 字符串：
   * {"status":"sent"|"cancelled"|"timeout"|"interrupted"|"error", ...}
   * fail-safe：超时/中断默认不发。
   */
  confirmAndSend(
    params: {
      sessionId: string;
      toolCallId: string;
      conversationId: string;
      content: string;
    },
    signal: AbortSignal,
  ): Promise<string>;
}
```

- [ ] **Step 2: 导出**

先 `rg -n "im-context.port" libs/agent/src/index.ts` 看现有风格，按它在旁边追加（named export，与 IM_CONTEXT_PORT 同款）：

```ts
export { IM_SEND_PORT } from "./tools/im-send.port";
export type { ImSendPort } from "./tools/im-send.port";
```

- [ ] **Step 3: typecheck + 提交**

```bash
pnpm turbo typecheck --filter=@meshbot/agent
git add libs/agent/src/tools/im-send.port.ts libs/agent/src/index.ts
git commit -m "feat(agent): IM_SEND_PORT 写侧 HITL 端口"
```

---

## Task 3: libs/agent —— im_send_message 工具 + 注册

**Files:**
- Create: `libs/agent/src/tools/builtins/im-send-message.tool.ts`
- Test: `libs/agent/tests/unit/im-send-message.tool.test.ts`
- Modify: `libs/agent/src/agent.module.ts`

**Interfaces:**
- Consumes: `IM_SEND_PORT`/`ImSendPort`（Task 2）；`imSendMessageSchema`/`ImSendMessageInput`（Task 1）；`MeshbotTool`/`ToolContext`（`../tool.types`，`ToolContext` 含 `sessionId`/`toolCallId`/`signal`）；`@Tool`（`../tool.decorator`）。
- Produces: 工具名 `im_send_message`。

- [ ] **Step 1: 写失败单测**

创建 `libs/agent/tests/unit/im-send-message.tool.test.ts`：

```ts
import { describe, expect, it, vi } from "vitest";
import type { ImSendPort } from "../../src/tools/im-send.port";
import { ImSendMessageTool } from "../../src/tools/builtins/im-send-message.tool";

describe("im_send_message tool", () => {
  it("把 ctx.sessionId/toolCallId/signal + args 透传给 port.confirmAndSend 并原样返回", async () => {
    const port: ImSendPort = {
      confirmAndSend: vi.fn().mockResolvedValue('{"status":"sent"}'),
    };
    const tool = new ImSendMessageTool(port);
    expect(tool.name).toBe("im_send_message");
    const signal = new AbortController().signal;
    const out = await tool.execute(
      { conversationId: "321", content: "你好" },
      { sessionId: "s1", toolCallId: "tc1", signal } as never,
    );
    expect(out).toBe('{"status":"sent"}');
    expect(port.confirmAndSend).toHaveBeenCalledWith(
      {
        sessionId: "s1",
        toolCallId: "tc1",
        conversationId: "321",
        content: "你好",
      },
      signal,
    );
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd libs/agent && npx vitest run tests/unit/im-send-message.tool.test.ts`
Expected: FAIL —— 工具模块不存在。

- [ ] **Step 3: 实现**

创建 `libs/agent/src/tools/builtins/im-send-message.tool.ts`：

```ts
import {
  type ImSendMessageInput,
  imSendMessageSchema,
} from "@meshbot/types-agent";
import { Inject, Injectable } from "@nestjs/common";
import { IM_SEND_PORT, type ImSendPort } from "../im-send.port";
import { Tool } from "../tool.decorator";
import type { MeshbotTool, ToolContext } from "../tool.types";

@Injectable()
@Tool()
export class ImSendMessageTool
  implements MeshbotTool<ImSendMessageInput, string>
{
  readonly name = "im_send_message";
  readonly description =
    "Send a message to an IM channel or DM by conversationId (e.g. the one in the " +
    "<llmuse> context). The message is shown to the user for confirmation before it is " +
    "actually delivered, and they may edit it. Call ONLY when the user explicitly asks " +
    "to send/reply. Returns a JSON status: sent | cancelled | timeout | interrupted | error.";
  readonly schema = imSendMessageSchema;

  constructor(@Inject(IM_SEND_PORT) private readonly port: ImSendPort) {}

  /** 请求用户确认并发送消息；返回 {status} JSON 字符串。 */
  execute(args: ImSendMessageInput, ctx: ToolContext): Promise<string> {
    return this.port.confirmAndSend(
      {
        sessionId: ctx.sessionId,
        toolCallId: ctx.toolCallId,
        conversationId: args.conversationId,
        content: args.content,
      },
      ctx.signal,
    );
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd libs/agent && npx vitest run tests/unit/im-send-message.tool.test.ts`
Expected: PASS。

- [ ] **Step 5: 注册到 AgentModule**

`libs/agent/src/agent.module.ts`：顶部加 `import { ImSendMessageTool } from "./tools/builtins/im-send-message.tool";`；在 providers 数组 `ImListMembersTool,` 之后加 `ImSendMessageTool,`。

- [ ] **Step 6: typecheck + 提交**

```bash
pnpm turbo typecheck --filter=@meshbot/agent
git add libs/agent/src/tools/builtins/im-send-message.tool.ts libs/agent/tests/unit/im-send-message.tool.test.ts libs/agent/src/agent.module.ts
git commit -m "feat(agent): im_send_message 工具（经 IM_SEND_PORT，HITL）"
```

---

## Task 4: server-agent —— ConfirmationService（内存确认管理）

**Files:**
- Create: `apps/server-agent/src/services/confirmation.service.ts`
- Test: `apps/server-agent/src/services/confirmation.service.spec.ts`

**Interfaces:**
- Produces:
  - `type ConfirmDecision = { action: "send" | "cancel"; content?: string }`
  - `type AwaitOutcome = ConfirmDecision | "timeout" | "aborted"`
  - `ConfirmationService.key(cloudUserId, sessionId, toolCallId): string`（静态）
  - `waitForDecision(key: string, signal: AbortSignal, timeoutMs: number): Promise<AwaitOutcome>`
  - `resolve(key: string, decision: ConfirmDecision): boolean`

- [ ] **Step 1: 写失败单测**

创建 `apps/server-agent/src/services/confirmation.service.spec.ts`：

```ts
import { ConfirmationService } from "./confirmation.service";

describe("ConfirmationService", () => {
  it("key 拼 cloudUserId:sessionId:toolCallId", () => {
    expect(ConfirmationService.key("u", "s", "t")).toBe("u:s:t");
  });

  it("resolve 在超时前到达 → 返回该 decision", async () => {
    const svc = new ConfirmationService();
    const ac = new AbortController();
    const p = svc.waitForDecision("k", ac.signal, 10_000);
    expect(svc.resolve("k", { action: "send", content: "改后" })).toBe(true);
    await expect(p).resolves.toEqual({ action: "send", content: "改后" });
  });

  it("超时 → 返回 'timeout'（fail-safe）", async () => {
    jest.useFakeTimers();
    const svc = new ConfirmationService();
    const ac = new AbortController();
    const p = svc.waitForDecision("k", ac.signal, 1000);
    jest.advanceTimersByTime(1000);
    await expect(p).resolves.toBe("timeout");
    jest.useRealTimers();
  });

  it("abort → 返回 'aborted'", async () => {
    const svc = new ConfirmationService();
    const ac = new AbortController();
    const p = svc.waitForDecision("k", ac.signal, 10_000);
    ac.abort();
    await expect(p).resolves.toBe("aborted");
  });

  it("已 abort 的 signal → 立即 'aborted'", async () => {
    const svc = new ConfirmationService();
    const ac = new AbortController();
    ac.abort();
    await expect(svc.waitForDecision("k", ac.signal, 10_000)).resolves.toBe(
      "aborted",
    );
  });

  it("resolve 未知 key → false（幂等，no-op）", () => {
    const svc = new ConfirmationService();
    expect(svc.resolve("nope", { action: "cancel" })).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test -- apps/server-agent/src/services/confirmation.service.spec.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

创建 `apps/server-agent/src/services/confirmation.service.ts`：

```ts
import { Injectable } from "@nestjs/common";

/** 用户对一次待审批工具调用的决定。 */
export type ConfirmDecision = { action: "send" | "cancel"; content?: string };

/** waitForDecision 的结果：用户决定，或超时/中断（后两者 fail-safe，不发）。 */
export type AwaitOutcome = ConfirmDecision | "timeout" | "aborted";

/**
 * 内存确认管理：工具挂起时 waitForDecision 注册一个 deferred 并 race（超时 + abort）；
 * 前端点击经 confirm 端点 resolve 解锁。单用户本地轨，无需持久化。
 */
@Injectable()
export class ConfirmationService {
  private readonly pending = new Map<string, (d: ConfirmDecision) => void>();

  /** 确认 key：账号 + 会话 + 工具调用，三段唯一，含 cloudUserId 防跨账号解锁。 */
  static key(cloudUserId: string, sessionId: string, toolCallId: string): string {
    return `${cloudUserId}:${sessionId}:${toolCallId}`;
  }

  /** 注册并等待用户决定；race 超时 + abort；任一路径都清理注册项。 */
  waitForDecision(
    key: string,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<AwaitOutcome> {
    if (signal.aborted) {
      return Promise.resolve("aborted");
    }
    return new Promise<AwaitOutcome>((resolve) => {
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
        resolve(decision);
      });
    });
  }

  /** 解锁某 key 的等待（用户点发送/取消）。key 不存在 → no-op 返回 false。 */
  resolve(key: string, decision: ConfirmDecision): boolean {
    const fn = this.pending.get(key);
    if (!fn) {
      return false;
    }
    fn(decision);
    return true;
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test -- apps/server-agent/src/services/confirmation.service.spec.ts`
Expected: PASS（6 用例）。

- [ ] **Step 5: 提交**

```bash
git add apps/server-agent/src/services/confirmation.service.ts apps/server-agent/src/services/confirmation.service.spec.ts
git commit -m "feat(server-agent): ConfirmationService 内存 HITL 确认管理"
```

---

## Task 5: server-agent —— ImSendService（IM_SEND_PORT 实现）+ ImSendModule

**Files:**
- Create: `apps/server-agent/src/services/im-send.service.ts`
- Test: `apps/server-agent/src/services/im-send.service.spec.ts`
- Create: `apps/server-agent/src/im-send.module.ts`
- Modify: `apps/server-agent/src/app.module.ts`

**Interfaces:**
- Consumes: `ImSendPort`（Task 2）；`ConfirmationService`（Task 4，含静态 `key` + `waitForDecision` + 类型 `AwaitOutcome`）；`ImRelayClientService.send(cloudUserId, {conversationId, content})`（`./cloud/im-relay-client.service`，由 `AuthModule` 导出）；`AccountContextService.getOrThrow()`（`@meshbot/agent`）；`AppError`/`AgentErrorCode`。
- Produces: `IM_SEND_PORT` 全局可注入；`ImSendModule` 导出 `IM_SEND_PORT` + `ConfirmationService`；常量 `IM_SEND_CONFIRM_TIMEOUT_MS = 120_000`。

- [ ] **Step 1: 写失败单测**

创建 `apps/server-agent/src/services/im-send.service.spec.ts`：

```ts
import type { AccountContextService } from "@meshbot/agent";
import type { ImRelayClientService } from "../cloud/im-relay-client.service";
import {
  type AwaitOutcome,
  ConfirmationService,
} from "./confirmation.service";
import { ImSendService } from "./im-send.service";

function make(outcome: AwaitOutcome, sendImpl?: () => void) {
  const confirmation = {
    waitForDecision: jest.fn().mockResolvedValue(outcome),
  } as unknown as ConfirmationService;
  const relay = {
    send: jest.fn(sendImpl),
  } as unknown as ImRelayClientService;
  const account = { getOrThrow: () => "u1" } as AccountContextService;
  const svc = new ImSendService(confirmation, relay, account);
  return { svc, relay };
}

const params = {
  sessionId: "s1",
  toolCallId: "tc1",
  conversationId: "c1",
  content: "原稿",
};

describe("ImSendService.confirmAndSend", () => {
  it("send + 编辑后内容 → 经 relay 发编辑版，返回 sent", async () => {
    const { svc, relay } = make({ action: "send", content: "改后" });
    const out = JSON.parse(
      await svc.confirmAndSend(params, new AbortController().signal),
    );
    expect(out).toEqual({ status: "sent", content: "改后" });
    expect(relay.send).toHaveBeenCalledWith("u1", {
      conversationId: "c1",
      content: "改后",
    });
  });

  it("send 但无编辑内容 → 发原稿", async () => {
    const { svc, relay } = make({ action: "send" });
    await svc.confirmAndSend(params, new AbortController().signal);
    expect(relay.send).toHaveBeenCalledWith("u1", {
      conversationId: "c1",
      content: "原稿",
    });
  });

  it("cancel → 不发，返回 cancelled", async () => {
    const { svc, relay } = make({ action: "cancel" });
    const out = JSON.parse(
      await svc.confirmAndSend(params, new AbortController().signal),
    );
    expect(out.status).toBe("cancelled");
    expect(relay.send).not.toHaveBeenCalled();
  });

  it("timeout → 不发，返回 timeout", async () => {
    const { svc, relay } = make("timeout");
    const out = JSON.parse(
      await svc.confirmAndSend(params, new AbortController().signal),
    );
    expect(out.status).toBe("timeout");
    expect(relay.send).not.toHaveBeenCalled();
  });

  it("aborted → 返回 interrupted", async () => {
    const { svc } = make("aborted");
    const out = JSON.parse(
      await svc.confirmAndSend(params, new AbortController().signal),
    );
    expect(out.status).toBe("interrupted");
  });

  it("relay 抛错 → 返回 error", async () => {
    const { svc } = make({ action: "send" }, () => {
      throw new Error("boom");
    });
    const out = JSON.parse(
      await svc.confirmAndSend(params, new AbortController().signal),
    );
    expect(out.status).toBe("error");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test -- apps/server-agent/src/services/im-send.service.spec.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现 service**

创建 `apps/server-agent/src/services/im-send.service.ts`：

```ts
import { AccountContextService } from "@meshbot/agent";
import type { ImSendPort } from "@meshbot/agent";
import { Injectable } from "@nestjs/common";
import { ImRelayClientService } from "../cloud/im-relay-client.service";
import { ConfirmationService } from "./confirmation.service";

/** 确认超时（无人点击则 fail-safe 不发）。 */
export const IM_SEND_CONFIRM_TIMEOUT_MS = 120_000;

/**
 * IM_SEND_PORT 实现：弹卡等待用户确认（ConfirmationService），确认后经既有
 * ImRelayClientService.send 真正发出。返回 {status} JSON 给 agent。
 */
@Injectable()
export class ImSendService implements ImSendPort {
  constructor(
    private readonly confirmation: ConfirmationService,
    private readonly relay: ImRelayClientService,
    private readonly account: AccountContextService,
  ) {}

  /** 请求确认并发送；超时/中断默认不发。 */
  async confirmAndSend(
    params: {
      sessionId: string;
      toolCallId: string;
      conversationId: string;
      content: string;
    },
    signal: AbortSignal,
  ): Promise<string> {
    const cloudUserId = this.account.getOrThrow();
    const key = ConfirmationService.key(
      cloudUserId,
      params.sessionId,
      params.toolCallId,
    );
    const outcome = await this.confirmation.waitForDecision(
      key,
      signal,
      IM_SEND_CONFIRM_TIMEOUT_MS,
    );
    if (outcome === "timeout") {
      return JSON.stringify({ status: "timeout" });
    }
    if (outcome === "aborted") {
      return JSON.stringify({ status: "interrupted" });
    }
    if (outcome.action === "cancel") {
      return JSON.stringify({ status: "cancelled" });
    }
    const finalContent = outcome.content?.trim()
      ? outcome.content
      : params.content;
    try {
      this.relay.send(cloudUserId, {
        conversationId: params.conversationId,
        content: finalContent,
      });
      return JSON.stringify({ status: "sent", content: finalContent });
    } catch {
      return JSON.stringify({ status: "error" });
    }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test -- apps/server-agent/src/services/im-send.service.spec.ts`
Expected: PASS（6 用例）。

- [ ] **Step 5: 建 @Global 绑定模块**

创建 `apps/server-agent/src/im-send.module.ts`：

```ts
import { IM_SEND_PORT } from "@meshbot/agent";
import { Global, Module } from "@nestjs/common";
import { AuthModule } from "./auth.module";
import { ConfirmationService } from "./services/confirmation.service";
import { ImSendService } from "./services/im-send.service";

/**
 * @Global IM 发送模块：绑定 IM_SEND_PORT 到 ImSendService，并导出 ConfirmationService
 * 供 confirm 端点 resolve。AuthModule 提供 ImRelayClientService。
 */
@Global()
@Module({
  imports: [AuthModule],
  providers: [
    ConfirmationService,
    ImSendService,
    { provide: IM_SEND_PORT, useExisting: ImSendService },
  ],
  exports: [IM_SEND_PORT, ConfirmationService],
})
export class ImSendModule {}
```

- [ ] **Step 6: 注册到 app.module**

`apps/server-agent/src/app.module.ts`：先 `rg -n "ImContextModule" apps/server-agent/src/app.module.ts` 定位，import `ImSendModule` 并在 imports 数组 `ImContextModule` 之后加 `ImSendModule`。

- [ ] **Step 7: typecheck + 提交**

```bash
pnpm turbo typecheck --filter=@meshbot/server-agent
git add apps/server-agent/src/services/im-send.service.ts apps/server-agent/src/services/im-send.service.spec.ts apps/server-agent/src/im-send.module.ts apps/server-agent/src/app.module.ts
git commit -m "feat(server-agent): ImSendService 绑定 IM_SEND_PORT（确认后经 relay 发送）"
```

---

## Task 6: server-agent —— confirm 端点

**Files:**
- Modify: `apps/server-agent/src/dto/session.dto.ts`
- Modify: `apps/server-agent/src/controllers/session.controller.ts`
- Test: `apps/server-agent/src/controllers/session-confirm.controller.spec.ts`

**Interfaces:**
- Consumes: `confirmToolCallSchema`/`ConfirmToolCallInput`（Task 1）；`ConfirmationService`（Task 4/5，全局可注入，含静态 `key`）；`AccountContextService`（`@meshbot/agent`）；`createZodDto`（`@meshbot/common`）。
- Produces: `POST /api/sessions/:sessionId/confirm` → `{ ok: true }`。

- [ ] **Step 1: 写失败单测**

创建 `apps/server-agent/src/controllers/session-confirm.controller.spec.ts`（直接测控制器方法，注入桩）：

```ts
import type { AccountContextService } from "@meshbot/agent";
import { ConfirmationService } from "../services/confirmation.service";
import { SessionController } from "./session.controller";

describe("SessionController.confirm", () => {
  it("按 cloudUserId:sessionId:toolCallId resolve，透传 decision+content", () => {
    const confirmation = new ConfirmationService();
    const resolveSpy = jest.spyOn(confirmation, "resolve").mockReturnValue(true);
    const account = { getOrThrow: () => "u1" } as AccountContextService;
    // 仅注入本端点用到的依赖；其余传 undefined（该方法不触达）。
    const ctrl = Object.assign(Object.create(SessionController.prototype), {
      confirmation,
      account,
    }) as SessionController;

    const res = ctrl.confirm("s1", {
      toolCallId: "tc1",
      decision: "send",
      content: "改后",
    } as never);

    expect(res).toEqual({ ok: true });
    expect(resolveSpy).toHaveBeenCalledWith("u1:s1:tc1", {
      action: "send",
      content: "改后",
    });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test -- apps/server-agent/src/controllers/session-confirm.controller.spec.ts`
Expected: FAIL —— `confirm` 方法不存在。

- [ ] **Step 3: 加 DTO**

`apps/server-agent/src/dto/session.dto.ts`：仿现有 `createZodDto` 用法，import `confirmToolCallSchema` 并加：

```ts
export class ConfirmToolCallDto extends createZodDto(confirmToolCallSchema) {}
```

（`confirmToolCallSchema` 从 `@meshbot/types-agent` import；与该文件其它 schema import 同处。）

- [ ] **Step 4: 加端点 + 注入**

`apps/server-agent/src/controllers/session.controller.ts`：
1. 构造函数注入 `private readonly confirmation: ConfirmationService`（`from "../services/confirmation.service"`）和 `private readonly account: AccountContextService`（`from "@meshbot/agent"`）——若已注入 `account` 则复用。
2. import `confirmToolCallSchema`（`@meshbot/types-agent`）、`ConfirmToolCallDto`（`../dto/session.dto`）、`ConfirmationService`。
3. 加方法（放在其它 `@Post(":sessionId/...")` 旁）：

```ts
  @Post(":sessionId/confirm")
  @ApiOperation({ summary: "确认/取消一次待发送的工具调用（send/cancel）" })
  confirm(
    @Param("sessionId") sessionId: string,
    @Body() body: ConfirmToolCallDto,
  ): { ok: true } {
    const { toolCallId, decision, content } = confirmToolCallSchema.parse(body);
    const key = ConfirmationService.key(
      this.account.getOrThrow(),
      sessionId,
      toolCallId,
    );
    this.confirmation.resolve(key, { action: decision, content });
    return { ok: true };
  }
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm test -- apps/server-agent/src/controllers/session-confirm.controller.spec.ts`
Expected: PASS。

- [ ] **Step 6: typecheck + 提交**

```bash
pnpm turbo typecheck --filter=@meshbot/server-agent
git add apps/server-agent/src/dto/session.dto.ts apps/server-agent/src/controllers/session.controller.ts apps/server-agent/src/controllers/session-confirm.controller.spec.ts
git commit -m "feat(server-agent): POST /api/sessions/:id/confirm 解锁 HITL 确认"
```

---

## Task 7: web-agent —— confirmSend rest + 可编辑确认卡

**Files:**
- Modify: `apps/web-agent/src/rest/session.ts`
- Create: `apps/web-agent/src/components/session/im-send-confirm-card.tsx`
- Modify: `apps/web-agent/src/components/session/tool-call-block.tsx`
- Modify: `apps/web-agent/src/components/session/message-list.tsx`

**Interfaces:**
- Consumes: `ToolCallView`（`message-list.tsx`，字段 `toolCallId`/`name`/`args`/`result`/`status`）；`conversationsAtom`（`@/atoms/im`，`ConversationSummary[]`，元素含 `id`/`name`/`peer.displayName`）；`apiClient`（`packages/web-common`）。
- Produces: `confirmSend(sessionId, toolCallId, decision, content?)`；卡片组件按 `tool.status`/`tool.result` 渲染。

- [ ] **Step 1: 加 rest 封装**

`apps/web-agent/src/rest/session.ts`：仿 `appendMessage` 加：

```ts
/** 确认/取消一次待发送的 im_send_message 工具调用。 */
export async function confirmSend(
  sessionId: string,
  toolCallId: string,
  decision: "send" | "cancel",
  content?: string,
): Promise<{ ok: true }> {
  const { data } = await apiClient.post<{ ok: true }>(
    `/api/sessions/${sessionId}/confirm`,
    { toolCallId, decision, content },
  );
  return data;
}
```

- [ ] **Step 2: 实现确认卡组件**

创建 `apps/web-agent/src/components/session/im-send-confirm-card.tsx`：

```tsx
"use client";

import { useAtomValue } from "jotai";
import { Check, Loader2, Send, X } from "lucide-react";
import { useState } from "react";
import { conversationsAtom } from "@/atoms/im";
import { confirmSend } from "@/rest/session";
import type { ToolCallView } from "./message-list";

/** im_send_message 的可编辑确认卡：预填草稿，用户改后点发送 / 取消。 */
export function ImSendConfirmCard({
  tool,
  sessionId,
}: {
  tool: ToolCallView;
  sessionId: string;
}) {
  const args = (tool.args ?? {}) as {
    conversationId?: string;
    content?: string;
  };
  const conversations = useAtomValue(conversationsAtom);
  const target = conversations.find((c) => c.id === args.conversationId);
  const targetName =
    target?.name ?? target?.peer?.displayName ?? args.conversationId ?? "会话";
  const [text, setText] = useState(args.content ?? "");
  const [busy, setBusy] = useState(false);

  const pending = tool.status === "running";
  const result = parseStatus(tool.result);

  const act = async (decision: "send" | "cancel") => {
    setBusy(true);
    try {
      await confirmSend(sessionId, tool.toolCallId, decision, text);
    } catch {
      setBusy(false);
    }
  };

  if (pending) {
    return (
      <div className="flex w-full flex-col gap-2 rounded-[8px] border border-border bg-muted/30 px-3 py-2">
        <div className="text-xs text-muted-foreground">
          发送给 <span className="font-medium text-foreground">{targetName}</span>（发送前可编辑）
        </div>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={busy}
          rows={3}
          className="w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-primary disabled:opacity-50"
        />
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => act("cancel")}
            disabled={busy}
            className="flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted disabled:opacity-50"
          >
            <X className="h-3 w-3" /> 取消
          </button>
          <button
            type="button"
            onClick={() => act("send")}
            disabled={busy || !text.trim()}
            className="flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />} 发送
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex w-full items-center gap-2 rounded-[8px] border border-border bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
      <Check className="h-3 w-3" />
      {terminalLabel(result)} · {targetName}
    </div>
  );
}

/** 把工具结果 JSON 解析出 status；解析失败返回 null。 */
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
    case "sent":
      return "已发送";
    case "cancelled":
      return "已取消";
    case "timeout":
      return "确认超时，未发送";
    case "interrupted":
      return "已中断，未发送";
    case "error":
      return "发送失败";
    default:
      return "已结束";
  }
}
```

- [ ] **Step 3: 在 ToolCallBlock 特判**

`apps/web-agent/src/components/session/tool-call-block.tsx`：
1. import：`import { ImSendConfirmCard } from "./im-send-confirm-card";`
2. 把签名 `export function ToolCallBlock({ tool }: { tool: ToolCallView })` 改为：

```tsx
export function ToolCallBlock({
  tool,
  sessionId,
}: {
  tool: ToolCallView;
  sessionId: string;
}) {
```

3. 在函数体最前面（任何其它逻辑之前）加特判：

```tsx
  if (tool.name === "im_send_message" && tool.status !== "streaming") {
    return <ImSendConfirmCard tool={tool} sessionId={sessionId} />;
  }
```

（`streaming` 阶段 args 尚未就绪，仍走默认 chip；`running`/终态走卡片。）

- [ ] **Step 4: 传 sessionId**

`apps/web-agent/src/components/session/message-list.tsx`：把渲染处 `<ToolCallBlock key={tc.toolCallId} tool={tc} />` 改为 `<ToolCallBlock key={tc.toolCallId} tool={tc} sessionId={sessionId} />`（`sessionId` 是 MessageList 的现有 prop）。

- [ ] **Step 5: typecheck + 提交**

```bash
pnpm turbo typecheck --filter=@meshbot/web-agent
git add apps/web-agent/src/rest/session.ts apps/web-agent/src/components/session/im-send-confirm-card.tsx apps/web-agent/src/components/session/tool-call-block.tsx apps/web-agent/src/components/session/message-list.tsx
git commit -m "feat(web-agent): im_send_message 可编辑确认卡 + confirmSend"
```

---

## Task 8: 集成验证（boot + 全量测试 + 围栏 + 冒烟）

> Task 5 新增 `@Global ImSendModule`（DI 变更）+ `im_send_message` 工具注入 IM_SEND_PORT。按铁律必须真启 server-agent 验证。

**Files:** 无（验证）。

- [ ] **Step 1: 全量单测**

Run: `pnpm test`
Expected: 新增用例全绿；既有失败维持基线（libs/agent vitest 9；根 jest 的 `use-global-events.spec` + `session.e2e` 两套预存在红，见 memory `preexisting-e2e-boot-infra-bugs`）。不得新增失败——若有，checkout merge-base diff 失败集合定位。

- [ ] **Step 2: 全包 typecheck**

Run: `pnpm typecheck`
Expected: 全绿。

- [ ] **Step 3: 真启 server-agent 验证 DI（关键）**

Run: `pnpm dev:server-agent`，观察日志至 “Nest application successfully started” + 监听 3100，**无** `Nest can't resolve dependencies`（尤其 `IM_SEND_PORT` / `ImRelayClientService` / `ConfirmationService`）。确认后停。
Expected: 正常启动。

- [ ] **Step 4: 静态围栏**

Run: `pnpm check`
Expected: exit 0（新增 finding 0；tx-fence 仍是 `conversation.service.ts:280` 的预存在基线 `unchanged=1`）。

- [ ] **Step 5: 手动冒烟（端到端）**

启 server-agent + web-agent，登录后：在某 DM 打开随手问，让助手「帮我回复 XX」→ 助手调 `im_send_message` → 出现可编辑确认卡 → 改两个字 → 点[发送] → 对端实际收到**编辑后**内容，助手回「已发送 ✅」。再测一次点[取消] → 助手回「好的，没发」，对端收不到。

- [ ] **Step 6: 最终提交（如有冒烟修正）**

```bash
git add -A
git commit -m "test(agent): im_send_message HITL 集成验证修正"
```

---

## Self-Review（已核对）

- **Spec 覆盖**：§3 流程（Task 3/5/6/7）；§4 工具（Task 3）；§5 端口+confirmAndSend 各分支（Task 2/5）；§6 ConfirmationService（Task 4）；§7 confirm 端点（Task 6）；§8 复用 relay send（Task 5）；§9 可编辑卡（Task 7）；§10 边界/账号作用域/fail-safe（Task 4/5 的 timeout/aborted + key 含 cloudUserId）；§11 测试（每 Task 自带）。
- **占位符**：无 TBD/TODO；每代码步给完整代码 + 命令 + 预期。
- **类型一致**：`ImSendPort.confirmAndSend(params, signal)` 在 Task 2 定义、Task 3 工具调用、Task 5 实现三处签名一致；`ConfirmationService.key`/`waitForDecision`/`resolve` + `ConfirmDecision`/`AwaitOutcome` 在 Task 4 定义、Task 5/6 消费一致；`confirmSend` 与 confirm 端点体 `{toolCallId,decision,content}` 一致；`{status}` 值集（sent/cancelled/timeout/interrupted/error）在 Task 5 产出、Task 7 `terminalLabel` 消费一致。
