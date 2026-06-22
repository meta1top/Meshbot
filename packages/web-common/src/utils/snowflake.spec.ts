import { clientSnowflakeId } from "./snowflake";

describe("clientSnowflakeId", () => {
  it("返回 ≤20 位十进制字符串", () => {
    const id = clientSnowflakeId();
    expect(id).toMatch(/^\d{1,20}$/);
  });

  it("连续生成不重复且单调不减", () => {
    const a = clientSnowflakeId();
    const b = clientSnowflakeId();
    expect(a).not.toBe(b);
    expect(BigInt(b) >= BigInt(a)).toBe(true);
  });
});
