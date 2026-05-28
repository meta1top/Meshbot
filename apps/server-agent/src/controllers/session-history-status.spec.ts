import { computeToolCallStatus } from "./session-history-status";

describe("computeToolCallStatus", () => {
  it("tool row 不存在 → running（assistant 已 persist 但 tool 还在跑）", () => {
    expect(computeToolCallStatus(undefined)).toBe("running");
  });

  it("tool row 存在、无 metadata → ok（成功，兼容老数据）", () => {
    expect(computeToolCallStatus({ metadata: null })).toBe("ok");
  });

  it("tool row 存在、metadata={ok:true} → ok", () => {
    expect(
      computeToolCallStatus({ metadata: JSON.stringify({ ok: true }) }),
    ).toBe("ok");
  });

  it("tool row 存在、metadata={ok:false} → error", () => {
    expect(
      computeToolCallStatus({ metadata: JSON.stringify({ ok: false }) }),
    ).toBe("error");
  });

  it("tool row 存在、metadata JSON 解析失败 → ok（防御性）", () => {
    expect(computeToolCallStatus({ metadata: "not-json-{{{" })).toBe("ok");
  });
});
