import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { z } from "zod";
import { AccountContextService } from "../../account/account-context.service";
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

@Tool()
class HugeTool implements MeshbotTool<Record<string, never>, string> {
  readonly name = "huge";
  readonly description = "Returns a giant result (模拟截图 base64)";
  readonly schema = z.object({});
  async execute(): Promise<string> {
    // 50KB，超过 toolsNode 的 32KB LLM 上限
    return `OK_PREFIX ${"A".repeat(50_000)}`;
  }
}

/**
 * 捕获 execute 时收到的 ctx —— 用来断言并发 / messageId 路径都按本次调用计算，
 * 而不是从某个共享单例读出来。
 */
@Tool()
class CtxCaptureTool implements MeshbotTool<Record<string, never>, string> {
  readonly name = "capture";
  readonly description = "Capture incoming ctx";
  readonly schema = z.object({});
  // biome-ignore lint/style/noNonNullAssertion: 测试桩，外部读取
  public lastCtx: ToolContext = undefined!;
  async execute(
    _args: Record<string, never>,
    ctx: ToolContext,
  ): Promise<string> {
    this.lastCtx = ctx;
    return "captured";
  }
}

function makeRegistry(tools: MeshbotTool[]): ToolRegistry {
  const fakeDisc = {
    getProviders: () => tools.map((t) => ({ instance: t })) as never,
  };
  const r = new ToolRegistry(fakeDisc as never, new AccountContextService());
  r.onModuleInit();
  return r;
}

/** 测试用最小 RunnableConfig（thread_id + 可选 signal）。 */
function cfg(threadId: string, signal?: AbortSignal): LangGraphRunnableConfig {
  return { configurable: { thread_id: threadId }, signal };
}

