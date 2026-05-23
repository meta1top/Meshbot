# Agent Tools 机制（含 bash / date 内建）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 `@Tool()` 装饰器 + ToolRegistry 启动扫描 + LangGraph ToolNode 接入 + bash/date 两个内建 tool + 三个 WS 事件流式反馈 + session_messages 持久化 ReAct 轨迹 + 前端 ToolCallBlock 展示。

**Architecture:** Tool 是带 `@Tool()` 元数据的 `@Injectable` 类，启动时 ToolRegistry 用 `DiscoveryService` 扫描自注册。Graph 加 tools 节点（自写，不用 langgraph 内置 ToolNode），ReAct 循环 supervisor↔tools。GraphService 持有 mutable ctxRef（单 run 串行假设），toolsNode 调用时通过 getter 拿当前 sessionId/messageId/signal/emitter，把 tool_call_id 拼入注入到 tool。Tool execute 通过 ctx.emitter 推 `run.tool_call_*` 事件；session.gateway 转发；runner 监听 end 事件落库；session_messages 启用预留 tool_calls/tool_call_id 字段；history 二次组装把 role=tool 行挂到上游 assistant.toolCalls；前端 ToolCallBlock 折叠展示 + 历史读取。

**Tech Stack:** NestJS + @nestjs/event-emitter + @nestjs/core DiscoveryService；LangGraph + @langchain/core；TypeORM + SQLite；React + Jotai。

**Spec:** [docs/superpowers/specs/2026-05-24-agent-tools-mechanism-design.md](../specs/2026-05-24-agent-tools-mechanism-design.md)

---

## File Structure

**libs/types-agent（共享 schema）**：
- Modify: `libs/types-agent/src/session.ts` — `RunToolCall*EventSchema` + `SESSION_WS_EVENTS.runToolCall*` + `HistoryToolCallSchema` + `HistoryMessageSchema.toolCalls`

**libs/agent**：
- Create: `libs/agent/src/tools/tool.types.ts` — `MeshbotTool` / `ToolContext` 接口
- Create: `libs/agent/src/tools/tool.decorator.ts` — `@Tool()` 装饰器 + `TOOL_METADATA_KEY`
- Replace: `libs/agent/src/tools/tool-registry.ts` — 实际实现（占位换掉）
- Create: `libs/agent/src/tools/builtins/bash.tool.ts`
- Create: `libs/agent/src/tools/builtins/date.tool.ts`
- Create: `libs/agent/src/tools/tool-registry.spec.ts` — 注册/重名/get
- Create: `libs/agent/src/tools/builtins/date.tool.spec.ts`
- Create: `libs/agent/src/tools/builtins/bash.tool.spec.ts`
- Create: `libs/agent/src/graph/nodes/tools.node.ts` — 自写 toolsNode
- Create: `libs/agent/src/graph/nodes/tools.node.spec.ts`
- Modify: `libs/agent/src/graph/nodes/supervisor.node.ts` — `bindTools`
- Modify: `libs/agent/src/graph/graph.builder.ts` — 加 tools 节点 + conditional edge
- Modify: `libs/agent/src/graph/graph.service.ts` — 构图传 registry + ctxGetter；ctxRef
- Modify: `libs/agent/src/agent.module.ts` — imports DiscoveryModule；providers 加 BashTool/DateTool
- Modify: `libs/agent/src/config/meshbot-config.service.ts` — `getWorkspaceDir`
- Modify: `libs/agent/src/index.ts` — re-export tool types
- Modify: `libs/agent/package.json` — 加 `@nestjs/event-emitter` peerDependency

**apps/server-agent**：
- Modify: `apps/server-agent/src/ws/session.gateway.ts` — 三个 `@OnEvent(runToolCall*)`
- Modify: `apps/server-agent/src/services/runner.service.ts` — `@OnEvent(runToolCallEnd)` 写 tool result；assistant 写带 tool_calls
- Modify: `apps/server-agent/src/services/session-message.service.ts` — `recordToolResult` + assistant 接 `toolCalls`
- Modify: `apps/server-agent/src/services/session-message.service.spec.ts` — 新测试
- Modify: `apps/server-agent/src/controllers/session.controller.ts` — history 二次组装

**apps/web-agent**：
- Create: `apps/web-agent/src/components/session/tool-call-block.tsx`
- Modify: `apps/web-agent/src/components/session/message-list.tsx` — `TimelineMessage.toolCalls` + 渲染
- Modify: `apps/web-agent/src/app/session/page.tsx` — `onToolStart/Progress/End` handlers + history 读取

---

## Task 1: libs/types-agent — RunToolCall* events + HistoryToolCall schema

**Files:**
- Modify: `libs/types-agent/src/session.ts`

- [ ] **Step 1: 在 RunUsageEventSchema 之后、SessionTopicSchema 之前插入新 schema**

```ts
/** socket: run.tool_call_start —— tool 即将开始执行。 */
export const RunToolCallStartEventSchema = z.object({
  sessionId: z.string(),
  messageId: z.string(),
  toolCallId: z.string(),
  name: z.string(),
  args: z.unknown(),
});
export type RunToolCallStartEvent = z.infer<typeof RunToolCallStartEventSchema>;

/** socket: run.tool_call_progress —— tool 执行中的增量输出（如 bash stdout）。 */
export const RunToolCallProgressEventSchema = z.object({
  sessionId: z.string(),
  toolCallId: z.string(),
  delta: z.string(),
});
export type RunToolCallProgressEvent = z.infer<
  typeof RunToolCallProgressEventSchema
>;

/**
 * Tool 执行结束（成功/失败）。
 *
 * - `resultPreview`：前 200 字符摘要，前端显示。
 * - `content`：完整 result 字符串，runner 落库用；**gateway 转发前剥掉**，
 *   不上 socket 线。
 */
export const RunToolCallEndEventSchema = z.object({
  sessionId: z.string(),
  messageId: z.string(),
  toolCallId: z.string(),
  name: z.string(),
  ok: z.boolean(),
  resultPreview: z.string(),
  content: z.string(),
});
export type RunToolCallEndEvent = z.infer<typeof RunToolCallEndEventSchema>;
```

- [ ] **Step 2: SESSION_WS_EVENTS 加三个 key**

找到 `SESSION_WS_EVENTS` 定义（应在文件末尾附近）。在 `runUsage` 之后加：

```ts
runToolCallStart: "run.tool_call_start",
runToolCallProgress: "run.tool_call_progress",
runToolCallEnd: "run.tool_call_end",
```

- [ ] **Step 3: HistoryMessage.toolCalls 字段 + HistoryToolCallSchema**

在 `HistoryMessageSchema` 之前插入：

```ts
/** 历史 ReAct 轨迹中的单次工具调用。 */
export const HistoryToolCallSchema = z.object({
  toolCallId: z.string(),
  name: z.string(),
  args: z.unknown(),
  status: z.enum(["ok", "error"]),
  result: z.string(),
});
export type HistoryToolCall = z.infer<typeof HistoryToolCallSchema>;
```

修改 `HistoryMessageSchema`：

```ts
export const HistoryMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
  reasoning: z.string().optional(),
  toolCalls: z.array(HistoryToolCallSchema).optional(),
});
```

- [ ] **Step 4: typecheck**

Run: `pnpm --filter @meshbot/types-agent typecheck`
Expected: 0 errors

- [ ] **Step 5: Commit**

```bash
git add libs/types-agent/src/session.ts
git commit -m "feat(types-agent): RunToolCall* events + HistoryToolCall schema

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: libs/agent — Tool 抽象（types + decorator）

**Files:**
- Create: `libs/agent/src/tools/tool.types.ts`
- Create: `libs/agent/src/tools/tool.decorator.ts`
- Modify: `libs/agent/package.json` — 加 `@nestjs/event-emitter` 依赖

- [ ] **Step 1: 加 @nestjs/event-emitter 依赖**

Run:
```bash
pnpm --filter @meshbot/agent add @nestjs/event-emitter@^3.1.0
```

- [ ] **Step 2: 新建 tool.types.ts**

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

- [ ] **Step 3: 新建 tool.decorator.ts**

```ts
import { Injectable, applyDecorators } from "@nestjs/common";

export const TOOL_METADATA_KEY = Symbol("meshbot:tool");

/**
 * 标记一个类为 meshbot tool。配合 MeshbotTool 接口使用：
 * ```
 * @Tool()
 * export class BashTool implements MeshbotTool<...> { ... }
 * ```
 * 装饰器自带 @Injectable() —— ToolRegistry 启动时扫描所有 provider 找带
 * 此 metadata 的实例并注册。
 */
export function Tool(): ClassDecorator {
  return applyDecorators(Injectable(), (target: object) => {
    Reflect.defineMetadata(TOOL_METADATA_KEY, true, target);
  });
}
```

- [ ] **Step 4: typecheck**

Run: `pnpm --filter @meshbot/agent typecheck`
Expected: 0 errors

- [ ] **Step 5: Commit**

```bash
git add libs/agent/src/tools/tool.types.ts libs/agent/src/tools/tool.decorator.ts libs/agent/package.json pnpm-lock.yaml
git commit -m "feat(agent-tools): MeshbotTool 接口 + @Tool() 装饰器 + @nestjs/event-emitter 依赖

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: libs/agent — ToolRegistry 失败测试

**Files:**
- Create: `libs/agent/src/tools/tool-registry.spec.ts`

- [ ] **Step 1: 新建测试文件**

