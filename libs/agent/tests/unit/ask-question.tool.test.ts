import { describe, expect, it, vi } from "vitest";
import type { AskQuestionPort } from "../../src/tools/ask-question.port";
import { AskQuestionTool } from "../../src/tools/builtins/ask-question.tool";

describe("ask_question tool", () => {
  it("把 ctx.sessionId/toolCallId/signal 透传给 port.ask 并原样返回", async () => {
    const port: AskQuestionPort = {
      ask: vi.fn().mockResolvedValue('{"status":"answered","answers":[]}'),
    };
    const tool = new AskQuestionTool(port);
    expect(tool.name).toBe("ask_question");
    const signal = new AbortController().signal;
    const out = await tool.execute(
      {
        questions: [
          { question: "q", options: [{ label: "A" }], multiSelect: false },
        ],
      },
      { sessionId: "s1", toolCallId: "tc1", signal } as never,
    );
    expect(out).toBe('{"status":"answered","answers":[]}');
    expect(port.ask).toHaveBeenCalledWith(
      { sessionId: "s1", toolCallId: "tc1" },
      signal,
    );
  });
});
