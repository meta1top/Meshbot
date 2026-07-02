import { AppError } from "@meshbot/common";
import type { Device } from "../entities/device.entity";
import {
  DEVICE_TOKEN_PREFIX,
  DeviceService,
  hashDeviceToken,
} from "./device.service";

function makeRepo(rows: Device[]) {
  return {
    create: jest.fn((v: Partial<Device>) => ({ ...v }) as Device),
    save: jest.fn(async (v: Device) => {
      v.id ??= `d${rows.length + 1}`;
      rows.push(v);
      return v;
    }),
    findOne: jest.fn(
      async ({ where }: { where: Partial<Device> }) =>
        rows.find((r) =>
          Object.entries(where).every(
            ([k, val]) => (r as never as Record<string, unknown>)[k] === val,
          ),
        ) ?? null,
    ),
    find: jest.fn(async ({ where }: { where: Partial<Device> }) =>
      rows.filter((r) => r.userId === where.userId),
    ),
    update: jest.fn(async (cond: Partial<Device>, patch: Partial<Device>) => {
      for (const r of rows) if (r.id === cond.id) Object.assign(r, patch);
    }),
  };
}

describe("DeviceService", () => {
  it("issueDevice 返回带前缀明文 token,库里只存哈希", async () => {
    const rows: Device[] = [];
    const svc = new DeviceService(makeRepo(rows) as never);
    const { device, token } = await svc.issueDevice({
      userId: "u1",
      orgId: "o1",
      name: "Mac",
      platform: "darwin",
    });
    expect(token.startsWith(DEVICE_TOKEN_PREFIX)).toBe(true);
    expect(device.tokenHash).toBe(hashDeviceToken(token));
    expect(rows[0].tokenHash).not.toContain(token.slice(4, 20));
  });

  it("verifyToken 命中返回设备,吊销后抛 DEVICE_TOKEN_INVALID", async () => {
    const rows: Device[] = [];
    const svc = new DeviceService(makeRepo(rows) as never);
    const { token } = await svc.issueDevice({
      userId: "u1",
      orgId: "o1",
      name: "Mac",
      platform: "darwin",
    });
    const dev = await svc.verifyToken(token);
    expect(dev.userId).toBe("u1");
    rows[0].revokedAt = new Date();
    await expect(svc.verifyToken(token)).rejects.toMatchObject({
      name: "AppError",
    });
  });

  it("verifyToken 未知 token 抛错", async () => {
    const svc = new DeviceService(makeRepo([]) as never);
    await expect(svc.verifyToken("mbd_unknown")).rejects.toBeInstanceOf(
      AppError,
    );
  });

  it("revoke 只能吊销本人设备", async () => {
    const rows: Device[] = [];
    const svc = new DeviceService(makeRepo(rows) as never);
    await svc.issueDevice({
      userId: "u1",
      orgId: null,
      name: "Mac",
      platform: "darwin",
    });
    await expect(svc.revoke("u2", rows[0].id)).rejects.toBeInstanceOf(AppError);
    await svc.revoke("u1", rows[0].id);
    expect(rows[0].revokedAt).toBeInstanceOf(Date);
  });
});
