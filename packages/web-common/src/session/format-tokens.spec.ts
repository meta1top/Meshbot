import { formatTokens } from "./format-tokens";

describe("formatTokens", () => {
  it("< 1000 → 原数字", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
  });

  it("< 1_000_000 → x.xk（整数 k 不带小数）", () => {
    expect(formatTokens(1000)).toBe("1k");
    expect(formatTokens(1500)).toBe("1.5k");
    expect(formatTokens(128_000)).toBe("128k");
  });

  it(">= 1_000_000 → x.xm", () => {
    expect(formatTokens(1_280_000)).toBe("1.28m");
  });
});
