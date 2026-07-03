import { DevicePresenceService } from "./device-presence.service";

describe("DevicePresenceService(内存退化)", () => {
  it("setOnline → listOnline 含该设备;setOffline 后移除", async () => {
    const svc = new DevicePresenceService(null);
    await svc.setOnline("o1", "d1");
    await svc.setOnline("o1", "d2");
    expect((await svc.listOnline("o1")).sort()).toEqual(["d1", "d2"]);
    expect(await svc.isOnline("o1", "d1")).toBe(true);
    await svc.setOffline("o1", "d1");
    expect(await svc.listOnline("o1")).toEqual(["d2"]);
    expect(await svc.isOnline("o1", "d1")).toBe(false);
  });

  it("过期设备不再在线(注入可控 now)", async () => {
    let now = 1_000_000;
    const svc = new DevicePresenceService(null, () => now);
    await svc.setOnline("o1", "d1");
    now += 46_000;
    expect(await svc.listOnline("o1")).toEqual([]);
  });
});
