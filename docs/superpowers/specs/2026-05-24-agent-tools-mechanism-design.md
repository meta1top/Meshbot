# Agent Tools 机制（含 bash / date 内建）

## 背景

`libs/agent` 当前仅 supervisor 单节点 graph，无 tool 能力。`tools/tool-registry.ts`
是空占位、`AgentModule` 已 export ToolRegistry token 但无任何 tool 注册。
本设计落地通用的 Tool 注册/发现机制 + LangGraph ToolNode 接入 + 两个内建
tool（bash / date）+ 前后端流式反馈。

## 决策总览

| 维度 | 决策 |
|---|---|
| Tool 形式 | `@Injectable()` + `@Tool()` 装饰器；类实现 `MeshbotTool` 接口 |
| 注册发现 | `@nestjs/core` 的 `DiscoveryService` 启动时扫描；singleton；重名 fail-fast |
| Graph 接入 | 自写 `createToolsNode`（不用 langgraph 内置 ToolNode，便于 ctx 注入）；ReAct 循环 supervisor → tools → supervisor |
| 反馈通道 | WS 事件 `run.tool_call_start` / `run.tool_call_progress` / `run.tool_call_end` |
| 落库 | session_messages 启用 `tool_calls` / `tool_call_id` 预留字段；assistant + role=tool 双行 |
| 历史读取 | controller listPage 二次组装：role=tool 不进 messages，按 tool_call_id 挂到上游 assistant 的 toolCalls 数组 |
| bash 边界 | cwd 锁定 `~/.meshbot/workspace/`（prod）/ repo root（dev）；SHELL -lc；2 分钟超时；20KB 给 LLM；progress 实时全量推前端 |
| date 时区 | schema 必填 + description 引导 "不知道就问"；非法 IANA 返 error 让 LLM 自然重问；**不引 interrupt** |
| 前端 UI | `ToolCallBlock` 折叠组件；assistant 气泡内 reasoning → tools → content 顺序渲染 |

## 1. Tool 抽象层

`libs/agent/src/tools/tool.types.ts`：

```ts
import type { EventEmitter2 } from "@nestjs/event-emitter";
import type { z } from "zod";

/** Tool 实现接口。装饰器仅作 metadata 标记；真正的契约在此。 */
export interface MeshbotTool<TArgs = unknown, TResult = unknown> {
  /** 唯一名字（暴露给 LLM）。 */
  readonly name: string;
  /** 描述，传给 LLM 作为 tool description。 */
  readonly description: string;
  /** Zod schema 校验 LLM 给的 args，同时生成 JSON Schema 给 LLM。 */
  readonly schema: z.ZodType<TArgs>;
  /** 执行。result 序列化为 string 后作为 ToolMessage.content 给 LLM。 */
  execute(args: TArgs, ctx: ToolContext): Promise<TResult>;
}

/** 每次 tool 调用注入的上下文。 */
export interface ToolContext {
  sessionId: string;
  /** 当前 assistant messageId（ReAct 一轮内可能多个 tool call，共享同一 messageId）。 */
  messageId: string;
  /** LangChain 给的 tool_call_id（绑定到该次具体调用）。 */
  toolCallId: string;
  /** Tool 实现用此 emit run.tool_call_progress 等事件。 */
  emitter: EventEmitter2;
  /** 复用 run 的 AbortSignal；用户 Stop 时 tool 也中断。 */
  signal: AbortSignal;
}
```

`libs/agent/src/tools/tool.decorator.ts`：

```ts
import { Injectable, applyDecorators } from "@nestjs/common";

export const TOOL_METADATA_KEY = Symbol("meshbot:tool");

/**
 * 标记一个类为 meshbot tool。配合 @Injectable 使用：
 * ```
 * @Tool()
 * export class BashTool implements MeshbotTool<...> { ... }
 * ```
 * 装饰器仅作 metadata 标记；ToolRegistry 启动时扫描所有 provider 找带此
 * metadata 的实例并注册。
 */
export function Tool(): ClassDecorator {
  return applyDecorators(Injectable(), (target: object) => {
    Reflect.defineMetadata(TOOL_METADATA_KEY, true, target);
  });
}
```

