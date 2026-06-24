import { vi } from "vitest";
import type { QuickAssistantPort } from "../quick-assistant.port";
import type { ToolContext } from "../tool.types";
import { RenameQuickAssistantTool } from "./rename-quick-assistant.tool";

function fakeCtx(): ToolContext {
  return {
    sessionId: "s1",
    messageId: "m1",
    toolCallId: "tc1",
    emitter: {} as never,
    signal: new AbortController().signal,
  };
}

describe("rename_quick_assistant tool", () => {
  it("透传新名字给端口，返回新名 JSON", async () => {
    const rename = vi.fn();
    const port: QuickAssistantPort = { rename };
    const tool = new RenameQuickAssistantTool(port);

    const out = await tool.execute({ name: "小M" }, fakeCtx());

    expect(rename).toHaveBeenCalledWith("小M");
    expect(JSON.parse(out)).toEqual({ name: "小M" });
  });
});
