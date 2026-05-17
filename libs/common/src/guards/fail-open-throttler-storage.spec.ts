import "reflect-metadata";

import type { ThrottlerStorage } from "@nestjs/throttler";

import { FailOpenThrottlerStorage } from "./fail-open-throttler-storage";

type ThrottlerStorageRecord = Awaited<
  ReturnType<ThrottlerStorage["increment"]>
>;

describe("FailOpenThrottlerStorage", () => {
  const okRecord: ThrottlerStorageRecord = {
    totalHits: 5,
    timeToExpire: 1000,
    isBlocked: false,
    timeToBlockExpire: 0,
  };

  it("底层正常 → 透传原始 record", async () => {
    const inner: ThrottlerStorage = {
      increment: jest.fn().mockResolvedValue(okRecord),
    };
    const storage = new FailOpenThrottlerStorage(inner);
    const out = await storage.increment("k", 1000, 30, 0, "short");
    expect(out).toEqual(okRecord);
    expect(inner.increment).toHaveBeenCalledWith("k", 1000, 30, 0, "short");
  });

  it("底层抛错 → fail-open，返回未触发限流的 record（放行）", async () => {
    const inner: ThrottlerStorage = {
      increment: jest.fn().mockRejectedValue(new Error("Redis ECONNREFUSED")),
    };
    const storage = new FailOpenThrottlerStorage(inner);
    const out = await storage.increment("k", 5000, 30, 0, "medium");
    expect(out).toEqual({
      totalHits: 0,
      timeToExpire: 5000,
      isBlocked: false,
      timeToBlockExpire: 0,
    });
  });

  it("fail-open 时不抛异常（绝不冒泡成 500）", async () => {
    const inner: ThrottlerStorage = {
      increment: jest.fn().mockRejectedValue("non-error rejection"),
    };
    const storage = new FailOpenThrottlerStorage(inner);
    await expect(
      storage.increment("k", 1000, 30, 0, "short"),
    ).resolves.toBeDefined();
  });
});