```ts
import { DiscoveryService } from "@nestjs/core";
import { z } from "zod";
import { Tool } from "./tool.decorator";
import { ToolRegistry } from "./tool-registry";
import type { MeshbotTool, ToolContext } from "./tool.types";

@Tool()
class FakeAlphaTool implements MeshbotTool<{ x: number }, string> {
  readonly name = "alpha";
  readonly description = "Alpha tool";
  readonly schema = z.object({ x: z.number() });
  async execute(args: { x: number }, _ctx: ToolContext): Promise<string> {
    return `alpha:${args.x}`;
  }
}

@Tool()
class FakeBetaTool implements MeshbotTool<{ y: string }, string> {
  readonly name = "beta";
  readonly description = "Beta tool";
  readonly schema = z.object({ y: z.string() });
  async execute(args: { y: string }, _ctx: ToolContext): Promise<string> {
    return `beta:${args.y}`;
  }
}

@Tool()
class DuplicateAlphaTool implements MeshbotTool<{ x: number }, string> {
  readonly name = "alpha";
  readonly description = "Duplicate";
  readonly schema = z.object({ x: z.number() });
  async execute(args: { x: number }, _ctx: ToolContext): Promise<string> {
    return `dup:${args.x}`;
  }
}

class NotATool {
  hello() {
    return "world";
  }
}

function fakeDiscovery(
  instances: object[],
): DiscoveryService {
  return {
    getProviders: () =>
      instances.map((inst) => ({ instance: inst })) as never,
  } as unknown as DiscoveryService;
}

describe("ToolRegistry", () => {
  it("onModuleInit 注册所有带 @Tool() 的 provider", () => {
    const alpha = new FakeAlphaTool();
    const beta = new FakeBetaTool();
    const other = new NotATool();
    const registry = new ToolRegistry(fakeDiscovery([alpha, beta, other]));
    registry.onModuleInit();
    expect(registry.get("alpha")).toBe(alpha);
    expect(registry.get("beta")).toBe(beta);
    expect(registry.list().map((t) => t.name).sort()).toEqual(["alpha", "beta"]);
  });

  it("重复 name 启动期抛错", () => {
    const a = new FakeAlphaTool();
    const dup = new DuplicateAlphaTool();
    const registry = new ToolRegistry(fakeDiscovery([a, dup]));
    expect(() => registry.onModuleInit()).toThrow(/Duplicate tool name: alpha/);
  });

  it("asLangChainBindable 返回数组长度匹配 tool 数", () => {
    const alpha = new FakeAlphaTool();
    const beta = new FakeBetaTool();
    const registry = new ToolRegistry(fakeDiscovery([alpha, beta]));
    registry.onModuleInit();
    const tools = registry.asLangChainBindable();
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.name).sort()).toEqual(["alpha", "beta"]);
  });

  it("get 不存在的 name 返 undefined", () => {
    const registry = new ToolRegistry(fakeDiscovery([new FakeAlphaTool()]));
    registry.onModuleInit();
    expect(registry.get("nonexistent")).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `pnpm --filter @meshbot/agent test -- tool-registry.spec`
Expected: 测试 fail（占位 ToolRegistry 没有 onModuleInit / get / asLangChainBindable 方法）

- [ ] **Step 3: Commit**

```bash
git add libs/agent/src/tools/tool-registry.spec.ts
git commit -m "test(agent-tools): ToolRegistry 失败测试

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: libs/agent — ToolRegistry 实现

**Files:**
- Modify (replace): `libs/agent/src/tools/tool-registry.ts`

- [ ] **Step 1: 整体替换文件**

```ts
import { Injectable, OnModuleInit } from "@nestjs/common";
import { DiscoveryService } from "@nestjs/core";
import { tool as createLcTool } from "@langchain/core/tools";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { TOOL_METADATA_KEY } from "./tool.decorator";
import type { MeshbotTool } from "./tool.types";

/**
 * 启动时扫描所有 @Tool() provider 自注册；singleton；重名 fail-fast。
 *
 * asLangChainBindable() 返回的 LC tool 实例**不会**被 LangChain 真调（我们
 * 自写 toolsNode），仅用于 model.bindTools() 把 schema 注入 LLM。真正的
 * 执行在 toolsNode 里用 registry.get(name).execute(args, ctx)。
 */
@Injectable()
export class ToolRegistry implements OnModuleInit {
  private readonly tools = new Map<string, MeshbotTool>();

  constructor(private readonly discovery: DiscoveryService) {}

  onModuleInit(): void {
    const providers = this.discovery.getProviders();
    for (const wrapper of providers) {
      const instance = wrapper.instance;
      if (!instance || typeof instance !== "object") continue;
      const ctor = (instance as object).constructor;
      if (!ctor) continue;
      const isTool = Reflect.getMetadata(TOOL_METADATA_KEY, ctor);
      if (!isTool) continue;
      const tool = instance as MeshbotTool;
      if (this.tools.has(tool.name)) {
        throw new Error(`Duplicate tool name: ${tool.name}`);
      }
      this.tools.set(tool.name, tool);
    }
  }

  /** LC tool 数组用于 model.bindTools()。func 是占位，不会被真调。 */
  asLangChainBindable(): StructuredToolInterface[] {
    return [...this.tools.values()].map((t) =>
      createLcTool(async () => "", {
        name: t.name,
        description: t.description,
        schema: t.schema,
      }),
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

- [ ] **Step 2: 跑测试，确认全过**

Run: `pnpm --filter @meshbot/agent test -- tool-registry.spec`
Expected: 4 passed

- [ ] **Step 3: typecheck**

Run: `pnpm --filter @meshbot/agent typecheck`
Expected: 0 errors

- [ ] **Step 4: Commit**

```bash
git add libs/agent/src/tools/tool-registry.ts
git commit -m "feat(agent-tools): ToolRegistry 实现（扫描 + 重名 fail-fast + LC bindable）

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: libs/agent — date 内建 tool（含测试）

**Files:**
- Create: `libs/agent/src/tools/builtins/date.tool.ts`
- Create: `libs/agent/src/tools/builtins/date.tool.spec.ts`

- [ ] **Step 1: 新建 date.tool.spec.ts（失败测试）**

```ts
import { DateTool } from "./date.tool";

describe("DateTool", () => {
  const tool = new DateTool();

  it("非法 timezone 返 Error 字符串（让 LLM 重问）", async () => {
    const out = await tool.execute(
      { timezone: "Not/AReal_TZ", format: "human" },
      {} as never,
    );
    expect(out).toMatch(/^Error: invalid IANA timezone/);
  });

  it("合法 timezone (Asia/Shanghai) 'human' 格式返 YYYY-MM-DD HH:mm:ss + tz", async () => {
    const out = await tool.execute(
      { timezone: "Asia/Shanghai", format: "human" },
      {} as never,
    );
    // 形如 "2026-05-24 12:34:56 Asia/Shanghai"
    expect(out).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} Asia\/Shanghai$/,
    );
  });

  it("'iso' 格式返 ISO 8601 with offset", async () => {
    const out = await tool.execute(
      { timezone: "Asia/Shanghai", format: "iso" },
      {} as never,
    );
    // 形如 "2026-05-24T12:34:56+08:00"
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  });

  it("'rfc' 格式返 RFC 1123 风格", async () => {
    const out = await tool.execute(
      { timezone: "UTC", format: "rfc" },
      {} as never,
    );
    // 形如 "Sun, 24 May 2026 12:34:56 GMT"
    expect(out).toMatch(
      /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} (GMT|UTC|[+-]\d{4})$/,
    );
  });

  it("format 默认 human", async () => {
    const out = await tool.execute(
      { timezone: "UTC", format: undefined as never },
      {} as never,
    );
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC$/);
  });
});
```

- [ ] **Step 2: 跑测试，确认 fail（模块未找到）**

Run: `pnpm --filter @meshbot/agent test -- date.tool.spec`
Expected: Cannot find module './date.tool'

- [ ] **Step 3: 新建 date.tool.ts 实现**

```ts
import { z } from "zod";
import { Tool } from "../tool.decorator";
import type { MeshbotTool, ToolContext } from "../tool.types";

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
type DateArgs = z.infer<typeof DateArgsSchema>;

@Tool()
export class DateTool implements MeshbotTool<DateArgs, string> {
  readonly name = "date";
  readonly description =
    "Return the current date/time in a specified IANA timezone. " +
    "If user's timezone is unknown, ASK the user first — do NOT guess.";
  readonly schema = DateArgsSchema;

  async execute(args: DateArgs, _ctx: ToolContext): Promise<string> {
    // 校验 IANA timezone 合法（构造 DateTimeFormat 抛 RangeError 即非法）
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: args.timezone });
    } catch {
      return (
        `Error: invalid IANA timezone "${args.timezone}". ` +
        `Ask the user for the correct one (e.g. Asia/Shanghai, America/New_York, UTC).`
      );
    }
    const now = new Date();
    switch (args.format) {
      case "iso":
        return formatIso(now, args.timezone);
      case "rfc":
        return formatRfc(now, args.timezone);
      case "human":
      default:
        return formatHuman(now, args.timezone);
    }
  }
}

/** "2026-05-24 12:34:56 Asia/Shanghai" */
function formatHuman(d: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  // hour 在某些 locale 下可能输出 "24"；规整成 "00"
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${get("year")}-${get("month")}-${get("day")} ${hour}:${get("minute")}:${get("second")} ${tz}`;
}

/** "2026-05-24T12:34:56+08:00" */
function formatIso(d: Date, tz: string): string {
  // 用 DateTimeFormat 拼出本地年月日时分秒
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const hour = get("hour") === "24" ? "00" : get("hour");
  const localStr = `${get("year")}-${get("month")}-${get("day")}T${hour}:${get("minute")}:${get("second")}`;
  return `${localStr}${tzOffset(d, tz)}`;
}

/** "Sun, 24 May 2026 12:34:56 GMT" 风格。 */
function formatRfc(d: Date, tz: string): string {
  if (tz === "UTC" || tz === "Etc/UTC") {
    return d.toUTCString();
  }
  // 非 UTC：用 en-US 格式 + 后缀 offset
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const hour = get("hour") === "24" ? "00" : get("hour");
  const offset = tzOffset(d, tz).replace(":", "");
  return `${get("weekday")}, ${get("day")} ${get("month")} ${get("year")} ${hour}:${get("minute")}:${get("second")} ${offset}`;
}

