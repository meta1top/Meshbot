import {
  AppError,
  injectLockProvider,
  MemoryLockProvider,
} from "@meshbot/common";
import { FindOperator } from "typeorm";
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
      if (!rows.includes(v)) rows.push(v);
      return v;
    }),
    findOne: jest.fn(
      async ({ where }: { where: Record<string, unknown> }) =>
        rows.find((r) =>
          Object.entries(where).every(([k, val]) => {
            const rv = (r as never as Record<string, unknown>)[k];
            if (val instanceof FindOperator) return rv == null;
            return rv === val;
          }),
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

/** 纯 new + 注入进程内锁 provider(issueDevice 挂了 @WithLock,见 device-auth.service.spec 先例)。 */
function buildSvc(rows: Device[]) {
  const svc = new DeviceService(makeRepo(rows) as never);
  injectLockProvider(svc, new MemoryLockProvider());
  return svc;
}

describe("DeviceService", () => {
  it("issueDevice 返回带前缀明文 token,库里只存哈希", async () => {
    const rows: Device[] = [];
    const svc = buildSvc(rows);
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
    const svc = buildSvc(rows);
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
    const svc = buildSvc([]);
    await expect(svc.verifyToken("mbd_unknown")).rejects.toBeInstanceOf(
      AppError,
    );
  });

  it("revoke 只能吊销本人设备", async () => {
    const rows: Device[] = [];
    const svc = buildSvc(rows);
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

  it("issueDevice 同 (userId, machineId) 复用行并轮换 token", async () => {
    const rows: Device[] = [];
    const svc = buildSvc(rows);
    const first = await svc.issueDevice({
      userId: "u1",
      orgId: "o1",
      name: "Mac",
      platform: "darwin",
      machineId: "m-abc",
    });
    const second = await svc.issueDevice({
      userId: "u1",
      orgId: "o2",
      name: "Mac renamed",
      platform: "darwin",
      machineId: "m-abc",
    });
    expect(rows).toHaveLength(1);
    expect(second.device.id).toBe(first.device.id);
    expect(second.token).not.toBe(first.token);
    expect(rows[0].tokenHash).toBe(hashDeviceToken(second.token));
    expect(rows[0].orgId).toBe("o2");
    expect(rows[0].name).toBe("Mac renamed");
  });

  it("issueDevice 无 machineId 每次新建行", async () => {
    const rows: Device[] = [];
    const svc = buildSvc(rows);
    await svc.issueDevice({
      userId: "u1",
      orgId: null,
      name: "a",
      platform: "darwin",
    });
    await svc.issueDevice({
      userId: "u1",
      orgId: null,
      name: "b",
      platform: "darwin",
    });
    expect(rows).toHaveLength(2);
  });

  it("issueDevice 不同 machineId(dev vs 打包版)同 user 各建一行", async () => {
    const rows: Device[] = [];
    const svc = buildSvc(rows);
    await svc.issueDevice({
      userId: "u1",
      orgId: null,
      name: "dev",
      platform: "darwin",
      machineId: "dev-m-abc",
    });
    await svc.issueDevice({
      userId: "u1",
      orgId: null,
      name: "pkg",
      platform: "darwin",
      machineId: "m-abc",
    });
    expect(rows).toHaveLength(2);
  });

  it("issueDevice 命中行已吊销时仍新建行(IsNull 过滤)", async () => {
    const rows: Device[] = [];
    const svc = buildSvc(rows);
    const first = await svc.issueDevice({
      userId: "u1",
      orgId: null,
      name: "Mac",
      platform: "darwin",
      machineId: "m-abc",
    });
    rows[0].revokedAt = new Date();
    const second = await svc.issueDevice({
      userId: "u1",
      orgId: null,
      name: "Mac",
      platform: "darwin",
      machineId: "m-abc",
    });
    expect(rows).toHaveLength(2);
    expect(second.device.id).not.toBe(first.device.id);
  });

  it("issueDevice machineId 空串按无 machineId 处理(不去重、存 null)", async () => {
    const rows: Device[] = [];
    const svc = buildSvc(rows);
    await svc.issueDevice({
      userId: "u1",
      orgId: null,
      name: "a",
      platform: "darwin",
      machineId: "",
    });
    await svc.issueDevice({
      userId: "u1",
      orgId: null,
      name: "b",
      platform: "darwin",
      machineId: "",
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].machineId).toBeNull();
    expect(rows[1].machineId).toBeNull();
  });
});
