import "reflect-metadata";
import RedisMock from "ioredis-mock";

import { RedisCacheProvider } from "./redis-cache.provider";

function makeProvider() {
  // biome-ignore lint/suspicious/noExplicitAny: ioredis-mock typings 不与真 ioredis 完全对齐
  const redis = new RedisMock() as any;
  return { redis, provider: new RedisCacheProvider(redis) };
}

describe("RedisCacheProvider", () => {
  it("set + get 往返（对象）", async () => {
    const { provider } = makeProvider();
    await provider.set("a", { x: 1, y: "hello" });
    expect(await provider.get<{ x: number; y: string }>("a")).toEqual({
      x: 1,
      y: "hello",
    });
  });

  it("set 带 TTL → 等 TTL 后 get undefined", async () => {
    const { provider } = makeProvider();
    await provider.set("b", "value", 100);
    expect(await provider.get("b")).toBe("value");
    await new Promise((r) => setTimeout(r, 200));
    expect(await provider.get("b")).toBeUndefined();
  });

  it("del 后 get undefined", async () => {
    const { provider } = makeProvider();
    await provider.set("c", "x");
    await provider.del("c");
    expect(await provider.get("c")).toBeUndefined();
  });

  it("不存在的 key get 返回 undefined", async () => {
    const { provider } = makeProvider();
    expect(await provider.get("never-existed")).toBeUndefined();
  });

  it("delByPrefix 命中多 key", async () => {
    const { provider } = makeProvider();
    await provider.set("user:1:profile", "p1");
    await provider.set("user:2:profile", "p2");
    await provider.set("user:3:profile", "p3");
    await provider.set("other:1", "keep");

    await provider.delByPrefix("user:");

    expect(await provider.get("user:1:profile")).toBeUndefined();
    expect(await provider.get("user:2:profile")).toBeUndefined();
    expect(await provider.get("user:3:profile")).toBeUndefined();
    expect(await provider.get("other:1")).toBe("keep");
  });

  it("delByPrefix 无命中时不报错", async () => {
    const { provider } = makeProvider();
    await provider.set("foo", "bar");
    await expect(provider.delByPrefix("nope:")).resolves.toBeUndefined();
    expect(await provider.get("foo")).toBe("bar");
  });
});
