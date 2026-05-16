import "reflect-metadata";
import RedisMock from "ioredis-mock";

import { RedisLockProvider } from "./redis-lock.provider";

// ioredis-mock 默认导出与 ioredis 同形（构造函数 → 实例），但缺 eval 的
// 完整 Lua 实现。它会把 KEYS/ARGV 直接转给提供的 lua 解释器（内部 lua-shim），
// 我们的脚本只用 get/del 两个内置命令，命中支持范围。
//
// 测试用例覆盖 5 条 acceptance（plan B1 step 3）：
// 1. acquire 成功 → release 删 key
// 2. acquire 拿到锁后并发申请等待 → 超时抛 LOCK_ACQUIRE_FAILED
// 3. acquire 拿到锁 → release 后再申请成功
// 4. TTL 过期后无需 release 也能再申请
// 5. release 幂等（连续两次不抛错、不删别人的锁）

function makeProvider() {
  // biome-ignore lint/suspicious/noExplicitAny: ioredis-mock typings 不与真 ioredis 完全对齐
  const redis = new RedisMock() as any;
  return { redis, provider: new RedisLockProvider(redis) };
}

describe("RedisLockProvider", () => {
  it("acquire 成功 → release 删 key", async () => {
    const { redis, provider } = makeProvider();
    const release = await provider.acquire("k1", 5_000, 1_000);

    expect(await redis.get("k1")).not.toBeNull();
    await release();
    expect(await redis.get("k1")).toBeNull();
  });

  it("已被持有的锁 waitMs=0 立即失败", async () => {
    const { provider } = makeProvider();
    const release = await provider.acquire("k2", 5_000, 0);

    await expect(provider.acquire("k2", 5_000, 0)).rejects.toThrow(
      /LOCK_ACQUIRE_FAILED/,
    );
    await release();
  });

  it("已被持有的锁 waitMs > 0 → 超时抛 LOCK_ACQUIRE_FAILED", async () => {
    const { provider } = makeProvider();
    const release = await provider.acquire("k3", 5_000, 0);

    const start = Date.now();
    await expect(provider.acquire("k3", 5_000, 200)).rejects.toThrow(
      /LOCK_ACQUIRE_FAILED/,
    );
    const elapsed = Date.now() - start;
    // 至少等了大约 waitMs；不严格上限（jest/timer 抖动）
    expect(elapsed).toBeGreaterThanOrEqual(150);
    await release();
  });

  it("release 后再 acquire 成功", async () => {
    const { provider } = makeProvider();
    const release1 = await provider.acquire("k4", 5_000, 0);
    await release1();

    const release2 = await provider.acquire("k4", 5_000, 0);
    expect(typeof release2).toBe("function");
    await release2();
  });

  it("TTL 过期后无需 release 也能再 acquire", async () => {
    const { provider } = makeProvider();
    await provider.acquire("k5", 100, 0); // 不持有 release 引用，模拟 crashed holder

    // 等 TTL 过；ioredis-mock 支持 PX 过期
    await new Promise((r) => setTimeout(r, 200));

    const release2 = await provider.acquire("k5", 5_000, 0);
    expect(typeof release2).toBe("function");
    await release2();
  });

  it("release 幂等：连续两次不抛错、不影响后续 acquire", async () => {
    const { provider } = makeProvider();
    const release = await provider.acquire("k6", 5_000, 0);
    await release();
    await expect(release()).resolves.toBeUndefined();

    // 第二次 release 后仍可正常 acquire 同 key
    const release2 = await provider.acquire("k6", 5_000, 0);
    await release2();
  });

  it("release 不删除别人的锁（token 校验）", async () => {
    const { redis, provider } = makeProvider();
    const release1 = await provider.acquire("k7", 5_000, 0);

    // 先释放，然后让别人重新拿到同 key
    await release1();
    const release2 = await provider.acquire("k7", 5_000, 0);

    // 调用第一份 release 应该 no-op（幂等），不应误删第二份持有者的锁
    await release1();
    expect(await redis.get("k7")).not.toBeNull();

    await release2();
    expect(await redis.get("k7")).toBeNull();
  });
});
