# 云端模型网关（OpenAI 兼容代理）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 server-main 提供一个 OpenAI 兼容的 `/v1/chat/completions` 网关，用 device token 鉴权、云端解密厂商 key 后经 langchain 转发；本地 `source='cloud'` 模型改为经网关调用，厂商 apiKey 不再下发端侧。

**Architecture:** 网关是 server-main 内新增 NestJS 模块（`ModelGatewayModule`），复用现有 `JwtAuthGuard`（吃 device token → `{userId, orgId, deviceId}`）、`OrgModelConfigService`、`SecretCryptoService`；内部用 libs/agent 同款 `initChatModel` 调各厂商，OpenAI 请求体 ↔ langchain 消息互转，流式走 SSE。端侧下发链反转：`/api/agent/model-configs` 不再返回明文 key，改返回网关坐标；`source='cloud'` 行以 `openai-compatible` + `baseUrl=<gateway>/v1` + `model=<OrgModelConfig.id>` 指向网关，device token 由 fetch 包装每请求动态注入。

**Tech Stack:** NestJS（server-main）、Zod + `createZodDto`、`langchain` `initChatModel`（`@langchain/core` 消息类型）、Jest（单测 + e2e，含 Postgres service）、TypeORM（Postgres / SQLite）。

## Global Constraints

- `libs/types-*` 禁止依赖 NestJS / TypeORM（纯 Zod + TS）。
- 云端轨 DDL 走纯 SQL 文件 `apps/server-main/migrations/<YYYYMMDDHHmm>-<summary>.sql`，DBA 手动执行；本计划**不新增表/列**（复用 `org_model_config.api_key_enc`）。
- Entity 唯一归属 Service；Controller 禁止注入 Repository；跨表写才用 `@Transactional()`（本计划网关只读，不涉及）。
- 公开方法带中文 JSDoc。提交用中文 conventional commit，结尾附 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
- 每个任务结束跑 `pnpm check`（静态围栏）before commit。
- 厂商 apiKey **只在网关内存**解密使用，**禁止**写日志 / 落端侧 / 进响应体。
- 已在分支 `feat/cloud-model-gateway`（spec: `docs/superpowers/specs/2026-07-09-cloud-model-gateway-design.md`）。

---

# Phase 1 — 云端网关（server-main，独立可测）

> Phase 1 完成后，用 curl 带 device token + 一个已配置的 org 模型即可拿到 completion；端侧此时仍走旧的明文下发路径（Phase 2 才切换），两者互不影响。

## Task 1：`OrgModelConfigService.resolveDecrypted(orgId, modelId)`

网关内部要的「按 id + orgId 查归属 + 解密」入口，与现有对外 `listForAgent`（Phase 2 要改）解耦。

**Files:**
- Modify: `libs/main/src/services/org-model-config.service.ts`
- Test: `libs/main/src/services/org-model-config.service.spec.ts`（已存在则追加 describe）

**Interfaces:**
- Produces: `resolveDecrypted(orgId: string, modelId: string): Promise<ResolvedModel | null>`，其中
  ```ts
  export interface ResolvedModel {
    providerType: string;   // openai | anthropic | google | deepseek | ollama | openai-compatible
    model: string;          // 厂商真实模型名
    baseUrl: string | null;
    apiKey: string;         // 明文（已解密）
    contextWindow: number | null;
  }
  ```
  归属不符或不存在返回 `null`。`ResolvedModel` 定义放 `libs/main/src/services/org-model-config.service.ts` 顶部并 `export`。

- [ ] **Step 1: 写失败测试**

在 `libs/main/src/services/org-model-config.service.spec.ts` 追加（复用文件既有的 service 构造方式 / mock 仓库；若文件不存在，参照同目录其他 `*.service.spec.ts` 的 `Test.createTestingModule` 写法）：

```ts
describe("resolveDecrypted", () => {
  it("按 id+orgId 命中并解密", async () => {
    // 假定 mock 仓库 findOne 返回一行 { id:"m1", orgId:"o1", providerType:"openai",
    //   model:"gpt-4o", baseUrl:null, apiKeyEnc:"ENC", contextWindow:128000, enabled:true }
    jest.spyOn(crypto, "decrypt").mockReturnValue("sk-real");
    const r = await service.resolveDecrypted("o1", "m1");
    expect(r).toEqual({
      providerType: "openai",
      model: "gpt-4o",
      baseUrl: null,
      apiKey: "sk-real",
      contextWindow: 128000,
    });
  });

  it("跨 org 不命中 → null", async () => {
    // mock 仓库 findOne（带 orgId 条件）返回 undefined
    const r = await service.resolveDecrypted("other-org", "m1");
    expect(r).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @meshbot/server-main test -- org-model-config.service`
Expected: FAIL — `resolveDecrypted is not a function`。

- [ ] **Step 3: 实现**

