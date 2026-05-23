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