/** 返回形如 "+08:00" 的 UTC offset 串（基于 Intl 在该 tz 下的本地时与 UTC 时差）。 */
function tzOffset(d: Date, tz: string): string {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = dtf.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const hour = get("hour") === "24" ? "00" : get("hour");
  const localTs = Date.UTC(
    Number(get("year")),
    Number(get("month")) - 1,
    Number(get("day")),
    Number(hour),
    Number(get("minute")),
    Number(get("second")),
  );
  const diffMs = localTs - d.getTime();
  const totalMin = Math.round(diffMs / 60000);
  const sign = totalMin >= 0 ? "+" : "-";
  const abs = Math.abs(totalMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}
```

- [ ] **Step 4: 跑测试，确认全过**

Run: `pnpm --filter @meshbot/agent test -- date.tool.spec`
Expected: 5 passed

- [ ] **Step 5: typecheck**

Run: `pnpm --filter @meshbot/agent typecheck`
Expected: 0 errors

- [ ] **Step 6: Commit**

```bash
git add libs/agent/src/tools/builtins/date.tool.ts libs/agent/src/tools/builtins/date.tool.spec.ts
git commit -m "feat(agent-tools): date 内建 tool（IANA 时区 + iso/rfc/human 格式）

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: libs/agent — MeshbotConfigService.getWorkspaceDir

**Files:**
- Modify: `libs/agent/src/config/meshbot-config.service.ts`

- [ ] **Step 1: 加方法**

在 `getDatabasePath()` 之后加：

```ts
  /**
   * Bash tool 默认 cwd。
   * - prod：~/.meshbot/workspace/（不存在则 mkdir）
   * - dev/test（meshbotDir 在 repo 根下）：repo 根
   * - 可被环境变量 MESHBOT_WORKSPACE 覆盖
   */
  getWorkspaceDir(): string {
    if (process.env.MESHBOT_WORKSPACE) {
      return process.env.MESHBOT_WORKSPACE;
    }
    // meshbotDir 在 home 下 = 生产；在 repo 下 = dev
    const home = homedir();
    if (this.meshbotDir.startsWith(home)) {
      const dir = path.join(this.meshbotDir, "workspace");
      mkdirSync(dir, { recursive: true });
      return dir;
    }
    // dev：meshbotDir = <repoRoot>/.meshbot，repo 根就是它的 parent
    return path.dirname(this.meshbotDir);
  }
```

注意需要补 import：

```ts
import { existsSync, mkdirSync } from "node:fs";
```

（existsSync 应已 import；只需补 mkdirSync）

- [ ] **Step 2: typecheck**

Run: `pnpm --filter @meshbot/agent typecheck`
Expected: 0 errors

- [ ] **Step 3: Commit**

```bash
git add libs/agent/src/config/meshbot-config.service.ts
git commit -m "feat(agent-config): MeshbotConfigService.getWorkspaceDir

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: libs/agent — bash 内建 tool（含测试）

**Files:**
- Create: `libs/agent/src/tools/builtins/bash.tool.ts`
- Create: `libs/agent/src/tools/builtins/bash.tool.spec.ts`

- [ ] **Step 1: 新建 bash.tool.spec.ts**

```ts
import { EventEmitter2 } from "@nestjs/event-emitter";
import { MeshbotConfigService } from "../../config/meshbot-config.service";
import { BashTool } from "./bash.tool";
import type { ToolContext } from "../tool.types";

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const ctrl = new AbortController();
  return {
    sessionId: "s1",
    messageId: "m1",
    toolCallId: "tc1",
    emitter: new EventEmitter2(),
    signal: ctrl.signal,
    ...overrides,
  };
}

describe("BashTool", () => {
  // 用临时 workspace 避免污染
  const tmpDir = "/tmp";
  process.env.MESHBOT_WORKSPACE = tmpDir;
  const config = new MeshbotConfigService();
  const tool = new BashTool(config);

  it("echo hello 返成功 + 含 exit 0 和 stdout", async () => {
    const out = await tool.execute({ command: "echo hello" }, makeCtx());
    expect(out).toMatch(/^\[exit 0\]/);
    expect(out).toContain("hello");
  }, 10_000);

  it("非零退出码 返 [exit N]", async () => {
    const out = await tool.execute({ command: "exit 7" }, makeCtx());
    expect(out).toMatch(/^\[exit 7\]/);
  }, 10_000);

  it("emit run.tool_call_progress for stdout", async () => {
    const ctx = makeCtx();
    const events: { delta: string }[] = [];
    ctx.emitter.on("run.tool_call_progress", (e: { delta: string }) =>
      events.push(e),
    );
    await tool.execute({ command: "echo abc; echo def" }, ctx);
    const combined = events.map((e) => e.delta).join("");
    expect(combined).toContain("abc");
    expect(combined).toContain("def");
  }, 10_000);

  it("abort signal 中断命令", async () => {
    const ctrl = new AbortController();
    const ctx = makeCtx({ signal: ctrl.signal });
    const p = tool.execute({ command: "sleep 5" }, ctx);
    setTimeout(() => ctrl.abort(), 100);
    const out = await p;
    // 被信号杀死 → exit code 通常 null，sig 形如 SIGTERM/SIGKILL
    expect(out).toMatch(/^\[exit (signal:|null)/);
  }, 10_000);
});
```

- [ ] **Step 2: 跑测试，确认 fail（模块未找到）**

Run: `pnpm --filter @meshbot/agent test -- bash.tool.spec`
Expected: Cannot find module './bash.tool'

- [ ] **Step 3: 新建 bash.tool.ts 实现**

```ts
import { spawn } from "node:child_process";
import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { SESSION_WS_EVENTS } from "@meshbot/types-agent";
import { MeshbotConfigService } from "../../config/meshbot-config.service";
import { Tool } from "../tool.decorator";
import type { MeshbotTool, ToolContext } from "../tool.types";

const BashArgsSchema = z.object({
  command: z
    .string()
    .min(1)
    .describe("Shell command to run. Single string; can be a pipeline."),
});
type BashArgs = z.infer<typeof BashArgsSchema>;

const TIMEOUT_MS = 120_000; // 2 分钟
const CONTEXT_LIMIT = 20_000; // 给 LLM 的最终结果限 20KB
const SHELL = process.env.SHELL || "/bin/bash";

/**
 * Bash tool：在 workspace 下跑命令。
 *
 * - cwd 由 MeshbotConfigService.getWorkspaceDir() 决定
 * - stdout+stderr 合并，每段实时 emit 给前端（不截断）
 * - 给 LLM 的最终 result 截断到 20KB
 * - 120s 超时 → SIGKILL
 * - ctx.signal 触发时杀进程（用户 Stop）
 */
@Injectable()
@Tool()
export class BashTool implements MeshbotTool<BashArgs, string> {
  readonly name = "bash";
  readonly description =
    "Run a shell command in the meshbot workspace. " +
    "cwd is locked to ~/.meshbot/workspace (production) or repo root (dev). " +
    "Output is streamed to the user; the result you receive is the first " +
    `${CONTEXT_LIMIT} chars of stdout+stderr. 2-minute timeout.`;
  readonly schema = BashArgsSchema;

  constructor(private readonly config: MeshbotConfigService) {}

  async execute(args: BashArgs, ctx: ToolContext): Promise<string> {
    const cwd = this.config.getWorkspaceDir();
    return new Promise<string>((resolve, reject) => {
      const buf: string[] = [];
      let bufLen = 0;
      let totalLen = 0;
      let truncated = false;
      const child = spawn(SHELL, ["-lc", args.command], {
        cwd,
        env: { ...process.env, PWD: cwd },
        signal: ctx.signal,
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
      }, TIMEOUT_MS);
      const onData = (chunk: Buffer): void => {
        const s = chunk.toString("utf8");
        totalLen += s.length;
        // 前端实时全量推
        ctx.emitter.emit(SESSION_WS_EVENTS.runToolCallProgress, {
          sessionId: ctx.sessionId,
          toolCallId: ctx.toolCallId,
          delta: s,
        });
        // LLM context 截断
        if (!truncated) {
          if (bufLen + s.length <= CONTEXT_LIMIT) {
            buf.push(s);
            bufLen += s.length;
          } else {
            const room = CONTEXT_LIMIT - bufLen;
            if (room > 0) buf.push(s.slice(0, room));
            bufLen = CONTEXT_LIMIT;
            truncated = true;
          }
        }
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code, sig) => {
        clearTimeout(timer);
        const exitTag = sig ? `signal:${sig}` : code === null ? "null" : String(code);
        const head =
          `[exit ${exitTag}] cwd=${cwd}\n` +
          (truncated
            ? `[output truncated at ${CONTEXT_LIMIT} chars; total ${totalLen}]\n`
            : "");
        resolve(head + buf.join(""));
      });
    });
  }
}
```

- [ ] **Step 4: 跑测试**

Run: `pnpm --filter @meshbot/agent test -- bash.tool.spec`
Expected: 4 passed

- [ ] **Step 5: typecheck**

Run: `pnpm --filter @meshbot/agent typecheck`
Expected: 0 errors

- [ ] **Step 6: Commit**

```bash
git add libs/agent/src/tools/builtins/bash.tool.ts libs/agent/src/tools/builtins/bash.tool.spec.ts
git commit -m "feat(agent-tools): bash 内建 tool（cwd 锁 workspace + 120s 超时 + 20KB 给 LLM）

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: libs/agent — toolsNode 失败测试

**Files:**
- Create: `libs/agent/src/graph/nodes/tools.node.spec.ts`

- [ ] **Step 1: 新建测试**