在 `OrgModelConfigService` 加（参照已有 `listForAgent` 的仓库查询 + `this.crypto.decrypt` 用法）：

```ts
/** 网关内部用：按 orgId + 模型 id 查归属并解密厂商 apiKey；不存在/不归属返回 null。 */
async resolveDecrypted(
  orgId: string,
  modelId: string,
): Promise<ResolvedModel | null> {
  const row = await this.repo.findOne({
    where: { id: modelId, orgId, enabled: true },
  });
  if (!row) return null;
  return {
    providerType: row.providerType,
    model: row.model,
    baseUrl: row.baseUrl ?? null,
    apiKey: this.crypto.decrypt(row.apiKeyEnc),
    contextWindow: row.contextWindow ?? null,
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @meshbot/server-main test -- org-model-config.service`
Expected: PASS。

- [ ] **Step 5: 围栏 + 提交**

```bash
pnpm check
git add libs/main/src/services/org-model-config.service.ts libs/main/src/services/org-model-config.service.spec.ts
git commit -m "feat(main): OrgModelConfigService.resolveDecrypted 供网关按 id+org 解密"
```

---

## Task 2：OpenAI ↔ langchain 消息转换 + 请求 DTO

网关的纯函数核心：把 OpenAI `chat/completions` 请求体转成 langchain 消息，把 langchain 输出转回 OpenAI 响应/流帧。纯函数、无 IO，最好测。

**Files:**
- Create: `libs/types/src/model-gateway/openai-chat.schema.ts`（Zod 请求 schema）
- Create: `apps/server-main/src/model-gateway/openai-adapter.ts`（转换纯函数）
- Test: `apps/server-main/src/model-gateway/openai-adapter.spec.ts`

**Interfaces:**
- Produces（`openai-chat.schema.ts`）：
  ```ts
  export const openAIChatRequestSchema = z.object({
    model: z.string(),
    messages: z.array(z.object({
      role: z.enum(["system", "user", "assistant", "tool"]),
      content: z.union([z.string(), z.null()]).optional(),
      tool_calls: z.array(z.any()).optional(),
      tool_call_id: z.string().optional(),
      name: z.string().optional(),
    })),
    stream: z.boolean().optional(),
    temperature: z.number().optional(),
    max_tokens: z.number().optional(),
    tools: z.array(z.any()).optional(),
    tool_choice: z.any().optional(),
  });
  export type OpenAIChatRequest = z.infer<typeof openAIChatRequestSchema>;
  ```
- Produces（`openai-adapter.ts`）：
  ```ts
  export function toLangchainMessages(req: OpenAIChatRequest): BaseMessage[];
  export function toModelParams(req: OpenAIChatRequest): Record<string, unknown>; // temperature/maxTokens（顶层）
  // 把一次非流式 AIMessage 结果包成 OpenAI chat.completion
  export function toOpenAICompletion(msg: AIMessage, model: string, id: string): object;
  // 把一个流式 chunk 包成 OpenAI chat.completion.chunk（供 SSE 逐帧）
  export function toOpenAIChunk(delta: { content?: string; toolCalls?: unknown }, model: string, id: string): object;
  ```

- [ ] **Step 1: 写失败测试**

`apps/server-main/src/model-gateway/openai-adapter.spec.ts`：

```ts
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import {
  toLangchainMessages,
  toOpenAICompletion,
  toOpenAIChunk,
} from "./openai-adapter";

describe("openai-adapter", () => {
  it("system+user 转 langchain 消息", () => {
    const msgs = toLangchainMessages({
      model: "m1",
      messages: [
        { role: "system", content: "you are helpful" },
        { role: "user", content: "hi" },
      ],
    });
    expect(msgs[0]).toBeInstanceOf(SystemMessage);
    expect(msgs[1]).toBeInstanceOf(HumanMessage);
    expect(msgs[1].content).toBe("hi");
  });

  it("AIMessage 转 OpenAI completion 外壳", () => {
    const out = toOpenAICompletion(new AIMessage("hello"), "m1", "cmpl-1") as any;
    expect(out.object).toBe("chat.completion");
    expect(out.model).toBe("m1");
    expect(out.choices[0].message.role).toBe("assistant");
    expect(out.choices[0].message.content).toBe("hello");
  });

  it("chunk 转 OpenAI 流帧外壳", () => {
    const c = toOpenAIChunk({ content: "he" }, "m1", "cmpl-1") as any;
    expect(c.object).toBe("chat.completion.chunk");
    expect(c.choices[0].delta.content).toBe("he");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @meshbot/server-main test -- openai-adapter`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现 schema + adapter**

`libs/types/src/model-gateway/openai-chat.schema.ts`：写上面 Interfaces 里的 schema（记得 `import { z } from "zod";`，并在 `libs/types/src/index.ts` 追加 `export * from "./model-gateway/openai-chat.schema.js";`）。

`apps/server-main/src/model-gateway/openai-adapter.ts`：