## 2. ToolRegistry

`libs/agent/src/tools/tool-registry.ts`（替换占位）：

```ts
import { Injectable, OnModuleInit } from "@nestjs/common";
import { DiscoveryService } from "@nestjs/core";
import { tool as createLcTool } from "@langchain/core/tools";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { StructuredTool } from "@langchain/core/tools";
import { TOOL_METADATA_KEY } from "./tool.decorator";
import type { MeshbotTool, ToolContext } from "./tool.types";

@Injectable()
export class ToolRegistry implements OnModuleInit {
  private tools = new Map<string, MeshbotTool>();

  constructor(private readonly discovery: DiscoveryService) {}

  onModuleInit(): void {
    const providers = this.discovery.getProviders();
    for (const wrapper of providers) {
      const instance = wrapper.instance;
      if (!instance || typeof instance !== "object") continue;
      const isTool = Reflect.getMetadata(
        TOOL_METADATA_KEY,
        instance.constructor,
      );
      if (!isTool) continue;
      const tool = instance as MeshbotTool;
      if (this.tools.has(tool.name)) {
        throw new Error(`Duplicate tool name: ${tool.name}`);
      }
      this.tools.set(tool.name, tool);
    }
  }

  /**
   * 给 supervisor.bindTools() 用的 LangChain tool 数组。
   * ctx 由闭包捕获，供后续 createToolsNode 里调 execute 时通过 ctx getter 拿。
   * 注意：bindTools 仅用 schema/description/name，不会真调这里的 func（toolsNode 自己调）。
   */
  asLangChainBindable(): StructuredTool[] {
    return [...this.tools.values()].map((t) =>
      createLcTool(
        async () => "", // 占位 —— 不会被调用，仅用于 LLM bindTools 元数据
        {
          name: t.name,
          description: t.description,
          schema: t.schema,
        },
      ),
    );
  }

  get(name: string): MeshbotTool | undefined {
    return this.tools.get(name);
  }

  list(): MeshbotTool[] {
    return [...this.tools.values()];
  }
}
```

注：`asLangChainBindable` 返回的 LC tool 实例**不会**真被 LangChain 调（我们自写 toolsNode），仅用于 `model.bindTools()` 把 schema 注入 LLM。真正的执行在 toolsNode 里用 `registry.get(name).execute(args, ctx)`。

依赖：`zod-to-json-schema`（langchain 已有间接依赖）；`@langchain/core` 的 `tool()` builder。

## 3. Graph 接入

### 3.1 graph.builder.ts 重构

```ts
import { ToolMessage, AIMessage } from "@langchain/core/messages";
import { END, START, StateGraph } from "@langchain/langgraph";
import type { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { createSupervisorNode, type ModelProvider } from "./nodes/supervisor.node";
import type { ToolRegistry } from "../tools/tool-registry";
import type { ToolContext } from "../tools/tool.types";

export interface GraphState {
  messages: BaseMessage[];
}

/**
 * 构图：supervisor + tools 两节点，ReAct 循环。
 *
 * - START → supervisor
 * - supervisor 输出 AIMessage：若含 tool_calls → tools，否则 → END
 * - tools 执行后回 supervisor 继续
 *
 * @param toolsCtxGetter 由 runner 注入；返回**最新**的 ctx base
 *   （messageId/toolCallId 在 toolsNode 内部按 tool_call 现取）。
 */
export function buildSupervisorGraph(
  checkpointer: SqliteSaver,
  modelProvider: ModelProvider,
  registry: ToolRegistry,
  toolsCtxGetter: () => Omit<ToolContext, "toolCallId">,
) {
  const supervisor = createSupervisorNode(modelProvider, () =>
    registry.asLangChainBindable(),
  );
  const tools = createToolsNode(registry, toolsCtxGetter);
  return new StateGraph<GraphState>({
    channels: {
      messages: {
        value: (x: BaseMessage[], y: BaseMessage[]) => x.concat(y),
        default: () => [],
      },
    },
  })
    .addNode("supervisor", supervisor)
    .addNode("tools", tools)
    .addEdge(START, "supervisor")
    .addConditionalEdges("supervisor", routeAfterSupervisor)
    .addEdge("tools", "supervisor")
    .compile({ checkpointer });
}

function routeAfterSupervisor(state: GraphState): "tools" | typeof END {
  const last = state.messages[state.messages.length - 1];
  if (last instanceof AIMessage && (last.tool_calls?.length ?? 0) > 0) {
    return "tools";
  }
  return END;
}
```

