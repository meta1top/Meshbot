import net from "node:net";
import { findAvailablePort, PREFERRED_PORT, resolvePort } from "./resolve-port";

function listen(port: number, host: string): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(port, host, () => resolve(s));
  });
}

function close(s: net.Server): Promise<void> {
  return new Promise((r) => s.close(() => r()));
}

describe("findAvailablePort", () => {
  it("偏好端口空闲时直接返回偏好端口", async () => {
    const probe = await listen(0, "127.0.0.1");
    const free = (probe.address() as net.AddressInfo).port;
    await close(probe);
    const got = await findAvailablePort(free, "127.0.0.1", 50);
    expect(got).toBe(free);
  });

  it("偏好端口被占用时跳到下一个空闲端口", async () => {
    const probe = await listen(0, "127.0.0.1");
    const occupied = (probe.address() as net.AddressInfo).port;
    try {
      const got = await findAvailablePort(occupied, "127.0.0.1", 50);
      expect(got).toBeGreaterThan(occupied);
    } finally {
      await close(probe);
    }
  });
});

describe("resolvePort", () => {
  const orig = process.env.MESHBOT_PORT;
  afterEach(() => {
    if (orig === undefined) delete process.env.MESHBOT_PORT;
    else process.env.MESHBOT_PORT = orig;
  });

  it("MESHBOT_PORT 显式设置时原样返回（严格）", async () => {
    process.env.MESHBOT_PORT = "12345";
    expect(await resolvePort("127.0.0.1")).toBe(12345);
  });

  it("MESHBOT_PORT 非法时抛错", async () => {
    process.env.MESHBOT_PORT = "abc";
    await expect(resolvePort("127.0.0.1")).rejects.toThrow();
  });

  it("未设置 MESHBOT_PORT 时返回 >= PREFERRED_PORT 的端口", async () => {
    delete process.env.MESHBOT_PORT;
    const p = await resolvePort("127.0.0.1");
    expect(p).toBeGreaterThanOrEqual(PREFERRED_PORT);
  });
});