```ts
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import type { OpenAIChatRequest } from "@meshbot/types";

/** OpenAI messages → langchain BaseMessage[]。 */
export function toLangchainMessages(req: OpenAIChatRequest): BaseMessage[] {
  return req.messages.map((m) => {
    const content = m.content ?? "";
    switch (m.role) {
      case "system":
        return new SystemMessage(content);
      case "user":
        return new HumanMessage(content);
      case "tool":
        return new ToolMessage({ content, tool_call_id: m.tool_call_id ?? "" });
      default:
        return new AIMessage({
          content,
          tool_calls: (m.tool_calls as never) ?? undefined,
        });
    }
  });
}

/** 从 OpenAI 请求提取 initChatModel 的顶层生成参数（temperature/max_tokens）。
 *  注意：tools 不走这里——见 Task 3 用 model.bindTools(req.tools)。 */
export function toModelParams(req: OpenAIChatRequest): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  if (req.temperature != null) p.temperature = req.temperature;
  if (req.max_tokens != null) p.maxTokens = req.max_tokens;
  return p;
}

function textOf(content: unknown): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}

/** 非流式 AIMessage → OpenAI chat.completion。 */
export function toOpenAICompletion(msg: AIMessage, model: string, id: string) {
  return {
    id,
    object: "chat.completion",
    created: 0,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: textOf(msg.content),
          ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}),
        },
        finish_reason: msg.tool_calls?.length ? "tool_calls" : "stop",
      },
    ],
  };
}

/** 流式 delta → OpenAI chat.completion.chunk。 */
export function toOpenAIChunk(
  delta: { content?: string; toolCalls?: unknown },
  model: string,
  id: string,
) {
  return {
    id,
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [
      {
        index: 0,
        delta: {
          ...(delta.content != null ? { content: delta.content } : {}),
          ...(delta.toolCalls ? { tool_calls: delta.toolCalls } : {}),
        },
        finish_reason: null,
      },
    ],
  };
}
```

> 注：`created: 0` 是占位常量（脚本禁 `Date.now()`；运行时如需真实时间戳由调用方补）。工具调用增量（`toolCalls`）的精确 langchain→OpenAI 结构在 Task 5 流式实测时按 `AIMessageChunk.tool_call_chunks` 校准。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @meshbot/server-main test -- openai-adapter`
Expected: PASS（3 个用例）。

- [ ] **Step 5: 围栏 + 提交**

```bash
pnpm check
git add libs/types/src/model-gateway/ libs/types/src/index.ts apps/server-main/src/model-gateway/openai-adapter.ts apps/server-main/src/model-gateway/openai-adapter.spec.ts
git commit -m "feat(gateway): OpenAI↔langchain 消息转换 + 请求 schema"
```

---

## Task 3：`ModelGatewayService`（非流式 completion）

编排：resolveDecrypted → initChatModel → invoke → toOpenAICompletion。先做非流式（好测），流式在 Task 5。

**Files:**
- Create: `apps/server-main/src/model-gateway/model-gateway.service.ts`
- Test: `apps/server-main/src/model-gateway/model-gateway.service.spec.ts`

**Interfaces:**
- Consumes: `OrgModelConfigService.resolveDecrypted`（Task 1）；`toLangchainMessages/toModelKwargs/toOpenAICompletion`（Task 2）；`initChatModel`（`langchain/chat_models/universal`，参照 `libs/agent/src/graph/llm.factory.ts:146` 的调用形态）。
- Produces:
  ```ts
  export class GatewayModelNotFoundError extends Error {}
  async complete(orgId: string, req: OpenAIChatRequest, id: string): Promise<object>;
  ```
  找不到模型抛 `GatewayModelNotFoundError`（Controller 映射 404/403）。

- [ ] **Step 1: 写失败测试**

`model-gateway.service.spec.ts`（mock `OrgModelConfigService` + mock `initChatModel`；`initChatModel` 用 `jest.mock("langchain/chat_models/universal")` 返回一个 `{ invoke: async () => new AIMessage("hi from provider") }`）：

```ts
it("解析 → 调 provider → 返回 OpenAI completion", async () => {
  orgSvc.resolveDecrypted.mockResolvedValue({
    providerType: "openai", model: "gpt-4o", baseUrl: null,
    apiKey: "sk-x", contextWindow: 128000,
  });
  const out: any = await service.complete("o1", {
    model: "m1", messages: [{ role: "user", content: "hi" }],
  }, "cmpl-1");
  expect(out.choices[0].message.content).toBe("hi from provider");
  // 断言用真实模型名 gpt-4o 调 initChatModel，而非端侧传的 id "m1"
  expect(initChatModel).toHaveBeenCalledWith("gpt-4o", expect.objectContaining({ apiKey: "sk-x" }));
});

