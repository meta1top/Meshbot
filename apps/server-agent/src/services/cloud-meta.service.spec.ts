import { CloudMetaService } from "./cloud-meta.service";

function build() {
  const cloud = { get: jest.fn() };
  const svc = new CloudMetaService(cloud as never);
  return { svc, cloud };
}

describe("CloudMetaService", () => {
  it("首次调用代理云端 /api/meta，缓存命中后不再重复请求", async () => {
    const { svc, cloud } = build();
    cloud.get.mockResolvedValue({ webMainBase: "http://localhost:3002" });

    const first = await svc.getWebMainBase();
    const second = await svc.getWebMainBase();

    expect(first).toBe("http://localhost:3002");
    expect(second).toBe("http://localhost:3002");
    expect(cloud.get).toHaveBeenCalledTimes(1);
    expect(cloud.get).toHaveBeenCalledWith("/api/meta");
  });

  it("云端请求失败 → 透传错误，且不缓存（下次调用照常重试）", async () => {
    const { svc, cloud } = build();
    cloud.get.mockRejectedValueOnce(new Error("cloud unreachable"));
    cloud.get.mockResolvedValueOnce({ webMainBase: "http://localhost:3002" });

    await expect(svc.getWebMainBase()).rejects.toThrow("cloud unreachable");
    await expect(svc.getWebMainBase()).resolves.toBe("http://localhost:3002");
    expect(cloud.get).toHaveBeenCalledTimes(2);
  });
});