### 3.2 supervisor.node.ts 修订

```ts
export function createSupervisorNode(
  modelProvider: ModelProvider,
  toolsProvider: () => StructuredTool[],
) {
  return async function supervisorNode(state) {
    const model = await modelProvider();
    const tools = toolsProvider();
    const withTools = tools.length > 0 ? model.bindTools(tools) : model;
    const stream = await withTools.stream(state.messages);
    let accumulated: AIMessageChunk | undefined;
    for await (const chunk of stream) {
      accumulated = accumulated === undefined ? chunk : accumulated.concat(chunk);
    }
    if (!accumulated) throw new Error("supervisor: empty stream");
    return { messages: [accumulated] };
  };
}
```

### 3.3 createToolsNode（自写）

`libs/agent/src/graph/nodes/tools.node.ts`：

```ts
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { SESSION_WS_EVENTS } from "@meshbot/types-agent";
import type { ToolRegistry } from "../../tools/tool-registry";
import type { ToolContext } from "../../tools/tool.types";
import type { GraphState } from "../graph.builder";

const RESULT_PREVIEW_LIMIT = 200;

/**
 * 自写 ToolNode：从 last AIMessage.tool_calls 取调用，按 name 调 registry.get(),
 * 执行 + emit start/end + 把 result 作为 ToolMessage append 到 state.messages。
 *
 * 不用 langgraph 内置 ToolNode：内置 ToolNode 期望 tools[] 直接传入，无法在每次
 * 调用时注入 toolCallId 等动态 ctx。
 */
export function createToolsNode(
  registry: ToolRegistry,
  ctxGetter: () => Omit<ToolContext, "toolCallId">,
) {
  return async function toolsNode(state: GraphState) {
    const last = state.messages[state.messages.length - 1];
    if (!(last instanceof AIMessage) || !last.tool_calls?.length) return {};
    const ctxBase = ctxGetter();
    const results: ToolMessage[] = [];
    for (const call of last.tool_calls) {
      const tool = registry.get(call.name);
      if (!tool) {
        results.push(
          new ToolMessage({
            tool_call_id: call.id ?? "",
            name: call.name,
            content: `Error: unknown tool ${call.name}`,
          }),
        );
        continue;
      }
      const toolCallId = call.id ?? "";
      const ctx: ToolContext = { ...ctxBase, toolCallId };
      // emit start
      ctxBase.emitter.emit(SESSION_WS_EVENTS.runToolCallStart, {
        sessionId: ctxBase.sessionId,
        messageId: ctxBase.messageId,
        toolCallId,
        name: call.name,
        args: call.args,
      });
      let content: string;
      let ok = true;
      try {
        const parsed = tool.schema.parse(call.args);
        const result = await tool.execute(parsed as never, ctx);
        content = typeof result === "string" ? result : JSON.stringify(result);
      } catch (err) {
        ok = false;
        content = `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
      // emit end —— content 完整给后端落库，前端只用 resultPreview
      ctxBase.emitter.emit(SESSION_WS_EVENTS.runToolCallEnd, {
        sessionId: ctxBase.sessionId,
        messageId: ctxBase.messageId,
        toolCallId,
        name: call.name,
        ok,
        resultPreview: content.slice(0, RESULT_PREVIEW_LIMIT),
        content,
      });
      results.push(
        new ToolMessage({ tool_call_id: toolCallId, name: call.name, content }),
      );
    }
    return { messages: results };
  };
}
```

### 3.4 GraphService 接 ctxGetter

```ts
@Injectable()
export class GraphService {
  // ...
  private ctxRef: { sessionId: string; messageId: string; signal: AbortSignal } | null = null;
  private emitter: EventEmitter2;  // 通过 constructor 注入