```ts
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { z } from "zod";
import { ToolRegistry } from "../../tools/tool-registry";
import { Tool } from "../../tools/tool.decorator";
import type { MeshbotTool, ToolContext } from "../../tools/tool.types";
import { createToolsNode } from "./tools.node";

@Tool()
class EchoTool implements MeshbotTool<{ text: string }, string> {
  readonly name = "echo";
  readonly description = "Echo back";
  readonly schema = z.object({ text: z.string() });
  async execute(args: { text: string }, _ctx: ToolContext): Promise<string> {
    return `echoed: ${args.text}`;
  }
}

@Tool()
class FailingTool implements MeshbotTool<{ x: number }, string> {
  readonly name = "boom";
  readonly description = "Always throws";
  readonly schema = z.object({ x: z.number() });
  async execute(_args: { x: number }, _ctx: ToolContext): Promise<string> {
    throw new Error("boom!");
  }
}

function makeRegistry(tools: MeshbotTool[]): ToolRegistry {
  const fakeDisc = {
    getProviders: () => tools.map((t) => ({ instance: t })) as never,
  };
  const r = new ToolRegistry(fakeDisc as never);
  r.onModuleInit();
  return r;
}

const baseCtx = {
  sessionId: "s1",
  messageId: "m1",
  emitter: new EventEmitter2(),
  signal: new AbortController().signal,
};

describe("createToolsNode", () => {
  it("last 不是 AIMessage 或 tool_calls 为空 → 返空对象", async () => {
    const node = createToolsNode(makeRegistry([new EchoTool()]), () => baseCtx);
    const r1 = await node({ messages: [new HumanMessage("hi")] });
    expect(r1).toEqual({});
    const r2 = await node({
      messages: [new AIMessage({ content: "no tool calls" })],
    });
    expect(r2).toEqual({});
  });

  it("调对应 tool 返 ToolMessage", async () => {
    const node = createToolsNode(makeRegistry([new EchoTool()]), () => baseCtx);
    const ai = new AIMessage({
      content: "",
      tool_calls: [{ id: "tc1", name: "echo", args: { text: "hi" } }],
    });
    const r = await node({ messages: [ai] });
    expect(r.messages).toHaveLength(1);
    const tm = r.messages![0] as ToolMessage;
    expect(tm).toBeInstanceOf(ToolMessage);
    expect(tm.tool_call_id).toBe("tc1");
    expect(tm.content).toBe("echoed: hi");
  });

  it("未知 tool 返 error ToolMessage", async () => {
    const node = createToolsNode(makeRegistry([new EchoTool()]), () => baseCtx);
    const ai = new AIMessage({
      content: "",
      tool_calls: [{ id: "tc2", name: "nonexistent", args: {} }],
    });
    const r = await node({ messages: [ai] });
    const tm = r.messages![0] as ToolMessage;
    expect(String(tm.content)).toMatch(/Error: unknown tool nonexistent/);
  });

  it("tool 抛错 → 返 Error ToolMessage 且 ok=false", async () => {
    const emitter = new EventEmitter2();
    const events: Array<{ event: string; payload: unknown }> = [];
    emitter.onAny((event, payload) =>
      events.push({ event: String(event), payload }),
    );
    const node = createToolsNode(makeRegistry([new FailingTool()]), () => ({
      ...baseCtx,
      emitter,
    }));
    const ai = new AIMessage({
      content: "",
      tool_calls: [{ id: "tc3", name: "boom", args: { x: 1 } }],
    });
    const r = await node({ messages: [ai] });
    const tm = r.messages![0] as ToolMessage;
    expect(String(tm.content)).toMatch(/Error: boom!/);
    const end = events.find((e) => e.event === "run.tool_call_end");
    expect(end).toBeDefined();
    expect((end!.payload as { ok: boolean }).ok).toBe(false);
  });

  it("emit run.tool_call_start 和 run.tool_call_end", async () => {
    const emitter = new EventEmitter2();
    const events: string[] = [];
    emitter.onAny((event) => events.push(String(event)));
    const node = createToolsNode(makeRegistry([new EchoTool()]), () => ({
      ...baseCtx,
      emitter,
    }));
    await node({
      messages: [
        new AIMessage({
          content: "",
          tool_calls: [{ id: "tc4", name: "echo", args: { text: "x" } }],
        }),
      ],
    });
    expect(events).toContain("run.tool_call_start");
    expect(events).toContain("run.tool_call_end");
  });
});
```

- [ ] **Step 2: 跑测试，确认 fail**

Run: `pnpm --filter @meshbot/agent test -- tools.node.spec`
Expected: Cannot find module './tools.node'

- [ ] **Step 3: Commit**

```bash
git add libs/agent/src/graph/nodes/tools.node.spec.ts
git commit -m "test(agent-graph): toolsNode 失败测试

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: libs/agent — toolsNode 实现

**Files:**
- Create: `libs/agent/src/graph/nodes/tools.node.ts`

- [ ] **Step 1: 新建文件**

```ts
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { SESSION_WS_EVENTS } from "@meshbot/types-agent";
import type { ToolRegistry } from "../../tools/tool-registry";
import type { ToolContext } from "../../tools/tool.types";
import type { GraphState } from "../graph.builder";

const RESULT_PREVIEW_LIMIT = 200;

/**
 * 自写 toolsNode：从 last AIMessage.tool_calls 取调用，按 name 调
 * registry.get()，传入 ctx 执行；结果以 ToolMessage append 到 state。
 *
 * 不用 langgraph 内置 ToolNode：内置 ToolNode 期望 tools[] 直接传入，无法
 * 在每次调用时注入 toolCallId / messageId 等动态 ctx。
 *
 * @param ctxGetter 由 GraphService 提供；每次进入节点时调，返回当下 ctx base。
 */
