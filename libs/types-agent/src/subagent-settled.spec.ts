import type { RunSubagentSettledEvent } from "./session";
import { SESSION_WS_EVENTS } from "./session";

describe("RunSubagentSettledEvent", () => {
  it("事件常量为 run.subagent_settled", () => {
    expect(SESSION_WS_EVENTS.runSubagentSettled).toBe("run.subagent_settled");
  });

  it("payload 形状编译期成立（status 三态）", () => {
    const e: RunSubagentSettledEvent = {
      sessionId: "p1",
      toolCallId: "tc1",
      subSessionId: "s1",
      status: "aborted",
      output: "",
    };
    expect(e.status).toBe("aborted");
  });
});