  constructor(
    private readonly configService: MeshbotConfigService,
    private readonly promptService: PromptService,
    private readonly toolRegistry: ToolRegistry,
    private readonly eventEmitter: EventEmitter2,
    // ...
  ) {
    // graph 构建时 ctxGetter 闭包捕获 this.ctxRef
    this.graph = buildSupervisorGraph(
      checkpointer,
      modelProvider,
      toolRegistry,
      () => {
        if (!this.ctxRef) throw new Error("toolsNode called without active run");
        return {
          sessionId: this.ctxRef.sessionId,
          messageId: this.ctxRef.messageId,
          emitter: this.eventEmitter,
          signal: this.ctxRef.signal,
        };
      },
    );
  }

  async *streamMessage(threadId, inputs, signal) {
    this.ctxRef = { sessionId: threadId, messageId: "", signal };
    try {
      // ... 现有逻辑；在 chunk 到达时更新 this.ctxRef.messageId = msg.id
    } finally {
      this.ctxRef = null;
    }
  }
}
```

注意：单进程 + GraphService 是 singleton，但 ctxRef 是 mutable 共享状态。本地轨**单用户串行 run**，不会并发；如果未来出现并发 run（云端轨）需改成 per-run AsyncLocalStorage。本范围声明 single-run 假设。

## 4. WS 事件 + types-agent schema

`libs/types-agent/src/session.ts` 加：

```ts
export const RunToolCallStartEventSchema = z.object({
  sessionId: z.string(),
  messageId: z.string(),
  toolCallId: z.string(),
  name: z.string(),
  args: z.unknown(),
});
export type RunToolCallStartEvent = z.infer<typeof RunToolCallStartEventSchema>;

export const RunToolCallProgressEventSchema = z.object({
  sessionId: z.string(),
  toolCallId: z.string(),
  delta: z.string(),
});
export type RunToolCallProgressEvent = z.infer<typeof RunToolCallProgressEventSchema>;

export const RunToolCallEndEventSchema = z.object({
  sessionId: z.string(),
  messageId: z.string(),
  toolCallId: z.string(),
  name: z.string(),
  ok: z.boolean(),
  /** 前 200 字符预览，前端用此摘要显示。 */
  resultPreview: z.string(),
  /** 完整 result 字符串（即 ToolMessage.content），runner 用此写 session_messages。 */
  content: z.string(),
});
export type RunToolCallEndEvent = z.infer<typeof RunToolCallEndEventSchema>;
```

`SESSION_WS_EVENTS` 加：

```ts
runToolCallStart: "run.tool_call_start",
runToolCallProgress: "run.tool_call_progress",
runToolCallEnd: "run.tool_call_end",
```

`SessionGateway` 加三个 `@OnEvent` 转发：

- `runToolCallStart` / `runToolCallProgress`：原 payload 直接 emit 给客户端
- `runToolCallEnd`：剥掉 `content` 字段后再 emit 给客户端（content 可能很大，前端只用 `resultPreview`；content 留在 NestJS event bus 供 runner 落库消费）

实现 pattern 与现有 runChunk 等 handler 一致；end handler 多一步 `const { content, ...wireOut } = payload; client.emit(...wireOut)`。

## 5. 落库 session_messages

### 5.1 写入

`RunnerService.runOnce` 在 streamMessage 流结束时（success path）写 assistant 时**新增 tool_calls 字段**：

- 收集 accumulated AIMessageChunk 的 `tool_calls`（若有），JSON.stringify 存到 `session_messages.tool_calls`
- 同时，对于本轮 ReAct 内的每个 tool execution，需要写一条 `role=tool` 的 session_messages 行（id 用 `tool-${toolCallId}` 或独立 uuid；推荐用 `toolCallId` 作 id —— 与 LangChain ToolMessage.tool_call_id 对齐）

实现：在 `createToolsNode` 里执行完每个 tool 后，**emit 一个内部事件**（或直接调 SessionMessageService —— 但 graph 层不该依赖 server-agent 的 service）。**走事件**：

加 WS 事件 `run.tool_message_persist`（也可复用 runToolCallEnd 内部含 content）：runner 在 runToolCallEnd handler 里写 session_messages role=tool 行。**实现更干净**。

修订：`RunToolCallEndEvent` 加 `content: string` 字段（完整 result，非 preview），前端只用 preview，runner 用 content 落库。

### 5.2 SessionMessageService 加方法

```ts
async recordAssistantWithToolCalls(input: {
  id: string;
  sessionId: string;
  content: string;
  reasoning: string | null;
  toolCalls: unknown[] | null;  // 序列化为 tool_calls JSON
}): Promise<void>;