describe("createToolsNode", () => {
  it("last 不是 AIMessage 或 tool_calls 为空 → 返空对象", async () => {
    const node = createToolsNode(
      makeRegistry([new EchoTool()]),
      new EventEmitter2(),
    );
    const r1 = await node({ messages: [new HumanMessage("hi")] }, cfg("s1"));
    expect(r1).toEqual({});
    const r2 = await node(
      { messages: [new AIMessage({ content: "no tool calls" })] },
      cfg("s1"),
    );
    expect(r2).toEqual({});
  });

  it("调对应 tool 返 ToolMessage", async () => {
    const node = createToolsNode(
      makeRegistry([new EchoTool()]),
      new EventEmitter2(),
    );
    const ai = new AIMessage({
      content: "",
      tool_calls: [{ id: "tc1", name: "echo", args: { text: "hi" } }],
    });
    const r = await node({ messages: [ai] }, cfg("s1"));
    expect(r.messages).toHaveLength(1);
    const tm = r.messages![0] as ToolMessage;
    expect(tm).toBeInstanceOf(ToolMessage);
    expect(tm.tool_call_id).toBe("tc1");
    expect(tm.content).toBe("echoed: hi");
  });

  it("未知 tool 返 error ToolMessage", async () => {
    const node = createToolsNode(
      makeRegistry([new EchoTool()]),
      new EventEmitter2(),
    );
    const ai = new AIMessage({
      content: "",
      tool_calls: [{ id: "tc2", name: "nonexistent", args: {} }],
    });
    const r = await node({ messages: [ai] }, cfg("s1"));
    const tm = r.messages![0] as ToolMessage;
    expect(String(tm.content)).toMatch(/Error: unknown tool nonexistent/);
  });

  it("tool 抛错 → 返 Error ToolMessage 且 ok=false", async () => {
    const emitter = new EventEmitter2();
    const events: Array<{ event: string; payload: unknown }> = [];
    emitter.onAny((event, payload) =>
      events.push({ event: String(event), payload }),
    );
    const node = createToolsNode(makeRegistry([new FailingTool()]), emitter);
    const ai = new AIMessage({
      content: "",
      tool_calls: [{ id: "tc3", name: "boom", args: { x: 1 } }],
    });
    const r = await node({ messages: [ai] }, cfg("s1"));
    const tm = r.messages![0] as ToolMessage;
    expect(String(tm.content)).toMatch(/Error: boom!/);
    const end = events.find((e) => e.event === "run.tool_call_end");
    expect(end).toBeDefined();
    expect((end!.payload as { ok: boolean }).ok).toBe(false);
  });

  it("超大 tool 结果：给 LLM 的 ToolMessage 被截断，事件 content 仍是完整原文", async () => {
    const emitter = new EventEmitter2();
    const events: Array<{ event: string; payload: unknown }> = [];
    emitter.onAny((event, payload) =>
      events.push({ event: String(event), payload }),
    );
    const node = createToolsNode(makeRegistry([new HugeTool()]), emitter);
    const r = await node(
      {
        messages: [
          new AIMessage({
            content: "",
            tool_calls: [{ id: "tc5", name: "huge", args: {} }],
          }),
        ],
      },
      cfg("s1"),
    );
    const tm = r.messages![0] as ToolMessage;
    const llmContent = String(tm.content);
    // 给 LLM 的那份被截断（远小于 50KB），且保留了开头 + 截断提示
    expect(llmContent.length).toBeLessThan(5_000);
    expect(llmContent).toMatch(/^OK_PREFIX/);
    expect(llmContent).toMatch(/已截断/);
    // 但 run.tool_call_end 事件里的 content 是完整原文（落 session_messages 用）
    const end = events.find((e) => e.event === "run.tool_call_end");
    const fullContent = (end!.payload as { content: string }).content;
    expect(fullContent.length).toBeGreaterThan(50_000);
  });

  it("emit run.tool_call_start 和 run.tool_call_end", async () => {
    const emitter = new EventEmitter2();
    const events: string[] = [];
    emitter.onAny((event) => events.push(String(event)));
    const node = createToolsNode(makeRegistry([new EchoTool()]), emitter);
    await node(
      {
        messages: [
          new AIMessage({
            content: "",
            tool_calls: [{ id: "tc4", name: "echo", args: { text: "x" } }],
          }),
        ],
      },
      cfg("s1"),
    );
    expect(events).toContain("run.tool_call_start");
    expect(events).toContain("run.tool_call_end");
  });

  it("缺 config.configurable.thread_id 时直接抛错（防 ctx 错挂）", async () => {
    const node = createToolsNode(
      makeRegistry([new EchoTool()]),
      new EventEmitter2(),
    );
    const ai = new AIMessage({
      content: "",
      tool_calls: [{ id: "tc-x", name: "echo", args: { text: "x" } }],
    });
    await expect(
      node({ messages: [ai] }, { configurable: {} }),
    ).rejects.toThrow(/thread_id/);
  });

  it("从 config + last 取上下文：sessionId/signal 走 config，messageId 走 last AIMessage.id", async () => {
    const emitter = new EventEmitter2();
    const tool = new CtxCaptureTool();
    const node = createToolsNode(makeRegistry([tool]), emitter);
    const ac = new AbortController();
    const ai = new AIMessage({
      id: "msg-xyz",
      content: "",
      tool_calls: [{ id: "tc-cap", name: "capture", args: {} }],
    });
    await node({ messages: [ai] }, cfg("session-xyz", ac.signal));
    expect(tool.lastCtx.sessionId).toBe("session-xyz");
    expect(tool.lastCtx.messageId).toBe("msg-xyz");
    expect(tool.lastCtx.toolCallId).toBe("tc-cap");
    expect(tool.lastCtx.signal).toBe(ac.signal);
    expect(tool.lastCtx.emitter).toBe(emitter);
  });

  it("同轮多个 tool_calls 并发执行且结果保序", async () => {
    const order: string[] = [];
    const registry = {
      get: (name: string) => ({
        name,
        description: "",
        schema: { parse: (a: unknown) => a },
        execute: async () => {
          const delay = name === "slow" ? 60 : 10;
          await new Promise((r) => setTimeout(r, delay));
          order.push(name);
          return `${name}-result`;
        },
      }),
    } as unknown as import("../../tools/tool-registry").ToolRegistry;
    const emitter = {
      emit: () => true,
    } as unknown as import("@nestjs/event-emitter").EventEmitter2;
    const node = createToolsNode(registry, emitter);
    const state = {
      messages: [
        {
          id: "m1",
          tool_calls: [
            { id: "c1", name: "slow", args: {} },
            { id: "c2", name: "fast", args: {} },
          ],
        } as never,
      ],
    };
    const start = Date.now();
    const out = (await node(
      state as never,
      {
        configurable: { thread_id: "s1" },
        signal: new AbortController().signal,
      } as never,
    )) as unknown as {
      messages: Array<{ tool_call_id: string; content: string }>;
    };
    const elapsed = Date.now() - start;
    // 并发：总耗时接近慢的（~60ms），远小于串行（~70ms+）；放宽到 <150ms 容错
    expect(elapsed).toBeLessThan(150);
    // 保序：结果数组仍按 tool_calls 顺序（slow=c1 在前）
    expect(out.messages.map((m) => m.tool_call_id)).toEqual(["c1", "c2"]);
    // fast 先完成（order[0]="fast"）证明确实并发而非串行
    expect(order[0]).toBe("fast");
  });

  it("多 session 并发跑同一个 GraphService 也不串台（修 ctxRef 单例 bug 的回归用例）", async () => {
    // 共享同一个 toolsNode（对应 GraphService 单例）—— 同时跑两份带不同 sessionId
    // 的 graph.stream，验证 tool 事件 / ctx 都按本次 config 隔离，互不覆盖。
    const emitter = new EventEmitter2();
    const events: Array<{
      event: string;
      payload: { sessionId: string; messageId: string; toolCallId: string };
    }> = [];
    emitter.onAny((event, payload) =>
      events.push({ event: String(event), payload: payload as never }),
    );
    const toolA = new CtxCaptureTool();
    // 同 name 不能重复注册；两个 session 跑同一个 tool 实例就够验证 ctx 隔离
    const node = createToolsNode(makeRegistry([toolA]), emitter);
    const aiA = new AIMessage({
      id: "msg-A",
      content: "",
      tool_calls: [{ id: "tc-A", name: "capture", args: {} }],
    });
    const aiB = new AIMessage({
      id: "msg-B",
      content: "",
      tool_calls: [{ id: "tc-B", name: "capture", args: {} }],
    });
    await Promise.all([
      node({ messages: [aiA] }, cfg("session-A")),
      node({ messages: [aiB] }, cfg("session-B")),
    ]);
    // 两个 session 各自的 tool_call_start 都应带正确 sessionId / messageId
    const startA = events.find(
      (e) =>
        e.event === "run.tool_call_start" && e.payload.toolCallId === "tc-A",
    );
    const startB = events.find(
      (e) =>
        e.event === "run.tool_call_start" && e.payload.toolCallId === "tc-B",
    );
    expect(startA?.payload.sessionId).toBe("session-A");
    expect(startA?.payload.messageId).toBe("msg-A");
    expect(startB?.payload.sessionId).toBe("session-B");
    expect(startB?.payload.messageId).toBe("msg-B");
  });
});
