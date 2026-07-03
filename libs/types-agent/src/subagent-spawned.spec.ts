import type { RunSubagentSpawnedEvent } from "./session";
import { SESSION_WS_EVENTS } from "./session";

describe("RunSubagentSpawnedEvent", () => {
  it("事件常量为 run.subagent_spawned", () => {
    expect(SESSION_WS_EVENTS.runSubagentSpawned).toBe("run.subagent_spawned");
  });

  it("payload 形状编译期成立（四字段）", () => {
    const e: RunSubagentSpawnedEvent = {
      sessionId: "p1",
      toolCallId: "tc1",
      subSessionId: "s1",
      description: "分析文档并总结",
    };
    expect(e.subSessionId).toBe("s1");
  });
});
