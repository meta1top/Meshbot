import { describe, expect, it, vi } from "vitest";
import type { ImSendPort } from "../../src/tools/im-send.port";
import { ImSendMessageTool } from "../../src/tools/builtins/im-send-message.tool";

describe("im_send_message tool", () => {
  it("把 ctx.sessionId/toolCallId/signal + args 透传给 port.confirmAndSend 并原样返回", async () => {
    const port: ImSendPort = {
      confirmAndSend: vi.fn().mockResolvedValue('{"status":"sent"}'),
    };
    const tool = new ImSendMessageTool(port);
    expect(tool.name).toBe("im_send_message");
    const signal = new AbortController().signal;
    const out = await tool.execute({ conversationId: "321", content: "你好" }, {
      sessionId: "s1",
      toolCallId: "tc1",
      signal,
    } as never);
    expect(out).toBe('{"status":"sent"}');
    expect(port.confirmAndSend).toHaveBeenCalledWith(
      {
        sessionId: "s1",
        toolCallId: "tc1",
        conversationId: "321",
        content: "你好",
      },
      signal,
    );
  });
});
