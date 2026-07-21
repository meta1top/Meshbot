import { RemoteAnswerSchema, RemoteConfirmSchema } from "./remote-run.dto";

/**
 * Task 16b：`RemoteConfirmSchema`/`RemoteAnswerSchema` 补上 `watchId` 二选一
 * 回退（web-agent 观察者经本机 server-agent 代理应答别人发起的 run），逐字义
 * 镜像 relay 线路层 `AgentRunControlSchema` 的双寻址约束（见
 * `libs/types/src/im/agent-run-control.schema.spec.ts` 的同名用例）。
 */
describe("RemoteConfirmSchema 双寻址", () => {
  const base = {
    sessionId: "s1",
    toolCallId: "t1",
    decision: "send" as const,
  };

  it("只带 streamId 通过（自己发起的 run，既有行为不变）", () => {
    expect(
      RemoteConfirmSchema.safeParse({ ...base, streamId: "st1" }).success,
    ).toBe(true);
  });

  it("只带 watchId 通过（观察者应答）", () => {
    expect(
      RemoteConfirmSchema.safeParse({ ...base, watchId: "w1" }).success,
    ).toBe(true);
  });

  it("都不带 / 都带 均被拒", () => {
    expect(RemoteConfirmSchema.safeParse(base).success).toBe(false);
    expect(
      RemoteConfirmSchema.safeParse({
        ...base,
        streamId: "st1",
        watchId: "w1",
      }).success,
    ).toBe(false);
  });
});

describe("RemoteAnswerSchema 双寻址", () => {
  const base = {
    sessionId: "s1",
    toolCallId: "t1",
    answers: [{ selected: ["A"] }],
  };

  it("只带 streamId 通过", () => {
    expect(
      RemoteAnswerSchema.safeParse({ ...base, streamId: "st1" }).success,
    ).toBe(true);
  });

  it("只带 watchId 通过（观察者应答）", () => {
    expect(
      RemoteAnswerSchema.safeParse({ ...base, watchId: "w1" }).success,
    ).toBe(true);
  });

  it("都不带 / 都带 均被拒", () => {
    expect(RemoteAnswerSchema.safeParse(base).success).toBe(false);
    expect(
      RemoteAnswerSchema.safeParse({
        ...base,
        streamId: "st1",
        watchId: "w1",
      }).success,
    ).toBe(false);
  });
});
