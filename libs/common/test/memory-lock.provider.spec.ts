import { MemoryLockProvider } from "../src/lock/memory-lock.provider";

describe("MemoryLockProvider", () => {
  let provider: MemoryLockProvider;

  beforeEach(() => {
    provider = new MemoryLockProvider();
  });

  it("同一 key 串行执行：第二个等第一个释放", async () => {
    const order: string[] = [];
    await Promise.all([
      (async () => {
        const release = await provider.acquire("k", 5000, 5000);
        order.push("a-acq");
        await new Promise((r) => setTimeout(r, 50));
        order.push("a-rel");
        await release();
      })(),
      (async () => {
        await new Promise((r) => setTimeout(r, 10));
        const release = await provider.acquire("k", 5000, 5000);
        order.push("b-acq");
        await release();
      })(),
    ]);
    expect(order).toEqual(["a-acq", "a-rel", "b-acq"]);
  });

  it("不同 key 互不阻塞", async () => {
    const r1 = await provider.acquire("k1", 5000, 100);
    const r2 = await provider.acquire("k2", 5000, 100);
    await r1();
    await r2();
  });

  it("waitTimeout=0 立即失败时抛 LockAcquireFailed", async () => {
    const r1 = await provider.acquire("k", 5000, 5000);
    await expect(provider.acquire("k", 5000, 0)).rejects.toThrow(/LOCK_ACQUIRE_FAILED/);
    await r1();
  });
});
