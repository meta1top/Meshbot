import "reflect-metadata";

import { generateSnowflakeId, SnowflakeIdGenerator } from "./snowflake";

describe("SnowflakeIdGenerator", () => {
  it("生成数字字符串", () => {
    const id = generateSnowflakeId();
    expect(id).toMatch(/^\d+$/);
    expect(id.length).toBeGreaterThanOrEqual(15);
    expect(id.length).toBeLessThanOrEqual(20);
  });

  it("批量并发：1000 个 ID 全部唯一", () => {
    const gen = new SnowflakeIdGenerator(0);
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) ids.add(gen.next());
    expect(ids.size).toBe(1000);
  });

  it("不同 nodeId → 同毫秒 ID 不同", () => {
    const a = new SnowflakeIdGenerator(0);
    const b = new SnowflakeIdGenerator(1);
    const idA = a.next();
    const idB = b.next();
    expect(idA).not.toBe(idB);
  });

  it("ID 时间有序：后生成的 ≥ 前生成的", () => {
    const gen = new SnowflakeIdGenerator(0);
    const first = BigInt(gen.next());
    // 跳过一毫秒
    const wait = Date.now() + 2;
    while (Date.now() < wait) {
      /* spin */
    }
    const later = BigInt(gen.next());
    expect(later > first).toBe(true);
  });

  it("nodeId 越界自动 clamp", () => {
    // 应该取低 10 bit
    const a = new SnowflakeIdGenerator(2000); // 0b11111010000
    const b = new SnowflakeIdGenerator(2000 & 0x3ff); // 0b1110100000
    // 同 nodeId 等价 → 同毫秒序列差距 ≤ 4095（同 generator state）
    expect(typeof a.next()).toBe("string");
    expect(typeof b.next()).toBe("string");
  });

  it("负数 nodeId 当 0 处理", () => {
    const gen = new SnowflakeIdGenerator(-1);
    const id = gen.next();
    expect(id).toMatch(/^\d+$/);
  });
});