async recordToolResult(input: {
  /** 用 tool_call_id 作 id —— 与 LangChain ToolMessage 一致，且天然幂等。 */
  id: string;
  sessionId: string;
  /** 关联到上游 assistant 消息（即 tool_call_id）。 */
  toolCallId: string;
  content: string;
}): Promise<void>;
```

`role` 列分别是 "assistant" / "tool"。第二个 record 的 id = toolCallId，幂等。

### 5.3 Runner 调度

```ts
// runOnce 内事件处理：
@OnEvent(SESSION_WS_EVENTS.runToolCallEnd)
async onToolCallEnd(e: RunToolCallEndEvent) {
  // 用 toolCallId 作 id 写入；幂等。
  await this.sessionMessages.recordToolResult({
    id: e.toolCallId,
    sessionId: e.sessionId,
    toolCallId: e.toolCallId,
    content: e.content,
  }).catch(err => this.logger.error("recordToolResult 失败", err));
}
```

run 结束写 assistant 时，从 `accumulated.tool_calls` 取出 toolCalls JSON 一并入 session_messages。

## 6. 历史读取改造

### 6.1 SessionController.history 二次组装

`SessionMessageService.listPage` 仍返回所有 role 的行。controller 在拼 HistoryResponse 时：

```ts
const rows = page.messages;  // 含 assistant / user / tool 三种 role
const toolRows = rows.filter((r) => r.role === "tool");
const toolByCallId = new Map(toolRows.map((r) => [r.toolCallId, r]));
const messages = rows
  .filter((r) => r.role !== "tool")
  .map((r) => {
    if (r.role !== "assistant" || !r.toolCalls) {
      return baseMap(r);
    }
    const calls = JSON.parse(r.toolCalls) as Array<{
      id: string;
      name: string;
      args: unknown;
    }>;
    const toolCalls = calls.map((c) => {
      const tr = toolByCallId.get(c.id);
      return {
        toolCallId: c.id,
        name: c.name,
        args: c.args,
        status: "ok" as const,  // 历史一定已完成
        result: tr?.content ?? "",
      };
    });
    return { ...baseMap(r), toolCalls };
  });
```

注意：分页边界 —— 如果 assistant 在本页、对应 tool result 在下一页（更早），会拼不全。**约束**：assistant + 它所有 tool result 必须同一页内。SessionMessage createdAt 顺序天然保证 tool result 紧跟 assistant 之后；但 cursor 切片可能把它们分开。**实施时改 listPage**：cursor 切到 assistant 边界时，把它的所有 role=tool 后续行一并带进当页（即 limit 是软上限，按 assistant 边界 round up）。

### 6.2 HistoryMessage schema 加 toolCalls

```ts
export const HistoryToolCallSchema = z.object({
  toolCallId: z.string(),
  name: z.string(),
  args: z.unknown(),
  status: z.enum(["ok", "error"]),
  result: z.string(),
});