it("模型不存在 → 抛 GatewayModelNotFoundError", async () => {
  orgSvc.resolveDecrypted.mockResolvedValue(null);
  await expect(service.complete("o1", { model: "nope", messages: [] }, "id"))
    .rejects.toBeInstanceOf(GatewayModelNotFoundError);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @meshbot/server-main test -- model-gateway.service`
Expected: FAIL — service 不存在。

- [ ] **Step 3: 实现**

```ts
import { initChatModel } from "langchain/chat_models/universal";
import { Injectable } from "@nestjs/common";
import type { OpenAIChatRequest } from "@meshbot/types";
import { OrgModelConfigService } from "@meshbot/main";
import {
  toLangchainMessages,
  toModelParams,
  toOpenAICompletion,
} from "./openai-adapter";

export class GatewayModelNotFoundError extends Error {}

// provider 名映射与 libs/agent llm.factory.ts:15-22 保持一致
const PROVIDER_MODEL_NAME: Record<string, string> = {
  google: "google-genai",
  "openai-compatible": "openai",
};

@Injectable()
export class ModelGatewayService {
  constructor(private readonly orgModels: OrgModelConfigService) {}

  /** 非流式：解析 org 模型 → 解密 → 调厂商 → OpenAI completion。 */
  async complete(
    orgId: string,
    req: OpenAIChatRequest,
    id: string,
  ): Promise<object> {
    const resolved = await this.orgModels.resolveDecrypted(orgId, req.model);
    if (!resolved) throw new GatewayModelNotFoundError(req.model);
    const model = await this.build(resolved, req, false);
    const result = await model.invoke(toLangchainMessages(req));
    return toOpenAICompletion(result, req.model, id);
  }

  /** 内部：按 resolved 建 langchain 模型（Task 5 流式复用）。 */
  private async build(
    resolved: Awaited<ReturnType<OrgModelConfigService["resolveDecrypted"]>>,
    req: OpenAIChatRequest,
    streaming: boolean,
  ) {
    if (!resolved) throw new GatewayModelNotFoundError(req.model);
    const configuration: Record<string, unknown> = {};
    if (resolved.baseUrl) configuration.baseURL = resolved.baseUrl;
    const model = await initChatModel(resolved.model, {
      modelProvider:
        PROVIDER_MODEL_NAME[resolved.providerType] ?? resolved.providerType,
      apiKey: resolved.apiKey,
      streaming,
      ...toModelParams(req), // temperature/maxTokens 顶层参数
      ...(Object.keys(configuration).length ? { configuration } : {}),
    });
    // 工具走 bindTools（而非 modelKwargs），返回的 Runnable 同样有 invoke/stream
    return req.tools?.length
      ? (model.bindTools(req.tools) as unknown as typeof model)
      : model;
  }
}
```

> `OrgModelConfigService` 从 `@meshbot/main` 导出——若未导出，在 `libs/main/src/index.ts` 补 export（不改可见性语义）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @meshbot/server-main test -- model-gateway.service`
Expected: PASS（2 用例）。

- [ ] **Step 5: 围栏 + 提交**

```bash
pnpm check
git add apps/server-main/src/model-gateway/model-gateway.service.ts apps/server-main/src/model-gateway/model-gateway.service.spec.ts libs/main/src/index.ts
git commit -m "feat(gateway): ModelGatewayService 非流式 completion"
```

---

## Task 4：`ChatCompletionsController` + `ModelGatewayModule`（挂鉴权，非流式打通）

**Files:**
- Create: `apps/server-main/src/model-gateway/chat-completions.controller.ts`
- Create: `apps/server-main/src/model-gateway/model-gateway.module.ts`
- Modify: `apps/server-main/src/app.module.ts`（imports 加 `ModelGatewayModule`）
- Test: `apps/server-main/test/e2e/model-gateway.e2e.spec.ts`

**Interfaces:**
- Consumes: `ModelGatewayService.complete`（Task 3）；全局 `JwtAuthGuard` 注入的 `req.user = { userId, orgId, deviceId }`（`apps/server-main/src/auth/jwt-auth.guard.ts:47-58`）。
- Produces: `POST /api/v1/chat/completions`（全局前缀 `api`，见 `apps/server-main/src/main.ts:80`，故对端侧暴露的是 `<base>/api/v1/chat/completions`）。

- [ ] **Step 1: 写失败 e2e 测试**

`apps/server-main/test/e2e/model-gateway.e2e.spec.ts`（参照 `apps/server-main/test/e2e/*.spec.ts` 的 boot + 认证方式；mock `ModelGatewayService` 避免真调厂商）：

```ts
it("带有效 device token + 非流式 → 200 且返回 completion", async () => {
  // 用测试夹具签发一个 device token，其 org 下建一条 org_model_config（id=m1）
  const res = await request(app.getHttpServer())
    .post("/api/v1/chat/completions")
    .set("Authorization", `Bearer ${deviceToken}`)
    .send({ model: "m1", messages: [{ role: "user", content: "hi" }] });
  expect(res.status).toBe(200);
  expect(res.body.object).toBe("chat.completion");
});

it("无 token → 401", async () => {
  const res = await request(app.getHttpServer())
    .post("/api/v1/chat/completions")
    .send({ model: "m1", messages: [] });
  expect(res.status).toBe(401);
});

it("跨 org 模型 id → 404", async () => {
  const res = await request(app.getHttpServer())
    .post("/api/v1/chat/completions")
    .set("Authorization", `Bearer ${deviceToken}`)
    .send({ model: "other-org-model", messages: [] });
  expect(res.status).toBe(404);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @meshbot/server-main test:e2e -- model-gateway`
Expected: FAIL — 路由 404（未注册）。

- [ ] **Step 3: 实现 controller + module + 注册**

`chat-completions.controller.ts`：

```ts
import { Body, Controller, Post, Req, Res } from "@nestjs/common";
import { createZodDto } from "nestjs-zod";
import { openAIChatRequestSchema } from "@meshbot/types";
import type { Request, Response } from "express";
import { GatewayModelNotFoundError, ModelGatewayService } from "./model-gateway.service";

class ChatCompletionDto extends createZodDto(openAIChatRequestSchema) {}

@Controller("v1")
export class ChatCompletionsController {
  constructor(private readonly gateway: ModelGatewayService) {}

  /** OpenAI 兼容 chat/completions；stream=false 走非流式，stream=true 由 Task 5 补 SSE。 */
  @Post("chat/completions")
  async completions(
    @Body() body: ChatCompletionDto,
    @Req() req: Request & { user: { orgId: string } },
    @Res() res: Response,
  ): Promise<void> {
    const id = `chatcmpl-${req.user.orgId}-${process.hrtime.bigint()}`;
    try {
      // Task 5 在此按 body.stream 分流；Phase 1 只做非流式
      const out = await this.gateway.complete(req.user.orgId, body, id);
      res.status(200).json(out);
    } catch (err) {
      if (err instanceof GatewayModelNotFoundError) {
        res.status(404).json({ error: { message: `model not found: ${body.model}`, type: "invalid_request_error" } });
        return;
      }
      throw err;
    }
  }
}
```

`model-gateway.module.ts`：

```ts
import { Module } from "@nestjs/common";
import { MainModule } from "@meshbot/main"; // 提供 OrgModelConfigService（按实际导出模块名）
import { ChatCompletionsController } from "./chat-completions.controller";
import { ModelGatewayService } from "./model-gateway.service";

@Module({
  imports: [MainModule],
  controllers: [ChatCompletionsController],
  providers: [ModelGatewayService],
})
export class ModelGatewayModule {}
```

> `MainModule` 换成实际导出 `OrgModelConfigService` 的 module（查 `libs/main/src` 里 `OrgModelConfigService` 所属 `@Module` 并确认已 `exports`）。在 `app.module.ts` 的 `imports` 数组加 `ModelGatewayModule`。全局 `JwtAuthGuard` 已是 `APP_GUARD`（确认 `app.module.ts`/`main.ts`）——如是则 controller 自动受保护；如为按路由挂，则在 controller 上加 `@UseGuards(JwtAuthGuard)`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @meshbot/server-main test:e2e -- model-gateway`
Expected: PASS（200 / 401 / 404）。

- [ ] **Step 5: 围栏 + 提交**

```bash
pnpm check
git add apps/server-main/src/model-gateway/ apps/server-main/src/app.module.ts apps/server-main/test/e2e/model-gateway.e2e.spec.ts
git commit -m "feat(gateway): /v1/chat/completions 非流式端点 + 鉴权 + 归属校验"
```

---

## Task 5：流式 SSE

`stream:true` 时逐帧 SSE 回流。

**Files:**
- Modify: `apps/server-main/src/model-gateway/model-gateway.service.ts`（加 `stream()`）
- Modify: `apps/server-main/src/model-gateway/chat-completions.controller.ts`（按 `body.stream` 分流）
- Test: `apps/server-main/src/model-gateway/model-gateway.service.spec.ts`（加流式用例）

**Interfaces:**
- Produces: `async *stream(orgId, req, id): AsyncGenerator<object>` —— yield 出的每个对象是 `toOpenAIChunk(...)` 结果；末尾 yield 一个 `finish_reason:"stop"` 的收尾帧。

- [ ] **Step 1: 写失败测试**

```ts
it("流式：逐 chunk yield OpenAI 帧", async () => {
  orgSvc.resolveDecrypted.mockResolvedValue({
    providerType: "openai", model: "gpt-4o", baseUrl: null, apiKey: "sk", contextWindow: null,
  });
  // mock initChatModel 返回 { stream: async function*(){ yield new AIMessageChunk("he"); yield new AIMessageChunk("llo"); } }
  const frames: any[] = [];
  for await (const f of service.stream("o1", { model: "m1", messages: [{ role: "user", content: "hi" }], stream: true }, "id")) {
    frames.push(f);
  }
  expect(frames[0].choices[0].delta.content).toBe("he");
  expect(frames[1].choices[0].delta.content).toBe("llo");
  expect(frames.at(-1).choices[0].finish_reason).toBe("stop");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @meshbot/server-main test -- model-gateway.service`
Expected: FAIL — `service.stream is not a function`。

- [ ] **Step 3: 实现 service.stream + controller 分流**

service：

```ts
/** 流式：逐 chunk 产出 OpenAI chat.completion.chunk。 */
async *stream(
  orgId: string,
  req: OpenAIChatRequest,
  id: string,
): AsyncGenerator<object> {
  const resolved = await this.orgModels.resolveDecrypted(orgId, req.model);
  if (!resolved) throw new GatewayModelNotFoundError(req.model);
  const model = await this.build(resolved, req, true);
  for await (const chunk of await model.stream(toLangchainMessages(req))) {
    const content =
      typeof chunk.content === "string" ? chunk.content : "";
    const toolCalls = (chunk as { tool_call_chunks?: unknown }).tool_call_chunks;
    if (content || toolCalls) {
      yield toOpenAIChunk({ content, toolCalls }, req.model, id);
    }
  }
  yield {
    id, object: "chat.completion.chunk", created: 0, model: req.model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  };
}
```

controller `completions` 方法体开头按 `body.stream` 分流：

```ts
if (body.stream) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  try {
    for await (const frame of this.gateway.stream(req.user.orgId, body, id)) {
      res.write(`data: ${JSON.stringify(frame)}\n\n`);
    }
    res.write("data: [DONE]\n\n");
  } catch (err) {
    if (err instanceof GatewayModelNotFoundError) {
      res.write(`data: ${JSON.stringify({ error: { message: `model not found: ${body.model}` } })}\n\n`);
    } else {
      res.write(`data: ${JSON.stringify({ error: { message: "gateway error" } })}\n\n`);
    }
  }
  res.end();
  return;
}
```

> 执行时用 `AIMessageChunk` 实测校准 `tool_call_chunks` → OpenAI `delta.tool_calls` 的字段映射（`index/id/function.name/function.arguments`）；若首版工具流式不完美，先保证纯文本流 + 非流式工具调用可用，工具流式细节记 issue。

- [ ] **Step 4: 跑测试确认通过 + 手动流式冒烟**

Run: `pnpm --filter @meshbot/server-main test -- model-gateway.service`
Expected: PASS。
手动：`curl -N -X POST <base>/api/v1/chat/completions -H "Authorization: Bearer <deviceToken>" -d '{"model":"m1","messages":[{"role":"user","content":"数到3"}],"stream":true}'` → 看到逐帧 `data:` + 末尾 `[DONE]`。

- [ ] **Step 5: 围栏 + 提交**

```bash
pnpm check
git add apps/server-main/src/model-gateway/
git commit -m "feat(gateway): chat/completions SSE 流式转发"
```

---

# Phase 2 — 下发反转 + 端侧接线

> Phase 2 把「明文 key 下发」链路砍掉，端侧 `source='cloud'` 模型改为经 Phase 1 网关调用。

## Task 6：下发反转（`AgentModelConfig` 去 key + `listForAgent`）

**Files:**
- Modify: `libs/types/src/model-config/model-config.types.ts`（`AgentModelConfig` 去 apiKey）
- Modify: `libs/main/src/services/org-model-config.service.ts`（`listForAgent` 不再解密）
- Test: `libs/main/src/services/org-model-config.service.spec.ts`

**Interfaces:**
- Produces: `AgentModelConfig = { id: string; name: string; contextWindow: number | null; enabled: boolean }`（**无** apiKey / baseUrl / providerType-厂商）。`listForAgent(orgId): Promise<AgentModelConfig[]>` 只回这些字段，绝不 decrypt。

- [ ] **Step 1: 改测试（红）**

把 `org-model-config.service.spec.ts` 里 `listForAgent` 的断言改成「返回不含 apiKey」，并加一条「不调用 crypto.decrypt」：

```ts
it("listForAgent 不解密、不含厂商 key", async () => {
  const spy = jest.spyOn(crypto, "decrypt");
  const out = await service.listForAgent("o1");
  expect(out[0]).not.toHaveProperty("apiKey");
  expect(out[0]).toEqual(expect.objectContaining({ id: expect.any(String), name: expect.any(String) }));
  expect(spy).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @meshbot/server-main test -- org-model-config.service`
Expected: FAIL（现实现仍 decrypt + 带 apiKey）。

- [ ] **Step 3: 实现**

改 `AgentModelConfig` 类型去掉 `apiKey`（及任何厂商 baseUrl/真实 model 字段），只留 `{ id, name, contextWindow, enabled }`。改 `listForAgent` 映射：

```ts
async listForAgent(orgId: string): Promise<AgentModelConfig[]> {
  const rows = await this.repo.find({ where: { orgId, enabled: true } });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    contextWindow: r.contextWindow ?? null,
    enabled: r.enabled,
  }));
}
```

- [ ] **Step 4: 跑测试确认通过 + 全量类型**

Run: `pnpm --filter @meshbot/server-main test -- org-model-config.service && pnpm typecheck`
Expected: PASS；typecheck 会暴露端侧消费 `AgentModelConfig.apiKey` 的地方（Task 7/8 修）。**若 typecheck 在端侧报错属预期**，Task 7/8 修完再整体绿。

- [ ] **Step 5: 提交（连带 Task 7/8 一起绿后再 push，本地可先 commit）**

```bash
git add libs/types/src/model-config/model-config.types.ts libs/main/src/services/org-model-config.service.ts libs/main/src/services/org-model-config.service.spec.ts
git commit -m "feat(main): 下发端 AgentModelConfig 去厂商 key，listForAgent 不再解密"
```

---

## Task 7：端侧写网关坐标行（`replaceCloudConfigs`）

**Files:**
- Modify: `apps/server-agent/src/services/model-config-sync.service.ts`
- Modify: `apps/server-agent/src/services/model-config.service.ts`（`replaceCloudConfigs` 入参/映射）
- Test: `apps/server-agent/src/services/model-config-sync.service.spec.ts`（或 model-config.service.spec.ts）

**Interfaces:**
- Consumes: 新 `AgentModelConfig`（Task 6）；`MESHBOT_CLOUD_URL`（`env.schema`）。
- Produces: `source='cloud'` 行写为 `{ providerType:'openai-compatible', baseUrl:'<cloudUrl>/api/v1', model:<AgentModelConfig.id>, apiKey:'__cloud__', name, contextWindow, enabled }`。

- [ ] **Step 1: 写失败测试**

```ts
it("云配置写成指向网关的 openai-compatible 行", async () => {
  await sync.applyConfigs([{ id: "m1", name: "GPT4o", contextWindow: 128000, enabled: true }]);
  const rows = readRows(); // 读回 model_configs source='cloud'
  expect(rows[0]).toMatchObject({
    provider_type: "openai-compatible",
    base_url: expect.stringMatching(/\/api\/v1$/),
    model: "m1",
    api_key: "__cloud__",
    source: "cloud",
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @meshbot/server-agent test -- model-config-sync`
Expected: FAIL。

- [ ] **Step 3: 实现**

在 sync/service 里把拉到的 `AgentModelConfig[]` 映射成网关坐标行（`cloudUrl` 取 `configService.get("MESHBOT_CLOUD_URL")`，拼 `/api/v1`），交给 `replaceCloudConfigs` 落库。`replaceCloudConfigs` 入参类型改为新行结构。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @meshbot/server-agent test -- model-config-sync`
Expected: PASS。

- [ ] **Step 5: 围栏 + 提交**

```bash
pnpm check
git add apps/server-agent/src/services/model-config-sync.service.ts apps/server-agent/src/services/model-config.service.ts apps/server-agent/src/services/*.spec.ts
git commit -m "feat(agent): 云模型下发落成指向网关的 openai-compatible 行"
```

---

## Task 8：端侧动态 token 注入 + 缓存 key 排除 token

**Files:**
- Modify: `libs/agent/src/graph/llm.factory.ts`（cloud 模型 fetch 包装注入 device token）
- Modify: `libs/agent/src/graph/model-resolver.service.ts`（cloud 模型缓存 key 排除 apiKey）
- Modify: `libs/agent/src/config/model-config.reader.ts`（透出「是否云模型」标记，供上面判断）
- Test: `libs/agent/src/graph/llm.factory.spec.ts`（vitest；libs/agent 用 vitest）

**Interfaces:**
- Consumes: 一个「取当前 device token」的回调，签名 `() => string | null`（由 server-agent 侧注入，读 `CloudIdentityService.deviceToken`；libs/agent 不直接依赖 server-agent，通过已有的 runtime context / port 传入，参照 `AccountContextService` 注入方式）。
- Produces: `createChatModel(config, { cloudTokenProvider })`——当 `config` 是云模型（`base_url` 指向网关且 `apiKey==='__cloud__'`）时，client 用占位 key 建一次，fetch 包装每请求把 `Authorization` 覆盖为 `Bearer <cloudTokenProvider()>`。

- [ ] **Step 1: 写失败测试**

```ts
it("云模型：fetch 包装用动态 token 覆盖 Authorization", async () => {
  let seen = "";
  const fakeFetch = async (_u: any, init: any) => { seen = init.headers.Authorization; return new Response("{}"); };
  const wrapped = buildCloudFetch(fakeFetch as any, () => "mbd_LIVE");
  await wrapped("http://gw/api/v1/chat/completions", { headers: { Authorization: "Bearer __cloud__" }, method: "POST", body: "{}" });
  expect(seen).toBe("Bearer mbd_LIVE");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @meshbot/agent test -- llm.factory`
Expected: FAIL — `buildCloudFetch` 未定义。

- [ ] **Step 3: 实现**

在 `llm.factory.ts` 加导出 `buildCloudFetch(base, tokenProvider)`（仿 `patchedFetchForDeepseek` 结构，clone init.headers 覆盖 Authorization），并在 `createChatModel` 里：云模型分支设 `configuration.fetch = buildCloudFetch(globalThis.fetch, opts.cloudTokenProvider)`、`apiKey='__cloud__'`。`model-resolver` 对云模型缓存 key 用 `provider|model|baseUrl|__cloud__`（不含真实 token）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @meshbot/agent test -- llm.factory`
Expected: PASS。

- [ ] **Step 5: 围栏 + 提交**

```bash
pnpm check
git add libs/agent/src/graph/llm.factory.ts libs/agent/src/graph/model-resolver.service.ts libs/agent/src/config/model-config.reader.ts libs/agent/src/graph/llm.factory.spec.ts
git commit -m "feat(agent): 云模型动态注入 device token（fetch 包装）+ 缓存 key 排除 token"
```

---

## Task 9：端到端接线 + 冒烟 + 收尾

把 `cloudTokenProvider`（读 `CloudIdentityService.deviceToken`）从 server-agent 接到 `model-resolver`/`createChatModel`，跑真实链路。

**Files:**
- Modify: server-agent 侧构造 `ModelResolver` / 调 `createChatModel` 的接线处（注入 `cloudTokenProvider`）。
- Test: 手动冒烟 + 现有单测回归。

- [ ] **Step 1: 接线**

在 server-agent 组装 model-resolver 的地方，传入 `cloudTokenProvider = () => cloudIdentityService.currentDeviceToken()`（按实际 API）。

- [ ] **Step 2: 全量回归**

Run: `pnpm typecheck && pnpm --filter @meshbot/agent test && pnpm --filter @meshbot/server-agent test && pnpm --filter @meshbot/server-main test`
Expected: 全 PASS（Task 6 引入的端侧类型错误此时应已被 7/8 消化）。

- [ ] **Step 3: 真机冒烟（沙箱 data-dir）**

启 server-main（本地）+ 在某 org 配一个真实厂商模型 → 启 server-agent（`MESHBOT_CLOUD_URL` 指本地 server-main）→ 触发一次会话 → 确认：本地 `model_configs` 无厂商明文、请求经 `/api/v1/chat/completions`、回复正常流式。

- [ ] **Step 4: 围栏 + 提交**

```bash
pnpm check
git add -A
git commit -m "feat(agent): 接入 cloudTokenProvider，云模型经网关端到端打通"
```

- [ ] **Step 5: 推送 + PR**

```bash
git push -u origin feat/cloud-model-gateway
gh pr create --base main --title "feat: 云端模型网关（OpenAI 兼容代理，厂商 key 不下发）" --body "见 docs/superpowers/specs/2026-07-09-cloud-model-gateway-design.md"
```

---

## DeepSeek 经网关（v1 处置）

DeepSeek 的 `reasoning_content` 往返处理现分散在端侧（`llm.factory.ts:140` fetch 补丁 + `supervisor.node.ts:52` 剥离）。走网关后端侧看到的是 `openai-compatible`，这套处理会失效。

**v1 决定**：DeepSeek 模型**暂不经网关**——org 若要用 DeepSeek，仍以 `source='local'` 端侧直连配置（与本地/ollama 同待遇）。网关侧完整支持 DeepSeek thinking（把 reasoning_content 往返处理迁到网关内）作为**后续单独一期**。据此，Task 3 的 `build()` 遇到 `providerType==='deepseek'` 的 resolved 时应直接抛 `GatewayModelNotFoundError`（或专门的 4xx），并在 Task 1 `resolveDecrypted` 的测试补一条「deepseek 模型返回可识别错误」。若上线时云端确实没有 DeepSeek org 模型，此约束零影响。

## 涉及文件总览

**新增（server-main）**：`model-gateway/{model-gateway.module,chat-completions.controller,model-gateway.service,openai-adapter}.ts` + 测试。
**新增（libs/types）**：`model-gateway/openai-chat.schema.ts`。
**修改（libs/main）**：`org-model-config.service.ts`（+`resolveDecrypted`、改 `listForAgent`）、`index.ts`（export）。
**修改（libs/types）**：`model-config/model-config.types.ts`（`AgentModelConfig` 去 key）。
**修改（server-agent / libs/agent）**：`model-config-sync.service.ts`、`model-config.service.ts`、`model-config.reader.ts`、`llm.factory.ts`、`model-resolver.service.ts` + 接线处。
**不改**：`org_model_config` 表结构（复用 `api_key_enc`）、`source='local'` 直连链路、本地/ollama 直连。
