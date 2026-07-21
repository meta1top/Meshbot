import { isReasoningThinking } from "./reasoning-thinking";

describe("isReasoningThinking", () => {
  it("durationMs 已锁定 + streaming=true → 不再计时（推理已结束、工具在跑）", () => {
    expect(
      isReasoningThinking({
        startedAt: 1000,
        durationMs: 2500,
        streaming: true,
      }),
    ).toBe(false);
  });

  it("durationMs 缺失 + streaming=true → 计时（刷新落在 reasoning 流式中）", () => {
    expect(isReasoningThinking({ streaming: true })).toBe(true);
  });

  it("durationMs 缺失 + 有 startedAt → 计时（正在推理）", () => {
    expect(isReasoningThinking({ startedAt: 1000 })).toBe(true);
  });

  it("durationMs 已锁定 + 无 streaming → 不计时（历史消息）", () => {
    expect(isReasoningThinking({ startedAt: 1000, durationMs: 2500 })).toBe(
      false,
    );
  });

  it("durationMs=0 也算已锁定（持久化历史消息不显示思考中）", () => {
    expect(isReasoningThinking({ durationMs: 0, streaming: true })).toBe(false);
  });

  it("三者皆无 → 不计时", () => {
    expect(isReasoningThinking({})).toBe(false);
  });
});