export const HistoryMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
  reasoning: z.string().optional(),
  toolCalls: z.array(HistoryToolCallSchema).optional(),
});
```

## 7. bash 内建 tool

`libs/agent/src/tools/builtins/bash.tool.ts`：见第 5 节草稿，关键点：

- cwd：`MeshbotConfigService.getWorkspaceDir()` —— prod `~/.meshbot/workspace/`（mkdir if missing）；dev/test `process.cwd()`；可 `MESHBOT_WORKSPACE` 覆盖
- spawn(SHELL, ["-lc", cmd]) + child.signal = ctx.signal（用户 Stop 中断）
- 120s 超时 `setTimeout` → `child.kill("SIGKILL")`
- stdout+stderr 合并：每个 data chunk 全量 emit `run.tool_call_progress` 给前端；buffer 累积仅到 20KB 上限，超出后丢弃但记 `truncatedAt`
- 返回字符串首行 `[exit N] cwd=X` + 可选 `[output truncated at ...]` + 截断后的 buffer

**安全声明**：cwd "锁死" 仅指 spawn 的 cwd 参数；用户 LLM 可在 command 里 `cd /tmp && ls` 越出。本范围视为已知 + 单用户本地轨可接受。真隔离需 chroot/sandbox/Docker，超出范围。

## 8. date 内建 tool

`libs/agent/src/tools/builtins/date.tool.ts`：

```ts
const DateArgsSchema = z.object({
  timezone: z
    .string()
    .min(1)
    .describe(
      "IANA timezone, e.g. 'Asia/Shanghai'. REQUIRED. " +
        "If you don't know the user's timezone, do NOT guess — ask the user first.",
    ),
  format: z
    .enum(["iso", "rfc", "human"])
    .optional()
    .default("human")
    .describe("Output format. Default 'human' = YYYY-MM-DD HH:mm:ss TZ."),
});

@Injectable()
@Tool()
export class DateTool implements MeshbotTool<DateArgs, string> {
  readonly name = "date";
  readonly description =
    "Return the current date/time in a specified IANA timezone. " +
    "If user's timezone is unknown, ASK the user first — do NOT guess.";
  readonly schema = DateArgsSchema;

  async execute(args: DateArgs): Promise<string> {
    try {
      // 校验 IANA timezone 合法
      new Intl.DateTimeFormat("en-US", { timeZone: args.timezone });
    } catch {
      return `Error: invalid IANA timezone "${args.timezone}". Ask the user for the correct one (e.g. Asia/Shanghai, America/New_York, UTC).`;
    }
    return formatDate(new Date(), args.timezone, args.format);
  }
}

function formatDate(d: Date, tz: string, fmt: "iso" | "rfc" | "human"): string {
  // human: 用 Intl.DateTimeFormat 取 YYYY-MM-DD HH:mm:ss + 短时区名拼成串
  // iso: Date.toISOString() 然后用 Intl 计算 offset 拼成 +08:00 形式
  // rfc: Intl 取 toUTCString-like
  // 具体实现交给 plan
}
```

不引 interrupt。schema 必填 + description 引导 LLM 询问用户 + tool 返 error 兜底。

## 9. 前端

### 9.1 TimelineMessage 扩展

```ts
export interface ToolCallView {
  toolCallId: string;
  name: string;
  args: unknown;
  progress?: string;  // 仅流式 tool 累积
  result?: string;
  status: "running" | "ok" | "error";
}

