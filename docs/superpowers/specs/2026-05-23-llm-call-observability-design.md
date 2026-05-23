# LLM 调用观测（控制台日志 + token 落库 + 前端展示） 设计

> 状态：设计已确认，待 plan
> 范围：本地轨（libs/agent + libs/types-agent + apps/server-agent + apps/web-agent）
> 日期：2026-05-23

## 1. 目标

每次调 LLM 时:
- 后端控制台一行结构化日志，跨供应商统一字段（provider/model/token 分项/耗时）。
- token 用量落库，刷新页面后会话累计仍能显示。
- 实时经 WS `run.usage` 推给前端。
- 前端两处展示:每条 assistant 回复底部一行单次用量；`ChatInput` 右下角现有 token usage 区域显示**会话累计**（max = 当前模型上下文窗口，本期前端 hardcode 映射）。

不区分供应商 —— LangChain 0.3 `AIMessageChunk.usage_metadata` 已经把 OpenAI/Anthropic/Google/DeepSeek/Ollama 的原生 usage 映射到统一 schema，含 `input_token_details.cache_read` / `cache_creation` / `output_token_details.reasoning` 等明细。

## 2. 架构概览

5 个职责单元：

| 单元 | 位置 | 职责 |
|---|---|---|
| 共享类型 | `libs/types-agent/src/session.ts` | `RunUsageEvent` schema; `HistoryResponse` 加 `usage` 字段 |
| usage 收集 + yield | `libs/agent`（GraphService + supervisor.node） | supervisor 累加完 chunk 后从 `usage_metadata` 抽出 token；`GraphService` 在 stream 末尾额外 yield 一个 `kind:"usage"` 事件 |
| 落库 + 控制台日志 + WS | `apps/server-agent`（LlmCall Entity + Service + RunnerService 消费 usage） | `LlmCall` Entity 唯一归属 `LlmCallService`；`RunnerService` 收到 usage 事件 → 落库 + Logger.log + emit `run.usage` |
| WS 转发 | `apps/server-agent`（SessionGateway） | `@OnEvent('run.usage')` → `server.to(sessionId).emit` |
| 前端展示 | `apps/web-agent`（jotai atom + MessageList + ChatInput） | `usageByMessage` / `sessionTotals` 两个 atom；MessageList 单次用量；ChatInput 累计 |

**关键决策:**

- **跨供应商靠 `usage_metadata`**：LangChain 已统一字段，不写适配。
- **`GraphService` 流额外 yield usage 事件**：`StreamChunk` 升级为可辨识联合 `{ kind: "chunk", ... } | { kind: "usage", ... }`。`libs/agent` 不依赖 NestJS Logger / EventEmitter / DB。
- **`LlmCall` 独立 Service + 表**：与 `Session` / `PendingMessage` 同级，`LlmCallService` 唯一归属（check:repo）。
- **失败 run 不记 LlmCall**：失败时 `usage_metadata` 拿不到，记录会噪音大；`run.error` 已经在别处记录失败。
- **上下文窗口本期前端 hardcode**：`MODEL_CONTEXT_WINDOW` 映射表 + fallback。以后做压缩时再正式引入 schema 字段。

## 3. 数据模型 —— `LlmCall` 表

新表 `llm_calls`，SQLite + 迁移文件，主键 UUID。

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT PK | uuid |
| `session_id` | TEXT | 逻辑外键，无 DB 约束 |
| `message_id` | TEXT | LangGraph AIMessage id，与 checkpointer assistant 消息对齐 |
| `provider_type` | TEXT | 例 `deepseek` |
| `model` | TEXT | |
| `input_tokens` | INTEGER NOT NULL DEFAULT 0 | usage_metadata.input_tokens（总输入，含缓存命中部分）|
| `output_tokens` | INTEGER NOT NULL DEFAULT 0 | |
| `total_tokens` | INTEGER NOT NULL DEFAULT 0 | |
| `cache_read_tokens` | INTEGER NOT NULL DEFAULT 0 | input_token_details.cache_read |
| `cache_creation_tokens` | INTEGER NOT NULL DEFAULT 0 | input_token_details.cache_creation |
| `reasoning_tokens` | INTEGER NOT NULL DEFAULT 0 | output_token_details.reasoning |
| `duration_ms` | INTEGER NOT NULL DEFAULT 0 | stream 开始到结束 |
| `created_at` | DATETIME NOT NULL DEFAULT (datetime('now')) | |

索引：`(session_id)`。`LlmCallService` 唯一归属。SQLite 列名 snake_case，符合既有约定。

供应商不上报某项的列就是 0（DB default）。

## 4. usage 收集与事件流

### 4.1 supervisor 节点收集 + GraphService 额外 yield

