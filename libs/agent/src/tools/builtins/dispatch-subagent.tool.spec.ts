import { describe, expect, it, vi } from "vitest";
import { DispatchSubagentTool } from "./dispatch-subagent.tool";

describe("DispatchSubagentTool", () => {
  it("从 ctx 取 parentSessionId/parentToolCallId 并透传 args + signal 给 port", async () => {
    const dispatch = vi.fn().mockResolvedValue('{"status":"done"}');
    const tool = new DispatchSubagentTool({ dispatch } as never);
    const signal = new AbortController().signal;
    const res = await tool.execute(
      { task: "t", description: "d", background: false },
      {
        sessionId: "parent",
        toolCallId: "tc",
        messageId: "m",
        emitter: {} as never,
        signal,
      },
    );
    expect(res).toBe('{"status":"done"}');
    expect(dispatch).toHaveBeenCalledWith(
      {
        parentSessionId: "parent",
        parentToolCallId: "tc",
        task: "t",
        description: "d",
        model: undefined,
        background: false,
      },
      signal,
    );
  });
});