export interface TimelineMessage {
  // ... 已有
  toolCalls?: ToolCallView[];
}
```

### 9.2 ToolCallBlock 组件（新文件）

`apps/web-agent/src/components/session/tool-call-block.tsx`：

- 默认折叠
- 标签格式：`🔧 bash · running` / `🔧 bash ✓` / `🔧 bash ✗`
- 风格仿 ReasoningBlock：左侧细竖线 + 等宽小字 + 无背景
- 展开后显示：args（JSON 折叠）+ progress（如果有，<pre>）+ result（最终 content）

### 9.3 MessageList 渲染顺序

assistant 气泡内：

```
[ReasoningBlock]   ← 已有
[ToolCallBlock × N]  ← 新增
[MarkdownContent content]  ← 已有
[usage line]
```

### 9.4 session page handlers

加 `onToolStart` / `onToolProgress` / `onToolEnd`：见第 7' 节伪代码，按 messageId 找气泡 → 增删改 toolCalls 数组。

socket on/off 注册三个新事件。

### 9.5 历史持久化读取

fetchHistory 返回的 message 含 `toolCalls?: HistoryToolCall[]`。前端转 `ToolCallView`：

```ts
const toolCalls = m.toolCalls?.map((tc) => ({
  toolCallId: tc.toolCallId,
  name: tc.name,
  args: tc.args,
  status: tc.status,
  result: tc.result,
  // progress 留空（流式过程没存）
}));
```

## 10. 测试

### 后端
- `tools/tool-registry.spec.ts`：扫描 + 注册 + 重名报错 + get/list
- `tools/builtins/date.tool.spec.ts`：合法 tz 返串 / 非法 tz 返 error / 各 format
- `tools/builtins/bash.tool.spec.ts`：echo hello 返成功 / 超时被 kill / 截断 20KB / abort signal 中断
- `graph/nodes/tools.node.spec.ts`：last AIMessage 含 tool_calls → 调对应 tool；未知 tool 返 error；schema 校验失败返 error；emit start/end
- `session-message.service.spec.ts` 加 recordToolResult / recordAssistantWithToolCalls 幂等测试

### 手测
1. 让 LLM 调 bash：`ls -la` → 前端能看到 ToolCallBlock 实时累积 stdout
2. 让 LLM 调 date 不传 timezone → 看 LLM 是否会重问；传 `Asia/Shanghai` → 返当前时间
3. 让 LLM 调 bash 长命令 `sleep 200` → 120s 后被 kill，error 返回
4. 用户 Stop 期间 tool 正在跑 → AbortController 触发 → tool 被中断

## 11. 涉及文件

| 层 | 文件 | 改动 |
|---|---|---|
| types | `libs/types-agent/src/session.ts` | RunToolCall* events + SESSION_WS_EVENTS keys + HistoryMessage.toolCalls + HistoryToolCallSchema |
| agent | `libs/agent/src/tools/tool.types.ts` | 新增 |
| agent | `libs/agent/src/tools/tool.decorator.ts` | 新增 |
| agent | `libs/agent/src/tools/tool-registry.ts` | 替换占位 |
| agent | `libs/agent/src/tools/builtins/bash.tool.ts` | 新增 |
| agent | `libs/agent/src/tools/builtins/date.tool.ts` | 新增 |
| agent | `libs/agent/src/graph/nodes/tools.node.ts` | 新增 |
| agent | `libs/agent/src/graph/nodes/supervisor.node.ts` | bindTools |
| agent | `libs/agent/src/graph/graph.builder.ts` | 加 tools 节点 + conditional edge |
| agent | `libs/agent/src/graph/graph.service.ts` | ctxRef 注入；构图传 registry + ctxGetter |
| agent | `libs/agent/src/agent.module.ts` | provider 加 BashTool / DateTool；imports DiscoveryModule（`@nestjs/core` 子模块，提供 DiscoveryService） |
| agent | `libs/agent/src/config/meshbot-config.service.ts` | 加 getWorkspaceDir |
| server-agent | `apps/server-agent/src/ws/session.gateway.ts` | OnEvent 三个 runToolCall* 转发 |
| server-agent | `apps/server-agent/src/services/runner.service.ts` | OnEvent runToolCallEnd 写 tool result；assistant 写带 tool_calls |
| server-agent | `apps/server-agent/src/services/session-message.service.ts` | recordToolResult + recordAssistant 支持 toolCalls |
| server-agent | `apps/server-agent/src/services/session-message.service.spec.ts` | 新测试 |
| server-agent | `apps/server-agent/src/controllers/session.controller.ts` | history 二次组装 |
| web-agent | `apps/web-agent/src/components/session/message-list.tsx` | TimelineMessage.toolCalls + 渲染 ToolCallBlock |
| web-agent | `apps/web-agent/src/components/session/tool-call-block.tsx` | 新增 |
| web-agent | `apps/web-agent/src/app/session/page.tsx` | onToolStart / Progress / End handlers + 装卸 + history 读 toolCalls |

## 12. 边界 / 非目标

- **单 run 串行假设**：GraphService.ctxRef 是 mutable。本地轨满足，未来并发需 AsyncLocalStorage
- **不引 LangGraph interrupt**：date 时区走 schema-error-reraise；后续 bash 危险命令确认等场景再上 interrupt
- **bash cwd 仅默认起点不真隔离**：用户 LLM 主动 cd 仍能出去
- **tool args / progress 不做大小限制写库**：tool result 写库 = 整个 content 字符串（可能很长）。后续考虑加 50KB 上限
- **历史分页边界**：listPage 需按 assistant boundary round up 把对应 tool 行一并带回，避免拼不全
- **第三方 zod-to-json-schema 依赖**：LangChain 内部已用，添加显式依赖避免间接依赖断