`libs/agent/src/graph/graph.service.ts` 的 `streamMessage` / `resumeStream`：

- `runGraphStream` 在 stream 开始时记 `startTime`。
- 每个 chunk 仍 yield `{ kind: "chunk", messageId, delta }`（升级 `StreamChunk` 为可辨识联合）。
- stream 结束时:从最后一个累计的 `AIMessageChunk`（LangGraph `streamMode:"messages"` 会在末尾给出包含 `usage_metadata` 的 chunk）读 usage 字段;`runGraphStream` 额外 yield 一个 `{ kind: "usage", messageId, providerType, model, inputTokens, outputTokens, totalTokens, cacheReadTokens, cacheCreationTokens, reasoningTokens, durationMs }`。

provider/model 字符串通过 `MeshbotConfigService.getActiveModelConfig()` 或在 `resolveModel` 时由 `GraphService` 记下，挂在闭包里 yield 出去。

> 实施检查点：LangGraph `streamMode:"messages"` 末尾的 chunk 是否带 `usage_metadata` 跨所有供应商生效。多数供应商在最后一个 chunk 给出 usage；某些（如部分 ollama 模型）可能不上报。usage 缺失时不 yield `usage` 事件（也就不落库、不发 WS）—— 控制台 log 一行「provider X did not report usage」即可。

### 4.2 RunnerService 消费 usage

`apps/server-agent/src/services/runner.service.ts` 的 `runOnce` 迭代 graph stream：

```ts
for await (const event of this.graph.streamMessage(...)) {
  if (event.kind === "chunk") {
    // 现状：累加 inflight、emit run.chunk
  } else if (event.kind === "usage") {
    await this.llmCalls.record({ sessionId, ...event });
    this.logger.log(`LLM call session=${sessionId} msg=${event.messageId} provider=${event.providerType} model=${event.model} in=${event.inputTokens}(cache_read=${event.cacheReadTokens} cache_creation=${event.cacheCreationTokens}) out=${event.outputTokens}(reasoning=${event.reasoningTokens}) total=${event.totalTokens} dur=${event.durationMs}ms`);
    this.emitter.emit(SESSION_WS_EVENTS.runUsage, { sessionId, ...event });
  }
}
```

`RunnerService` 注入 `LlmCallService`。事件常量 `SESSION_WS_EVENTS.runUsage = "run.usage"`。

### 4.3 SessionGateway 转发

`apps/server-agent/src/ws/session.gateway.ts` 加 `@OnEvent(SESSION_WS_EVENTS.runUsage)` 转发：

```ts
@OnEvent(SESSION_WS_EVENTS.runUsage)
onRunUsage(payload: RunUsageEvent): void {
  this.server.to(payload.sessionId).emit(SESSION_WS_EVENTS.runUsage, payload);
}
```

## 5. 共享类型与 REST 扩展

### 5.1 `libs/types-agent/src/session.ts` 新增

```ts
const TokenBreakdownSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  totalTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheCreationTokens: z.number(),
  reasoningTokens: z.number(),
});

export const MessageUsageSchema = TokenBreakdownSchema.extend({
  providerType: z.string(),
  model: z.string(),
  durationMs: z.number(),
});

export const SessionTotalsSchema = TokenBreakdownSchema.extend({
  callCount: z.number(),
});

export const SessionUsageSchema = z.object({
  sessionTotals: SessionTotalsSchema,
  byMessage: z.record(z.string(), MessageUsageSchema),
});

export const RunUsageEventSchema = MessageUsageSchema.extend({
  sessionId: z.string(),
  messageId: z.string(),
});

// 加入 SESSION_WS_EVENTS：
runUsage: "run.usage";
```

`HistoryResponseSchema` 加 `usage: SessionUsageSchema`：
```ts
export const HistoryResponseSchema = z.object({
  messages: z.array(HistoryMessageSchema),
  inflight: InflightSnapshotSchema.nullable(),
  usage: SessionUsageSchema,
});
```

### 5.2 `SessionController.history` 端点

调用 `LlmCallService.getSessionTotals(sessionId)` + `LlmCallService.listBySession(sessionId)` → 拼成 `SessionUsage`。`byMessage` 的 key 是 `messageId`，value 是 `MessageUsage`（同一 assistant 消息一次调用，1:1）。

不新增端点。

## 6. 前端

### 6.1 jotai usage atoms

`apps/web-agent/src/atoms/session-usage.ts`（新）：

```ts
export const usageByMessageAtom = atom<Record<string, MessageUsage>>({});
export const sessionTotalsAtom = atom<SessionTotals>({
  inputTokens: 0, outputTokens: 0, totalTokens: 0,
  cacheReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0,
  callCount: 0,
});
// setter atoms：
export const setInitialUsageAtom = atom(null, (_get, set, u: SessionUsage) => {...});
export const appendUsageAtom = atom(null, (get, set, u: RunUsageEvent) => {...});
export const resetUsageAtom = atom(null, (_get, set) => {...});
```

