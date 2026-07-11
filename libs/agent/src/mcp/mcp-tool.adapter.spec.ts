import { tool as createLcTool } from "@langchain/core/tools";
import { z } from "zod";
import type { ToolContext } from "../tools/tool.types";
import { buildMcpToolAdapter } from "./mcp-tool.adapter";

function makeCtx(): ToolContext {
  return {
    sessionId: "s1",
    messageId: "m1",
    toolCallId: "t1",
    emitter: { emit: () => true } as never,
    signal: new AbortController().signal,
  };
}

describe("buildMcpToolAdapter", () => {
  it("透传 name / description；schema z.any() 不校验，args 原样传 lcTool.invoke", async () => {
    const calls: unknown[] = [];
    const lc = createLcTool(
      async (input: unknown) => {
        calls.push(input);
        return "ok";
      },
      {
        name: "mcp__demo__echo",
        description: "echo desc",
        schema: z.object({ msg: z.string() }),
      },
    );
    const { meshbot } = buildMcpToolAdapter(lc);
    expect(meshbot.name).toBe("mcp__demo__echo");
    expect(meshbot.description).toBe("echo desc");
    const parsed = meshbot.schema.parse({ anything: "passes" });
    expect(parsed).toEqual({ anything: "passes" });
    const out = await meshbot.execute({ msg: "hi" }, makeCtx());
    expect(out).toBe("ok");
    expect(calls).toEqual([{ msg: "hi" }]);
  });

  it("非字符串结果序列化为 JSON 字符串", async () => {
    const lc = createLcTool(
      async () => ({ value: 42, items: [1, 2] }) as never,
      {
        name: "obj_tool",
        description: "",
        schema: z.object({}),
      },
    );
    const { meshbot } = buildMcpToolAdapter(lc);
    const out = await meshbot.execute({}, makeCtx());
    expect(JSON.parse(out)).toEqual({ value: 42, items: [1, 2] });
  });

  it("调用前已 abort：不执行工具，execute 直接抛（core 1.x 下透传已 abort 的 signal 会挂起）", async () => {
    let toolRan = false;
    const lc = createLcTool(
      async () => {
        toolRan = true;
        return "done";
      },
      {
        name: "signal_tool",
        description: "",
        schema: z.object({}),
      },
    );
    const ctrl = new AbortController();
    ctrl.abort();
    const { meshbot } = buildMcpToolAdapter(lc);
    await expect(
      meshbot.execute({}, { ...makeCtx(), signal: ctrl.signal }),
    ).rejects.toThrow(/未执行：调用前已被取消/);
    expect(toolRan).toBe(false);
  });

  it("ctx.signal 透传：未 abort 的 signal 原样传到 lc tool 的 config", async () => {
    let seenSignal: AbortSignal | undefined;
    const lc = createLcTool(
      async (_input: unknown, config?: { signal?: AbortSignal }) => {
        seenSignal = config?.signal;
        return "done";
      },
      {
        name: "signal_tool",
        description: "",
        schema: z.object({}),
      },
    );
    const ctrl = new AbortController();
    const { meshbot } = buildMcpToolAdapter(lc);
    const out = await meshbot.execute(
      {},
      { ...makeCtx(), signal: ctrl.signal },
    );
    expect(out).toBe("done");
    expect(seenSignal).toBe(ctrl.signal);
    expect(seenSignal?.aborted).toBe(false);
  });
});