export function createToolsNode(
  registry: ToolRegistry,
  ctxGetter: () => Omit<ToolContext, "toolCallId">,
) {
  return async function toolsNode(
    state: GraphState,
  ): Promise<Partial<GraphState>> {
    const last = state.messages[state.messages.length - 1];
    if (!(last instanceof AIMessage) || !(last.tool_calls?.length ?? 0)) {
      return {};
    }
    const ctxBase = ctxGetter();
    const results: ToolMessage[] = [];
    for (const call of last.tool_calls ?? []) {
      const toolCallId = call.id ?? "";
      const tool = registry.get(call.name);
      if (!tool) {
        results.push(
          new ToolMessage({
            tool_call_id: toolCallId,
            name: call.name,
            content: `Error: unknown tool ${call.name}`,
          }),
        );
        continue;
      }
      const ctx: ToolContext = { ...ctxBase, toolCallId };
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
        content =
          typeof result === "string" ? result : JSON.stringify(result);
      } catch (err) {
        ok = false;
        content = `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
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
        new ToolMessage({
          tool_call_id: toolCallId,
          name: call.name,
          content,
        }),
      );
    }
    return { messages: results };
  };
}
```

- [ ] **Step 2: 跑测试**

Run: `pnpm --filter @meshbot/agent test -- tools.node.spec`
Expected: 5 passed

- [ ] **Step 3: typecheck**

Run: `pnpm --filter @meshbot/agent typecheck`
Expected: 0 errors

- [ ] **Step 4: Commit**

```bash
git add libs/agent/src/graph/nodes/tools.node.ts
git commit -m "feat(agent-graph): 自写 toolsNode（emit start/end + ctx 注入）

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: libs/agent — supervisor.node 接 bindTools

**Files:**
- Modify: `libs/agent/src/graph/nodes/supervisor.node.ts`

- [ ] **Step 1: 改签名 + bindTools**

打开 `apps/server-agent/src/graph/nodes/supervisor.node.ts`（注意：路径应是 `libs/agent/src/graph/nodes/supervisor.node.ts`）。

整体替换为：

```ts
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { AIMessageChunk, BaseMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";

export interface SupervisorState {
  messages: BaseMessage[];
}

/** 惰性提供 chat model 的工厂（每次 run 取最新凭证）。 */
export type ModelProvider = () => Promise<BaseChatModel>;

/** 惰性提供 LangChain bindable tools 数组。 */
export type ToolsProvider = () => StructuredToolInterface[];

/**
 * 创建 supervisor 节点：当前消息历史交给 LLM，流式产出一条 AIMessage。
 *
 * model 经工厂惰性获取；tools 数组每次 run 重新拿（支持后续动态注册）。
 * model.bindTools(tools) 让 LLM 能产 tool_calls。
 * 节点累加所有 chunk 成完整 AIMessage 返回；交由 reducer concat 进 state。
 */
export function createSupervisorNode(
  modelProvider: ModelProvider,
  toolsProvider: ToolsProvider,
) {
  return async function supervisorNode(
    state: SupervisorState,
  ): Promise<Partial<SupervisorState>> {
    const model = await modelProvider();
    if (!model) {
      throw new Error("supervisor 节点未拿到可用 LLM：modelProvider 返回空");
    }
    const tools = toolsProvider();
    const withTools =
      tools.length > 0 && typeof model.bindTools === "function"
        ? model.bindTools(tools)
        : model;
    const stream = await withTools.stream(state.messages);
    let accumulated: AIMessageChunk | undefined;
    for await (const chunk of stream) {
      accumulated =
        accumulated === undefined ? chunk : accumulated.concat(chunk);
    }
    if (accumulated === undefined) {
      throw new Error("supervisor 节点：LLM 流未产出任何内容");
    }
    return { messages: [accumulated] };
  };
}
```

- [ ] **Step 2: typecheck**

Run: `pnpm --filter @meshbot/agent typecheck`
Expected: 失败 —— graph.builder.ts 仍调旧签名 createSupervisorNode(modelProvider)。预期，下个 Task 修。

- [ ] **Step 3: Commit**

```bash
git add libs/agent/src/graph/nodes/supervisor.node.ts
git commit -m "feat(agent-graph): supervisor 节点支持 bindTools（接收 ToolsProvider）

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: libs/agent — graph.builder 加 tools 节点

**Files:**
- Modify: `libs/agent/src/graph/graph.builder.ts`

- [ ] **Step 1: 整体替换文件**

```ts
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { END, START, StateGraph } from "@langchain/langgraph";
import type { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import type { ToolRegistry } from "../tools/tool-registry";
import type { ToolContext } from "../tools/tool.types";
import { createSupervisorNode, type ModelProvider } from "./nodes/supervisor.node";
import { createToolsNode } from "./nodes/tools.node";

export interface GraphState {
  messages: BaseMessage[];
}

/**
 * 构建 supervisor + tools 双节点图，ReAct 循环：
 *
 *   START → supervisor → [tool_calls?] → tools → supervisor → … → END
 *
 * @param modelProvider 每次 run 取最新 LLM
 * @param registry tool 注册表（启动期注册完毕）
 * @param toolsCtxGetter 由 GraphService 提供；返回当下 ctx base（不含 toolCallId，
 *   toolCallId 在 toolsNode 内按 tool_call 现取）
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

- [ ] **Step 2: typecheck**

Run: `pnpm --filter @meshbot/agent typecheck`
Expected: 失败 —— graph.service.ts 仍调旧签名 buildSupervisorGraph(checkpointer, modelProvider)。预期，下个 Task 修。

- [ ] **Step 3: Commit**

```bash
git add libs/agent/src/graph/graph.builder.ts
git commit -m "feat(agent-graph): buildSupervisorGraph 加 tools 节点 + ReAct 循环

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: libs/agent — GraphService 注入 registry/emitter + ctxRef

**Files:**
- Modify: `libs/agent/src/graph/graph.service.ts`

- [ ] **Step 1: 改 import + constructor + ctxRef**

打开 `libs/agent/src/graph/graph.service.ts`。改 import：

```ts
// 已有
import { Injectable, Optional } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
// 新增
import { ToolRegistry } from "../tools/tool-registry";
import type { ToolContext } from "../tools/tool.types";
```

constructor 当前是：

```ts
constructor(
  private configService: MeshbotConfigService,
  private promptService: PromptService,
  @Optional() modelProvider?: ModelProvider,
  @Optional() modelMeta?: { providerType: string; model: string },
) {
  const dbPath = this.configService.getDatabasePath();
  this.checkpointer = createSqliteCheckpointer(dbPath);
  const provider: ModelProvider =
    modelProvider ?? (() => this.resolveModel());
  this.graph = buildSupervisorGraph(this.checkpointer, provider);
  this.modelMeta = modelMeta ?? { providerType: "unknown", model: "unknown" };
}
```

改为：

```ts
private ctxRef: {
  sessionId: string;
  messageId: string;
  signal: AbortSignal;
} | null = null;

constructor(
  private configService: MeshbotConfigService,
  private promptService: PromptService,
  private readonly toolRegistry: ToolRegistry,
  private readonly eventEmitter: EventEmitter2,
  @Optional() modelProvider?: ModelProvider,
  @Optional() modelMeta?: { providerType: string; model: string },
) {
  const dbPath = this.configService.getDatabasePath();
  this.checkpointer = createSqliteCheckpointer(dbPath);
  const provider: ModelProvider =
    modelProvider ?? (() => this.resolveModel());
  this.graph = buildSupervisorGraph(
    this.checkpointer,
    provider,
    this.toolRegistry,
    () => {
      if (!this.ctxRef) {
        throw new Error("toolsNode called without active run (ctxRef is null)");
      }
      return {
        sessionId: this.ctxRef.sessionId,
        messageId: this.ctxRef.messageId,
        emitter: this.eventEmitter,
        signal: this.ctxRef.signal,
      };
    },
  );
  this.modelMeta = modelMeta ?? { providerType: "unknown", model: "unknown" };
}
```

- [ ] **Step 2: streamMessage / resumeStream 入口设置 ctxRef**

找到 `streamMessage` 方法。当前签名：

```ts
async *streamMessage(
  threadId: ThreadId,
  inputs: { id: string; content: string }[],
  signal?: AbortSignal,
): AsyncGenerator<StreamChunk> {
```

在方法**开头**加：

```ts
const abortSignal = signal ?? new AbortController().signal;
this.ctxRef = { sessionId: threadId, messageId: "", signal: abortSignal };
```

并把方法整体用 try/finally 包：

```ts
try {
  // ... 原有 streamMessage 内容
} finally {
  this.ctxRef = null;
}
```

由于是 AsyncGenerator，简单写法：在 generator 顶端 set ctxRef、用 try/finally。

具体：找到 streamMessage 函数体，第一行（reloadIfChanged 之前）插入：

```ts
const abortSignal = signal ?? new AbortController().signal;
this.ctxRef = { sessionId: threadId, messageId: "", signal: abortSignal };
try {
```

在 yield* runGraphStream 之后加 finally 关闭：

```ts
} finally {
  this.ctxRef = null;
}
```

`resumeStream` 同样处理：

```ts
async *resumeStream(
  threadId: ThreadId,
  signal?: AbortSignal,
): AsyncGenerator<StreamChunk> {
  const abortSignal = signal ?? new AbortController().signal;
  this.ctxRef = { sessionId: threadId, messageId: "", signal: abortSignal };
  try {
    yield* this.runGraphStream(threadId, { messages: [] }, signal);
  } finally {
    this.ctxRef = null;
  }
}
```

- [ ] **Step 3: runGraphStream 内：chunk 到达时更新 ctxRef.messageId**

找到 runGraphStream 内的 chunk 循环。每次确定 messageId 时更新：

```ts
const messageId = msg.id ?? randomUUID();
lastMessageId = messageId;
if (this.ctxRef) this.ctxRef.messageId = messageId;  // 新增
yield { kind: "chunk", messageId, delta };
```

- [ ] **Step 4: typecheck**

Run: `pnpm --filter @meshbot/agent typecheck`
Expected: 0 errors

- [ ] **Step 5: Commit**

```bash
git add libs/agent/src/graph/graph.service.ts
git commit -m "feat(agent-graph): GraphService 注入 ToolRegistry + EventEmitter2 + ctxRef

ctxRef 是 mutable（单 run 串行假设；未来并发需 AsyncLocalStorage）。
toolsCtxGetter 闭包从 ctxRef 取当下 sessionId/messageId/signal/emitter。
chunk 到达时同步更新 ctxRef.messageId 供 toolsNode 引用。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: libs/agent — AgentModule 接 DiscoveryModule + 注册 tools

**Files:**
- Modify: `libs/agent/src/agent.module.ts`
- Modify: `libs/agent/src/index.ts`

- [ ] **Step 1: agent.module.ts 整体替换**

```ts
import { Module } from "@nestjs/common";
import { DiscoveryModule } from "@nestjs/core";
import { MeshbotConfigModule } from "./config/meshbot-config.module";
import { MeshbotConfigService } from "./config/meshbot-config.service";
import { GraphService } from "./graph/graph.service";
import { PromptService } from "./prompt/prompt.service";
import { BashTool } from "./tools/builtins/bash.tool";
import { DateTool } from "./tools/builtins/date.tool";
import { ToolRegistry } from "./tools/tool-registry";

@Module({
  imports: [MeshbotConfigModule, DiscoveryModule],
  providers: [
    ToolRegistry,
    BashTool,
    DateTool,
    {
      provide: PromptService,
      useFactory: (configService: MeshbotConfigService) => {
        return new PromptService(configService.getMeshbotDir());
      },
      inject: [MeshbotConfigService],
    },
    GraphService,
  ],
  exports: [GraphService, PromptService, ToolRegistry],
})
export class AgentModule {}
```

- [ ] **Step 2: index.ts 加 re-export**

在文件末尾加：

```ts
export type { MeshbotTool, ToolContext } from "./tools/tool.types";
export { Tool, TOOL_METADATA_KEY } from "./tools/tool.decorator";
```

- [ ] **Step 3: typecheck**

Run: `pnpm --filter @meshbot/agent typecheck`
Expected: 0 errors

- [ ] **Step 4: 顺手跑 lib 所有测试**

Run: `pnpm --filter @meshbot/agent test`
Expected: All passed (tool-registry / date.tool / bash.tool / tools.node specs)

- [ ] **Step 5: Commit**

```bash
git add libs/agent/src/agent.module.ts libs/agent/src/index.ts
git commit -m "feat(agent-module): AgentModule imports DiscoveryModule + 注册 BashTool/DateTool

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 14: server-agent — SessionGateway 转发三个 tool 事件

**Files:**
- Modify: `apps/server-agent/src/ws/session.gateway.ts`

- [ ] **Step 1: import 加 RunToolCall* types**

找到 types-agent 的 import 块，加：

```ts
import {
  // ... 已有
  type RunToolCallEndEvent,
  type RunToolCallProgressEvent,
  type RunToolCallStartEvent,
} from "@meshbot/types-agent";
```

- [ ] **Step 2: 加三个 @OnEvent handler**

在 onRunUsage 之后（或参照类的现有 OnEvent 顺序）加：

```ts
/** RunnerService → run.tool_call_start → 转发到房间。 */
@OnEvent(SESSION_WS_EVENTS.runToolCallStart)
onRunToolCallStart(payload: RunToolCallStartEvent): void {
  this.server
    .to(payload.sessionId)
    .emit(SESSION_WS_EVENTS.runToolCallStart, payload);
}

/** RunnerService → run.tool_call_progress → 转发到房间。 */
@OnEvent(SESSION_WS_EVENTS.runToolCallProgress)
onRunToolCallProgress(payload: RunToolCallProgressEvent): void {
  this.server
    .to(payload.sessionId)
    .emit(SESSION_WS_EVENTS.runToolCallProgress, payload);
}

/**
 * RunnerService → run.tool_call_end → 转发到房间。
 * **剥掉 `content` 字段**（可能很大）：前端只用 `resultPreview`；
 * content 留在 NestJS event bus 供 runner 落库消费（不上 socket）。
 */
@OnEvent(SESSION_WS_EVENTS.runToolCallEnd)
onRunToolCallEnd(payload: RunToolCallEndEvent): void {
  const { content: _content, ...wireOut } = payload;
  this.server
    .to(payload.sessionId)
    .emit(SESSION_WS_EVENTS.runToolCallEnd, wireOut);
}
```

- [ ] **Step 3: typecheck**

Run: `pnpm --filter @meshbot/server-agent typecheck`
Expected: 0 errors

- [ ] **Step 4: Commit**

```bash
git add apps/server-agent/src/ws/session.gateway.ts
git commit -m "feat(session-gateway): 转发 run.tool_call_start/progress/end（end 剥 content）

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 15: server-agent — SessionMessageService 写 tool result + assistant.toolCalls

**Files:**
- Modify: `apps/server-agent/src/services/session-message.service.ts`
- Modify: `apps/server-agent/src/services/session-message.service.spec.ts`

- [ ] **Step 1: spec 加测试**

在文件末尾、最后一个 `it()` 之后、闭合 describe 之前，加：

```ts
  it("recordToolResult 写入 role=tool 行，id = toolCallId", async () => {
    await service.recordToolResult({
      id: "tc1",
      sessionId: "s1",
      toolCallId: "tc1",
      content: "result text",
    });
    const row = await ds.getRepository(SessionMessage).findOneBy({ id: "tc1" });
    expect(row).toMatchObject({
      id: "tc1",
      sessionId: "s1",
      role: "tool",
      content: "result text",
      toolCallId: "tc1",
    });
  });

  it("recordToolResult 重复 id 幂等", async () => {
    await service.recordToolResult({
      id: "tc1",
      sessionId: "s1",
      toolCallId: "tc1",
      content: "first",
    });
    await service.recordToolResult({
      id: "tc1",
      sessionId: "s1",
      toolCallId: "tc1",
      content: "second",
    });
    const row = await ds.getRepository(SessionMessage).findOneBy({ id: "tc1" });
    expect(row?.content).toBe("first");
  });

  it("recordAssistant 可附带 toolCalls JSON 字符串", async () => {
    const calls = [{ id: "tc1", name: "echo", args: { text: "hi" } }];
    await service.recordAssistant({
      id: "a1",
      sessionId: "s1",
      content: "calling echo",
      reasoning: null,
      toolCalls: JSON.stringify(calls),
    });
    const row = await ds.getRepository(SessionMessage).findOneBy({ id: "a1" });
    expect(row?.toolCalls).toBe(JSON.stringify(calls));
  });
```

- [ ] **Step 2: 跑测试，确认 fail**

Run: `pnpm exec jest apps/server-agent/src/services/session-message.service.spec.ts 2>&1 | tail -10`
Expected: 3 个新测试 FAIL

- [ ] **Step 3: 改 service 实现**

打开 `apps/server-agent/src/services/session-message.service.ts`。

修改 `RecordAssistantInput` 加可选 toolCalls：

```ts
export interface RecordAssistantInput {
  id: string;
  sessionId: string;
  content: string;
  reasoning: string | null;
  /** 序列化好的 tool_calls JSON 字符串（assistant 调工具时）。 */
  toolCalls?: string | null;
}
```

修改 recordAssistant 实现里 insert 加上 toolCalls：

```ts
async recordAssistant(input: RecordAssistantInput): Promise<void> {
  const exists = await this.repo.findOneBy({ id: input.id });
  if (exists) return;
  await this.repo.insert({
    id: input.id,
    sessionId: input.sessionId,
    role: "assistant",
    content: input.content,
    reasoning: input.reasoning,
    toolCalls: input.toolCalls ?? null,
    toolCallId: null,
  });
}
```

加新方法 recordToolResult：

```ts
/** 写 tool 结果入参。id = toolCallId 保证幂等 + 与 LangChain ToolMessage 一致。 */
export interface RecordToolResultInput {
  id: string;
  sessionId: string;
  toolCallId: string;
  content: string;
}

/**
 * 记录一条 role=tool 消息（tool 调用结果）。幂等（id = toolCallId）。
 */
async recordToolResult(input: RecordToolResultInput): Promise<void> {
  const exists = await this.repo.findOneBy({ id: input.id });
  if (exists) return;
  await this.repo.insert({
    id: input.id,
    sessionId: input.sessionId,
    role: "tool",
    content: input.content,
    reasoning: null,
    toolCalls: null,
    toolCallId: input.toolCallId,
  });
}
```

- [ ] **Step 4: 跑测试，全过**

Run: `pnpm exec jest apps/server-agent/src/services/session-message.service.spec.ts 2>&1 | tail -10`
Expected: All passed

- [ ] **Step 5: typecheck**

Run: `pnpm --filter @meshbot/server-agent typecheck`
Expected: 0 errors

- [ ] **Step 6: Commit**

```bash
git add apps/server-agent/src/services/session-message.service.ts apps/server-agent/src/services/session-message.service.spec.ts
git commit -m "feat(session-message): recordToolResult + recordAssistant 接 toolCalls JSON

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 16: server-agent — RunnerService 写 tool result + assistant 带 toolCalls

**Files:**
- Modify: `apps/server-agent/src/services/runner.service.ts`

- [ ] **Step 1: import**

加 types：

```ts
import {
  // ... 已有
  type RunToolCallEndEvent,
  SESSION_WS_EVENTS,
} from "@meshbot/types-agent";
import { OnEvent } from "@nestjs/event-emitter";
```

`OnEvent` 应该已 import；确认即可。

- [ ] **Step 2: 加 @OnEvent(runToolCallEnd) handler**

在 RunnerService class 内、其它 public 方法附近加：

```ts
/**
 * 监听 toolsNode emit 的 run.tool_call_end —— 把 tool result 写入
 * session_messages（role=tool）。fire-and-forget，写失败仅 log。
 *
 * gateway 转发给前端时已剥掉 content；runner 直接拿原始 event 含 content 落库。
 */
@OnEvent(SESSION_WS_EVENTS.runToolCallEnd)
async onToolCallEnd(payload: RunToolCallEndEvent): Promise<void> {
  try {
    await this.sessionMessages.recordToolResult({
      id: payload.toolCallId,
      sessionId: payload.sessionId,
      toolCallId: payload.toolCallId,
      content: payload.content,
    });
  } catch (err) {
    this.logger.error(
      `session_messages.recordToolResult 失败 toolCallId=${payload.toolCallId}`,
      err,
    );
  }
}
```

- [ ] **Step 3: runOnce success path 写 assistant 时附带 toolCalls**

找到 runOnce 内 `success path` 的 recordAssistant 调用。当前应是：

```ts
this.sessionMessages
  .recordAssistant({
    id: run.messageId,
    sessionId,
    content: run.content,
    reasoning,
  })
  .catch(...)
```

需要把 accumulated AIMessageChunk 的 tool_calls 也带进来。但当前 runner 拿不到 accumulated —— 那个在 graph.service.ts 内部。

**改造点**：让 graph 在 stream 末尾把 toolCalls JSON 也通过事件返出。最干净办法：StreamChunk 加 `kind: "tool_calls"` 一次性事件；或在 graph.service.ts 收到 accumulated 时直接调 sessionMessages。但 graph 层不该知道 server-agent service。

**走事件**：在 yield usage 之前加一个 `kind: "tool_calls"`，runner 收到时缓存到 `run.toolCalls`，runDone 写 assistant 时一并传：

```ts
// libs/agent/src/graph/graph.service.ts
// 找到 runGraphStream，在 yield usage 之前：
if (accumulated?.tool_calls?.length) {
  yield {
    kind: "tool_calls",
    messageId: lastMessageId!,
    toolCalls: accumulated.tool_calls,
  };
}
```

`StreamChunk` union 加新成员：

```ts
| { kind: "tool_calls"; messageId: string; toolCalls: unknown[] }
```

runner.runOnce 处理：

```ts
if (event.kind === "tool_calls") {
  run.toolCalls = JSON.stringify(event.toolCalls);
  continue;
}
```

InflightRun 加字段：

```ts
interface InflightRun {
  // ... 已有
  toolCalls: string | null;
  // ...
}
```

初始化：`toolCalls: null`

recordAssistant 调用改：

```ts
this.sessionMessages
  .recordAssistant({
    id: run.messageId,
    sessionId,
    content: run.content,
    reasoning,
    toolCalls: run.toolCalls,
  })
```

- [ ] **Step 4: typecheck**

Run: `pnpm --filter @meshbot/server-agent typecheck && pnpm --filter @meshbot/agent typecheck`
Expected: 0 errors

- [ ] **Step 5: 跑 runner spec**

Run: `pnpm exec jest apps/server-agent/src/services/runner.service.spec.ts 2>&1 | tail -10`
Expected: All passed（如果 fake stream 没产 tool_calls event，行为不变）

- [ ] **Step 6: Commit**

```bash
git add apps/server-agent/src/services/runner.service.ts libs/agent/src/graph/graph.service.ts
git commit -m "feat(runner): @OnEvent(runToolCallEnd) 写 tool result + assistant 带 toolCalls

graph.service yield 新 StreamChunk kind=tool_calls；runner 缓存到 run.toolCalls
后在 recordAssistant 时一并写入 session_messages。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 17: server-agent — SessionController.history 二次组装

**Files:**
- Modify: `apps/server-agent/src/controllers/session.controller.ts`
- Modify: `apps/server-agent/src/services/session-message.service.ts` — listPage 按 assistant 边界 round up

- [ ] **Step 1: SessionMessageService.listPage 按 assistant 边界 round up**

修改 listPage：拿到 rows 后，如果末尾（最新 / arr[rows.length-1]）是 role=assistant 且后面（更新）还有它的 tool result，需要把那些 tool result 一并带回。

但 cursor 翻页是按 createdAt < anchor，已经天然把 anchor 之前所有行（含 tool）带回。**真正的问题**是相反方向：limit 切片时可能切在 assistant 中间——assistant 取了，但它后续的 tool result 没取（被丢到下一页更新方向）。

修订实现：

```ts
async listPage(
  sessionId: string,
  opts: { before?: string; limit: number },
): Promise<SessionMessagePage> {
  let anchorDate: Date | undefined;
  if (opts.before) {
    const anchor = await this.repo.findOneBy({ id: opts.before });
    if (!anchor || anchor.sessionId !== sessionId) {
      throw new NotFoundException(
        `SessionMessage ${opts.before} not found in session ${sessionId}`,
      );
    }
    anchorDate = anchor.createdAt;
  }
  // 多拿一条以判 hasMore
  const rows = await this.repo.find({
    where: {
      sessionId,
      ...(anchorDate ? { createdAt: LessThan(anchorDate) } : {}),
    },
    order: { createdAt: "DESC" },
    take: opts.limit + 1,
  });
  const hasMore = rows.length > opts.limit;
  let slice = hasMore ? rows.slice(0, opts.limit) : rows;
  // reverse 回 asc（前端按时间顺序展示）
  slice.reverse();
  // Round up：把 slice 末尾紧跟着的 role=tool 行（如果存在）一并捞回，
  // 避免 assistant 与其 tool result 被切到不同页。
  if (slice.length > 0) {
    const lastInSlice = slice[slice.length - 1];
    // 找紧跟 lastInSlice 之后的 tool 行（createdAt > lastInSlice.createdAt）
    const trailingTools = await this.repo.find({
      where: {
        sessionId,
        createdAt: MoreThan(lastInSlice.createdAt),
        role: "tool" as never,
        ...(anchorDate ? { createdAt: LessThan(anchorDate) } : {}),
      },
      order: { createdAt: "ASC" },
    });
    // 防止 createdAt overlap 时 LessThan/MoreThan 复合不对，需要二次过滤
    const filtered = trailingTools.filter((t) => {
      if (anchorDate && t.createdAt >= anchorDate) return false;
      return t.createdAt > lastInSlice.createdAt;
    });
    slice = [...slice, ...filtered];
  }
  return { messages: slice, hasMore };
}
```

注：TypeORM 不能直接在同字段写两个条件。需用 `Between` 或 query builder。简化：

```ts
import { Between, LessThan, MoreThan } from "typeorm";

// ...
const trailingTools = await this.repo
  .createQueryBuilder("m")
  .where("m.sessionId = :sessionId", { sessionId })
  .andWhere("m.created_at > :cutoff", { cutoff: lastInSlice.createdAt })
  .andWhere(anchorDate ? "m.created_at < :anchor" : "1=1", {
    anchor: anchorDate,
  })
  .andWhere("m.role = :role", { role: "tool" })
  .orderBy("m.created_at", "ASC")
  .getMany();
slice = [...slice, ...trailingTools];
```

- [ ] **Step 2: SessionController.history 二次组装 toolCalls**

打开 controller 的 history 方法。当前 messages map 是：

```ts
return {
  messages: page.messages.map((m) => ({
    id: m.id,
    role: m.role as "user" | "assistant" | "system",
    content: m.content,
    ...(m.reasoning ? { reasoning: m.reasoning } : {}),
  })),
  // ...
};
```

改成先拆 tool 行、再 map assistant 时注入 toolCalls：

```ts
import type { HistoryToolCall } from "@meshbot/types-agent";

// ...

const rows = page.messages;
const toolByCallId = new Map<string, (typeof rows)[number]>();
for (const r of rows) {
  if (r.role === "tool" && r.toolCallId) {
    toolByCallId.set(r.toolCallId, r);
  }
}

const messages = rows
  .filter((r) => r.role !== "tool")
  .map((r) => {
    const base = {
      id: r.id,
      role: r.role as "user" | "assistant" | "system",
      content: r.content,
      ...(r.reasoning ? { reasoning: r.reasoning } : {}),
    };
    if (r.role !== "assistant" || !r.toolCalls) return base;
    try {
      const calls = JSON.parse(r.toolCalls) as Array<{
        id: string;
        name: string;
        args: unknown;
      }>;
      const toolCalls: HistoryToolCall[] = calls.map((c) => {
        const tr = toolByCallId.get(c.id);
        return {
          toolCallId: c.id,
          name: c.name,
          args: c.args,
          status: "ok" as const,  // 历史一定已完成；ok/error 区分本次先不持久化
          result: tr?.content ?? "",
        };
      });
      return { ...base, toolCalls };
    } catch {
      return base;
    }
  });

return {
  messages,
  // ... 其它字段不变
};
```

注意 byMessage 也只该按非-tool messages 算（tool 行没有 LLM usage 对应）。看现有代码：listByMessageIds 用 `page.messages.map((m) => m.id)`。tool 行的 id = toolCallId，llm_calls 表里没有这个 id，listByMessageIds 自然返空，不会污染 byMessage。**不用改**。

- [ ] **Step 3: typecheck**

Run: `pnpm --filter @meshbot/server-agent typecheck`
Expected: 0 errors

- [ ] **Step 4: Commit**

```bash
git add apps/server-agent/src/controllers/session.controller.ts apps/server-agent/src/services/session-message.service.ts
git commit -m "feat(session): history 二次组装 toolCalls + listPage 按 assistant 边界 round up

role=tool 行不进 messages 数组，按 tool_call_id 挂到上游 assistant.toolCalls。
listPage 在切片末尾拽上紧跟的 tool 行避免拼不全。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 18: web-agent — TimelineMessage.toolCalls + ToolCallBlock 组件

**Files:**
- Modify: `apps/web-agent/src/components/session/message-list.tsx` — TimelineMessage 加 toolCalls
- Create: `apps/web-agent/src/components/session/tool-call-block.tsx`

- [ ] **Step 1: TimelineMessage 扩展**

在 message-list.tsx 顶部、`interface TimelineMessage` 定义加：

```ts
export interface ToolCallView {
  toolCallId: string;
  name: string;
  args: unknown;
  /** 流式累积的 stdout/stderr（仅 bash 等流式 tool）。 */
  progress?: string;
  /** 最终结果（end 后；历史读取也填这里）。 */
  result?: string;
  status: "running" | "ok" | "error";
}

export interface TimelineMessage {
  // ... 已有字段
  toolCalls?: ToolCallView[];
}
```

- [ ] **Step 2: 新建 ToolCallBlock 组件**

```tsx
"use client";

import { cn } from "@meshbot/design";
import { ChevronRight, Loader2, Wrench } from "lucide-react";
import { useState } from "react";
import type { ToolCallView } from "./message-list";

/**
 * 单次 tool 调用的折叠展示块。
 *
 * 标签：「🔧 bash · running」/「🔧 bash ✓」/「🔧 bash ✗」
 * 展开：args（JSON）+ progress（实时累积，pre 元素）+ result（最终）
 * 风格仿 ReasoningBlock：左侧细竖线 + 等宽小字 + 无背景。
 */
export function ToolCallBlock({ tool }: { tool: ToolCallView }) {
  const [open, setOpen] = useState(false);
  const statusBadge =
    tool.status === "running" ? (
      <Loader2 className="h-3 w-3 animate-spin" />
    ) : tool.status === "ok" ? (
      <span className="text-foreground/60">✓</span>
    ) : (
      <span className="text-destructive">✗</span>
    );
  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 self-start text-xs text-muted-foreground/80 hover:text-muted-foreground"
        aria-expanded={open}
      >
        <ChevronRight
          className={cn(
            "h-3 w-3 transition-transform",
            open && "rotate-90",
          )}
        />
        <Wrench className="h-3 w-3" />
        <span>{tool.name}</span>
        {statusBadge}
      </button>
      {open && (
        <div className="flex flex-col gap-1 border-l-2 border-border/60 pl-3 text-[12px] text-muted-foreground/80">
          <div>
            <span className="text-muted-foreground/60">args:</span>{" "}
            <code className="font-mono text-[11px]">
              {JSON.stringify(tool.args)}
            </code>
          </div>
          {tool.progress && (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed">
              {tool.progress}
            </pre>
          )}
          {tool.result && tool.status !== "running" && !tool.progress && (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed">
              {tool.result}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: MessageList 渲染 ToolCallBlock**

在 message-list.tsx 内找到 assistant 消息渲染。当前结构：

```tsx
{m.role === "assistant" && m.reasoning ? (
  <ReasoningBlock ... />
) : null}
{(m.role === "user" || m.content || ...) && (
  <div className="rounded-lg ...">
    {/* content / usage */}
  </div>
)}
```

在 ReasoningBlock 之后、bubble div 之前插入 toolCalls 渲染：

```tsx
{m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0 && (
  <div className="flex flex-col gap-1.5">
    {m.toolCalls.map((tc) => (
      <ToolCallBlock key={tc.toolCallId} tool={tc} />
    ))}
  </div>
)}
```

并在文件顶部 import：

```ts
import { ToolCallBlock } from "./tool-call-block";
```

bubble 渲染条件需放宽 —— 仅 toolCalls 也算"该消息有内容"：

```tsx
{(m.role === "user" ||
  m.content ||
  m.loading ||
  m.streaming ||
  m.failed ||
  (m.toolCalls && m.toolCalls.length > 0) ||
  usageByMessage?.[m.id]) && (
```

- [ ] **Step 4: typecheck**

Run: `pnpm --filter @meshbot/web-agent typecheck`
Expected: 0 errors

- [ ] **Step 5: Commit**

```bash
git add apps/web-agent/src/components/session/message-list.tsx apps/web-agent/src/components/session/tool-call-block.tsx
git commit -m "feat(web-agent): ToolCallBlock 折叠组件 + TimelineMessage.toolCalls 扩展

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 19: web-agent — session page handlers + history 读取

**Files:**
- Modify: `apps/web-agent/src/app/session/page.tsx`

- [ ] **Step 1: import 加三个 event types**

找到 types-agent 的 import 块。加：

```ts
import {
  // ... 已有
  type RunToolCallEndEvent,
  type RunToolCallProgressEvent,
  type RunToolCallStartEvent,
  SESSION_WS_EVENTS,
} from "@meshbot/types-agent";
```

- [ ] **Step 2: 加三个 socket handler**

在 socket useEffect 内、已有 handler 列表中加：

```ts
const onToolStart = (e: RunToolCallStartEvent) => {
  if (e.sessionId !== sessionId) return;
  apply((prev) =>
    prev.map((m) =>
      m.id === e.messageId
        ? {
            ...m,
            toolCalls: [
              ...(m.toolCalls ?? []),
              {
                toolCallId: e.toolCallId,
                name: e.name,
                args: e.args,
                status: "running" as const,
              },
            ],
          }
        : m,
    ),
  );
};
const onToolProgress = (e: RunToolCallProgressEvent) => {
  if (e.sessionId !== sessionId) return;
  apply((prev) =>
    prev.map((m) =>
      m.toolCalls?.some((t) => t.toolCallId === e.toolCallId)
        ? {
            ...m,
            toolCalls: m.toolCalls.map((t) =>
              t.toolCallId === e.toolCallId
                ? { ...t, progress: (t.progress ?? "") + e.delta }
                : t,
            ),
          }
        : m,
    ),
  );
};
const onToolEnd = (
  e: Omit<RunToolCallEndEvent, "content">,  // gateway 已剥
) => {
  if (e.sessionId !== sessionId) return;
  apply((prev) =>
    prev.map((m) =>
      m.toolCalls?.some((t) => t.toolCallId === e.toolCallId)
        ? {
            ...m,
            toolCalls: m.toolCalls.map((t) =>
              t.toolCallId === e.toolCallId
                ? {
                    ...t,
                    status: e.ok ? ("ok" as const) : ("error" as const),
                    result: e.resultPreview,
                  }
                : t,
            ),
          }
        : m,
    ),
  );
};
```

- [ ] **Step 3: socket.on / socket.off 注册**

在 socket.on(SESSION_WS_EVENTS.runUsage, onUsage) 之后加：

```ts
socket.on(SESSION_WS_EVENTS.runToolCallStart, onToolStart);
socket.on(SESSION_WS_EVENTS.runToolCallProgress, onToolProgress);
socket.on(SESSION_WS_EVENTS.runToolCallEnd, onToolEnd);
```

return cleanup 加对应 .off：

```ts
socket.off(SESSION_WS_EVENTS.runToolCallStart, onToolStart);
socket.off(SESSION_WS_EVENTS.runToolCallProgress, onToolProgress);
socket.off(SESSION_WS_EVENTS.runToolCallEnd, onToolEnd);
```

- [ ] **Step 4: 历史读取 — history.messages 含 toolCalls 时构造 ToolCallView**

找到 `void Promise.all([fetchHistory(...), fetchPending(...)]).then(...)` 内 `initial: TimelineMessage[] = history.messages.map(...)`：

```ts
const initial: TimelineMessage[] = history.messages.map((m) => ({
  id: m.id,
  role: m.role,
  content: m.content,
  ...(m.reasoning
    ? { reasoning: m.reasoning, reasoningDurationMs: 0 }
    : {}),
}));
```

加上 toolCalls 转 ToolCallView：

```ts
const initial: TimelineMessage[] = history.messages.map((m) => ({
  id: m.id,
  role: m.role,
  content: m.content,
  ...(m.reasoning
    ? { reasoning: m.reasoning, reasoningDurationMs: 0 }
    : {}),
  ...(m.toolCalls && m.toolCalls.length > 0
    ? {
        toolCalls: m.toolCalls.map((tc) => ({
          toolCallId: tc.toolCallId,
          name: tc.name,
          args: tc.args,
          status: tc.status,
          result: tc.result,
          // progress 留空（流式过程没存）
        })),
      }
    : {}),
}));
```

- [ ] **Step 5: typecheck**

Run: `pnpm --filter @meshbot/web-agent typecheck`
Expected: 0 errors

- [ ] **Step 6: Commit**

```bash
git add apps/web-agent/src/app/session/page.tsx
git commit -m "feat(session-page): tool 事件 handlers + 历史 toolCalls 渲染

onToolStart/Progress/End 维护 message.toolCalls；history 加载时把
HistoryToolCall 转成 ToolCallView 注入。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 20: 加 session_messages role=tool 的 migration（如果还需）

session_messages 表已有 role 字段（TEXT，无约束），可直接写 "tool" 不需迁移。但需要检查现有 entity union type：

- [ ] **Step 1: 确认 SessionMessage.role 类型 union 含 "tool"**

```bash
grep "role!" apps/server-agent/src/entities/session-message.entity.ts
```

应该已是 `"user" | "assistant" | "system" | "tool"`（Task 1 spec 提到本次仅 user/assistant 写入，tool 预留）。如果不含 tool 就加。

- [ ] **Step 2: 如有需要修改 entity**

如果不含 tool：

```ts
@Column({ type: "varchar" })
role!: "user" | "assistant" | "system" | "tool";
```

- [ ] **Step 3: 不需新 migration**

DB 列已是 TEXT，无 enum 约束，写 "tool" 直接 work。

- [ ] **Step 4: Commit（如有改动）**

如果改了 entity：

```bash
git add apps/server-agent/src/entities/session-message.entity.ts
git commit -m "chore(entity): SessionMessage.role union 含 tool

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

否则跳过本 task commit。

---

## Task 21: 最终验证 + 手测交接

- [ ] **Step 1: 全包 typecheck**

```bash
pnpm turbo run typecheck --filter=@meshbot/web-agent --filter=@meshbot/server-agent --filter=@meshbot/types-agent --filter=@meshbot/agent
```
Expected: 全部 PASS

- [ ] **Step 2: 全包 test**

```bash
pnpm --filter @meshbot/agent test
pnpm exec jest apps/server-agent/src/services
```
Expected: 全部 PASS

- [ ] **Step 3: 起 dev server 手测**

Run（两终端）：
```bash
pnpm dev:server-agent
pnpm dev:web-agent
```

- [ ] **Step 4: 手测场景 A — date tool**

1. 新会话发 "what time is it?"
2. 期望：LLM 调 `date(timezone="???")` 返 invalid → LLM 重问"请告诉我你的时区"
3. 回复 "Asia/Shanghai" → LLM 调 date 返当前时间
4. 前端：assistant 气泡上方出现 ToolCallBlock "🔧 date ✓"，展开看到 args + result

- [ ] **Step 5: 手测场景 B — bash tool**

1. 新会话发 "list files in current directory"
2. 期望：LLM 调 `bash(command="ls")`，前端实时流式 stdout 出现在 ToolCallBlock progress 区
3. assistant 用 LLM 自己分析结果回复
4. 验证 cwd：bash 输出的路径应是 `~/.meshbot/workspace`（prod）或 repo root（dev，可能是 `/Users/grant/Meta1/meshbot`）

- [ ] **Step 6: 手测场景 C — 持久化**

1. 同一会话刷新页面
2. 期望：之前的 tool calls 仍在 assistant 气泡上方显示（status=ok，progress 空但 result 有）
3. SQLite 查 session_messages：
   ```bash
   sqlite3 ~/.meshbot/agent.db "select role, content, tool_calls, tool_call_id from session_messages order by created_at limit 20"
   ```
   应看到 user / assistant（含 tool_calls JSON）/ tool 三种 role 的行

- [ ] **Step 7: 手测场景 D — 超时**

1. LLM 调 `bash(command="sleep 200")`
2. 期望：120s 后 SIGKILL，前端 ToolCallBlock 变 ✗ status；result 含 `[exit signal:SIGKILL]`

- [ ] **Step 8: 手测场景 E — 用户 Stop 中断 tool**

1. LLM 调 `bash(command="sleep 60")`
2. 期间用户点 Stop 按钮
3. 期望：bash 进程被 abort signal 杀掉，run 走 interrupted 路径

如有 bug 修复 + 单独 commit。

---

## Self-Review 笔记

**Spec 覆盖**：
- ✅ Tool 抽象（Task 2）+ ToolRegistry（Task 3/4）
- ✅ Graph 接入：supervisor bindTools（Task 10）+ tools 节点（Task 8/9）+ builder 重构（Task 11）+ GraphService ctxRef（Task 12）
- ✅ AgentModule + DiscoveryModule + 注册 tools（Task 13）
- ✅ WS 事件 schema（Task 1）+ gateway 转发（Task 14）
- ✅ session_messages 写入（Task 15/16）+ history 二次组装（Task 17）
- ✅ bash tool（Task 7）含 cwd / 超时 / 截断 / 中断
- ✅ date tool（Task 5）含格式 / 时区验证
- ✅ 前端 ToolCallBlock（Task 18）+ session page handlers + history 读取（Task 19）
- ✅ Entity role union（Task 20）
- ✅ 手测（Task 21）

**类型一致性**：
- `MeshbotTool / ToolContext / @Tool()` 全程命名一致
- `ToolRegistry.get(name) / asLangChainBindable() / list()` 在 Task 4/8/11 用法一致
- `StreamChunk.kind: "tool_calls"` Task 16 加，graph.service yield 也用同名
- `RunToolCallEndEvent.content` 在 Task 1 schema 定义、Task 9 emit、Task 14 剥离、Task 16 落库消费，4 处一致
- `HistoryToolCall` Task 1 schema、Task 17 controller 产、Task 19 前端读，3 处一致
- `ToolCallView` Task 18 定义，Task 19 用，一致

**Placeholder 扫描**：无 TBD / 「类似 Task X」 / 不带代码的步骤。Task 17 的 listPage 边界处理 spec 已给出 query builder 写法。

**已知降级**：
- 单 run 串行假设（ctxRef mutable）：spec 已声明
- bash cwd 仅默认起点不真隔离：spec 已声明
- date 不引 interrupt：spec 已声明
- 历史不区分 ok/error（status 一律 ok）：本次未持久化 ok 状态，是已知简化（要做需 entity 加 status 列）

**遗漏检查**：
- session_messages.tool_calls 字段已在前面 spec 中预留 → 直接用，无需 migration（Task 20 已确认）
- BashTool 在 spec 中标了 `@Injectable()` + `@Tool()` 但 `@Tool()` 已 applyDecorators(@Injectable())，**单写 @Tool() 即可**。Task 7 代码已正确（只用 @Tool() + Injectable 是冗余但无害；可保留双装饰器以便不同 nest 版本兼容）
