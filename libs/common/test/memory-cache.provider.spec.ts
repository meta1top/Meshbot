import { MemoryCacheProvider } from "../src/cache/memory-cache.provider";

describe("MemoryCacheProvider", () => {
  let cache: MemoryCacheProvider;
  beforeEach(() => {
    cache = new MemoryCacheProvider();
  });

  it("set / get / del", async () => {
    await cache.set("k", "v");
    expect(await cache.get("k")).toBe("v");
    await cache.del("k");
    expect(await cache.get("k")).toBeUndefined();
  });

  it("delByPrefix 清掉所有前缀匹配的键", async () => {
    await cache.set("user:1:profile", "p1");
    await cache.set("user:1:posts", "p2");
    await cache.set("user:2:profile", "p3");
    await cache.delByPrefix("user:1:");
    expect(await cache.get("user:1:profile")).toBeUndefined();
    expect(await cache.get("user:1:posts")).toBeUndefined();
    expect(await cache.get("user:2:profile")).toBe("p3");
  });
});
