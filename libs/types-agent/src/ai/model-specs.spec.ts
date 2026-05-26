import { describe, expect, it } from "@jest/globals";
import {
  FALLBACK_CONTEXT_WINDOW,
  getModelSpec,
  resolveContextWindow,
} from "./model-specs";

describe("model-specs", () => {
  it("getModelSpec 命中已知模型", () => {
    expect(getModelSpec("deepseek-v4-pro")?.contextWindow).toBe(1_000_000);
    expect(getModelSpec("gpt-4o")?.contextWindow).toBe(128_000);
    expect(getModelSpec("claude-sonnet-4-6")?.contextWindow).toBe(200_000);
  });

  it("getModelSpec 未知模型返 undefined", () => {
    expect(getModelSpec("unknown-model-xyz")).toBeUndefined();
  });

  it("resolveContextWindow 用户覆盖优先", () => {
    expect(resolveContextWindow("deepseek-v4-pro", 256_000)).toBe(256_000);
    // 未知模型也允许用户覆盖
    expect(resolveContextWindow("unknown-private-model", 50_000)).toBe(50_000);
  });

  it("resolveContextWindow 用户未给则按 spec 解析", () => {
    expect(resolveContextWindow("deepseek-v4-pro")).toBe(1_000_000);
    expect(resolveContextWindow("gpt-4.1", undefined)).toBe(1_000_000);
    expect(resolveContextWindow("claude-opus-4-7", null)).toBe(200_000);
  });

  it("resolveContextWindow 未知模型 + 无覆盖 → FALLBACK", () => {
    expect(resolveContextWindow("totally-unknown")).toBe(
      FALLBACK_CONTEXT_WINDOW,
    );
    expect(FALLBACK_CONTEXT_WINDOW).toBe(128_000);
  });

  it("resolveContextWindow 用户覆盖 0 / 负数 视为未填", () => {
    expect(resolveContextWindow("deepseek-v4-pro", 0)).toBe(1_000_000);
    expect(resolveContextWindow("deepseek-v4-pro", -1)).toBe(1_000_000);
  });
});
