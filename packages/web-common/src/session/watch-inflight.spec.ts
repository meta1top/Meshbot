import { SESSION_WS_EVENTS } from "@meshbot/types-agent";
import { inflightToSnapshotEvent } from "./watch-inflight";

describe("inflightToSnapshotEvent（D7 中途续上）", () => {
  it("null / undefined → null（无活跃 run，不是错误）", () => {
    expect(inflightToSnapshotEvent("s1", null)).toBeNull();
    expect(inflightToSnapshotEvent("s1", undefined)).toBeNull();
  });

  it("messageId 为 null → null（已落库轮，不该当 inflight 重复推）", () => {
    expect(
      inflightToSnapshotEvent("s1", {
        messageId: null,
        content: "",
        reasoning: "",
        reasoningStartedAt: null,
        toolCalls: [],
        status: "done",
      }),
    ).toBeNull();
  });

  it("有活跃 partial → 合成 run.snapshot 事件", () => {
    expect(
      inflightToSnapshotEvent("s1", {
        messageId: "m1",
        content: "半截输出",
        reasoning: "想了想",
        reasoningStartedAt: 1234,
        toolCalls: [{ toolCallId: "t1", name: "read", argsText: '{"p":' }],
        status: "streaming",
      }),
    ).toEqual({
      event: SESSION_WS_EVENTS.runSnapshot,
      payload: {
        sessionId: "s1",
        messageId: "m1",
        reasoning: "想了想",
        content: "半截输出",
        reasoningStartedAt: 1234,
        toolCalls: [{ toolCallId: "t1", name: "read", argsText: '{"p":' }],
      },
    });
  });

  it("形状不符（非对象 / 缺字段）→ null，不抛", () => {
    expect(inflightToSnapshotEvent("s1", "字符串")).toBeNull();
    expect(inflightToSnapshotEvent("s1", { 乱七八糟: 1 })).toBeNull();
  });
});
