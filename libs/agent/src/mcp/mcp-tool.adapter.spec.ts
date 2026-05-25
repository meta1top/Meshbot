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

  it("ctx.signal 透传：abort 触发后 lc tool 看得到 signal.aborted", async () => {
    let seenAborted = false;
    const lc = createLcTool(
      async (_input: unknown, config?: { signal?: AbortSignal }) => {
        seenAborted = config?.signal?.aborted === true;
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
    await meshbot.execute({}, { ...makeCtx(), signal: ctrl.signal });
    expect(seenAborted).toBe(true);
  });
});