### 6.2 会话页接线

`apps/web-agent/src/app/session/page.tsx`：
- `fetchHistory` 返回后 → `setInitialUsage(history.usage)`。
- socket 监听 `run.usage` → `appendUsage(payload)`。
- `sessionId` 变化（useEffect deps）→ `resetUsage`，避免上轮会话累计串台。
- 把 `sessionTotalsAtom` 传给 `<ChatInput tokenUsage={...} />`；把 `usageByMessageAtom` 传给 `<MessageList usageByMessage={...} />`。

### 6.3 MessageList 单次用量

`apps/web-agent/src/components/session/message-list.tsx`：
- 加 prop `usageByMessage?: Record<string, MessageUsage>`。
- 对 `role === "assistant"` 的气泡，若 `usageByMessage[m.id]` 存在，气泡底部加一行 muted 小字：
  ```
  deepseek · deepseek-chat · 输入 1234（缓存 567）/ 输出 89（推理 12）· 1.2s
  ```
  缓存/推理字段只在 >0 时显示。

### 6.4 ChatInput 累计

`apps/web-agent/src/components/common/chat-input.tsx`：
- 现有 `tokenUsage?: { current: number; max: number }` 保留，会话页传 `{ current: sessionTotals.totalTokens, max: MODEL_CONTEXT_WINDOW[currentModelName] ?? 128_000 }`。
- Tooltip 内容扩展为分项展示：`输入 X（缓存 K）/ 输出 Y（推理 R）· N 次调用`。
- `MODEL_CONTEXT_WINDOW` 映射表：`apps/web-agent/src/lib/model-context-window.ts`（新）—— 列常见 model 名 → context window 大小（deepseek-chat 64000, gpt-4o 128000, claude-3-5-sonnet 200000 等），含 fallback。

### 6.5 当前 model 名怎么拿

会话页需要知道 currentModel 名以查 `MODEL_CONTEXT_WINDOW`。三种来源:
- (a) 从 `sessionTotalsAtom` 的最后一次调用拿（首次还没调用时回退到默认）。
- (b) 从 `useModelConfigs` 拿启用的 ModelConfig。
- (c) `usageByMessage` 的最后一条带 model 名。

选 **(b)**：调 `useModelConfigs`（react-query 已有 hook），取 `enabled` 的那条的 `model` 字段，查 `MODEL_CONTEXT_WINDOW`。最直接，且首条消息发出去前就能算出 max。

## 7. 错误处理

| 场景 | 处理 |
|---|---|
| 供应商不上报 usage | `runGraphStream` 不 yield `usage`，控制台 log 一行警告，DB 无记录，前端无累计变化 |
| `LlmCallService.record` 失败 | 捕获 + log error，不影响 run（usage 是观测，失败不该回滚业务）|
| `usage_metadata` 部分字段缺失 | 缺失字段当 0（供应商部分支持时常见） |
| 历史会话无 LlmCall 记录 | `getSessionTotals` 返回全 0；`byMessage` 是空对象 —— 旧会话刷新仍不报错 |

## 8. 测试

- `LlmCallService.record` / `getSessionTotals` / `listBySession`：Jest，覆盖累计、空会话。
- `RunnerService.runOnce` 消费 usage：单测覆盖「收到 usage 事件 → 调 record + log + emit runUsage」。fake `GraphService` yields chunk + usage。
- `SessionGateway.onRunUsage`：单测，emit 转发到 room。
- types-agent schema：spec 测试新增 schemas。
- e2e：`GET /history` 包含 `usage` 字段（即使会话无调用，返回 sessionTotals 全 0、byMessage = {}）。
- 静态围栏：`pnpm check`（check:repo 验证 `LlmCall` 唯一归属 `LlmCallService`；Controller / Gateway 不注入 Repo）。

## 9. 已知取舍

- **上下文窗口前端 hardcode**：见 §6.4。以后做上下文压缩时正式引入 `ModelConfig.contextWindow` 字段（带迁移）。
- **失败 run 不记 LlmCall**：取舍是减少噪音；要分析失败率可走 `run.error` 日志或后期加 `failed: true` 列。
- **重试 run 仍记新行**：`resumeStream` 跑一次 = 一次 LLM 调用 = 一条 LlmCall 行。同一 messageId 可能有多行（首次失败 → 重试成功）。`byMessage` 用 `messageId` 作 key 会被后写覆盖；如果想保留首次失败的 cost 信息，未来可改 `byMessageId: MessageUsage[]`。本期接受最后一次覆盖。
