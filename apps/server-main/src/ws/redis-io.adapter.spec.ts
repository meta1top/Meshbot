import { RedisIoAdapter } from "./redis-io.adapter";

describe("RedisIoAdapter", () => {
  it("无 Redis 配置：isClustered=false，createIOServer 强制 websocket-only 且不挂 redis adapter", async () => {
    const adapter = new RedisIoAdapter(undefined as never);
    await adapter.connectToRedis(undefined);
    expect(adapter.isClustered()).toBe(false);

    // opts 在 socket.io 类型中标记为 private，通过 unknown 中转以访问运行时属性
    const server = adapter.createIOServer(0) as unknown as {
      opts: { transports?: string[] };
      close: () => void;
    };
    expect(server.opts.transports).toEqual(["websocket"]);
    server.close();
  });

  it("connectToRedis(undefined) 幂等：不抛错、可重复调用", async () => {
    const adapter = new RedisIoAdapter(undefined as never);
    await adapter.connectToRedis(undefined);
    await adapter.connectToRedis(undefined);
    expect(adapter.isClustered()).toBe(false);
  });
});
