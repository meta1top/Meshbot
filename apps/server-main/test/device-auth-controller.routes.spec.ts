import { CommonErrorCode } from "@meshbot/common";
import type {
  CanActivate,
  ExecutionContext,
  INestApplication,
} from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import request from "supertest";

// 仅做路由 / 委派验证，service 全部 mock（无 DB）。
// 用与 @meshbot/main 同名的 class token 注册 mock。
import {
  DeviceAuthService,
  DeviceService,
  MembershipService,
  UserService,
} from "@meshbot/main";

import { type AppConfig, APP_CONFIG } from "../src/config/app-config.schema";
import { DeviceAuthController } from "../src/rest/device-auth.controller";
import { DeviceController } from "../src/rest/device.controller";

const TEST_USER = { userId: "u-1", email: "owner@x.io", orgId: null };
const TEST_APP_CONFIG = {
  webMainBase: "http://localhost:3002",
} as AppConfig;

/** 测试用守卫：模拟全局 JwtAuthGuard 注入 req.user（@Public 在此不生效，与 org-controller.routes.spec.ts 同策略）。 */
class FakeAuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    ctx.switchToHttp().getRequest().user = TEST_USER;
    return true;
  }
}

describe("DeviceAuthController 路由编排", () => {
  let app: INestApplication;
  let deviceAuth: { [k: string]: jest.Mock };
  let devices: { [k: string]: jest.Mock };
  let users: { [k: string]: jest.Mock };

  beforeEach(async () => {
    deviceAuth = {
      start: jest.fn().mockResolvedValue({
        id: "req-1",
        deviceName: "Mac",
        platform: "darwin",
        codeChallenge: "c".repeat(64),
        redirectUri: null,
        status: "pending",
      }),
      getForAuthorize: jest.fn().mockResolvedValue({
        id: "req-1",
        deviceName: "Mac",
        platform: "darwin",
        status: "pending",
      }),
      approve: jest
        .fn()
        .mockResolvedValue({ userCode: "code-1", redirectUri: null }),
      exchange: jest.fn().mockResolvedValue({
        userId: "u-1",
        deviceName: "Mac",
        platform: "darwin",
      }),
    };
    devices = {
      issueDevice: jest
        .fn()
        .mockResolvedValue({ device: { id: "d-1" }, token: "mbd_tok123" }),
    };
    users = {
      findById: jest.fn().mockResolvedValue({
        id: "u-1",
        email: "owner@x.io",
        displayName: "Owner",
        activeOrgId: "o-1",
      }),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [DeviceAuthController],
      providers: [
        { provide: DeviceAuthService, useValue: deviceAuth },
        { provide: DeviceService, useValue: devices },
        { provide: UserService, useValue: users },
        { provide: APP_CONFIG, useValue: TEST_APP_CONFIG },
        { provide: APP_GUARD, useClass: FakeAuthGuard },
      ],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it("POST /device-auth/start → 编排 deviceAuth.start + 拼 verifyUrl", async () => {
    const res = await request(app.getHttpServer())
      .post("/device-auth/start")
      .send({
        deviceName: "Mac",
        platform: "darwin",
        codeChallenge: "c".repeat(64),
      })
      .expect(200);

    expect(deviceAuth.start).toHaveBeenCalledWith({
      deviceName: "Mac",
      platform: "darwin",
      codeChallenge: "c".repeat(64),
      redirectUri: null,
    });
    expect(res.body).toEqual({
      requestId: "req-1",
      verifyUrl: "http://localhost:3002/authorize?request=req-1",
    });
  });

  it("POST /device-auth/approve → 编排 deviceAuth.approve(requestId, userId)", async () => {
    const res = await request(app.getHttpServer())
      .post("/device-auth/approve")
      .send({ requestId: "req-1" })
      .expect(200);

    expect(deviceAuth.approve).toHaveBeenCalledWith("req-1", TEST_USER.userId);
    expect(res.body).toEqual({ userCode: "code-1", redirectUri: null });
  });

  it("POST /device-auth/exchange → 顺序编排 exchange → findById → issueDevice", async () => {
    const res = await request(app.getHttpServer())
      .post("/device-auth/exchange")
      .send({
        requestId: "req-1",
        userCode: "code-1",
        codeVerifier: "v".repeat(16),
      })
      .expect(200);

    expect(deviceAuth.exchange).toHaveBeenCalledWith({
      requestId: "req-1",
      userCode: "code-1",
      codeVerifier: "v".repeat(16),
    });
    expect(users.findById).toHaveBeenCalledWith("u-1");
    expect(devices.issueDevice).toHaveBeenCalledWith({
      userId: "u-1",
      orgId: "o-1",
      name: "Mac",
      platform: "darwin",
    });

    // 断言编排顺序：exchange 先于 findById，findById 先于 issueDevice
    const exchangeOrder = deviceAuth.exchange.mock.invocationCallOrder[0];
    const findByIdOrder = users.findById.mock.invocationCallOrder[0];
    const issueOrder = devices.issueDevice.mock.invocationCallOrder[0];
    expect(exchangeOrder).toBeLessThan(findByIdOrder);
    expect(findByIdOrder).toBeLessThan(issueOrder);

    expect(res.body).toEqual({
      deviceToken: "mbd_tok123",
      user: { id: "u-1", email: "owner@x.io", displayName: "Owner" },
      orgId: "o-1",
    });
  });
});

describe("DeviceController 路由编排", () => {
  let app: INestApplication;
  let controller: DeviceController;
  let devices: { [k: string]: jest.Mock };
  let memberships: { [k: string]: jest.Mock };
  let users: { [k: string]: jest.Mock };

  beforeEach(async () => {
    devices = {
      listByUser: jest.fn().mockResolvedValue([
        {
          id: "d-1",
          name: "Mac",
          platform: "darwin",
          lastSeenAt: new Date("2026-07-01T00:00:00Z"),
          revokedAt: null,
          createdAt: new Date("2026-06-01T00:00:00Z"),
        },
      ]),
      revoke: jest.fn().mockResolvedValue(undefined),
      updateOrg: jest.fn().mockResolvedValue(undefined),
    };
    memberships = { assertMember: jest.fn().mockResolvedValue(undefined) };
    users = { setActiveOrg: jest.fn().mockResolvedValue(undefined) };

    const moduleRef = await Test.createTestingModule({
      controllers: [DeviceController],
      providers: [
        { provide: DeviceService, useValue: devices },
        { provide: MembershipService, useValue: memberships },
        { provide: UserService, useValue: users },
        { provide: APP_GUARD, useClass: FakeAuthGuard },
      ],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    controller = moduleRef.get(DeviceController);
  });

  afterEach(async () => {
    await app.close();
  });

  it("GET /devices → DeviceView[]（Date 转 ISO 字符串）", async () => {
    const res = await request(app.getHttpServer()).get("/devices").expect(200);

    expect(devices.listByUser).toHaveBeenCalledWith(TEST_USER.userId);
    expect(res.body).toEqual([
      {
        id: "d-1",
        name: "Mac",
        platform: "darwin",
        lastSeenAt: "2026-07-01T00:00:00.000Z",
        revokedAt: null,
        createdAt: "2026-06-01T00:00:00.000Z",
        isCurrent: false,
      },
    ]);
  });

  it("DELETE /devices/:id → 委派 devices.revoke(userId, id)", async () => {
    const res = await request(app.getHttpServer())
      .delete("/devices/d-1")
      .expect(200);

    expect(devices.revoke).toHaveBeenCalledWith(TEST_USER.userId, "d-1");
    expect(res.body).toEqual({ ok: true });
  });

  it("POST /devices/switch-org — payload 无 deviceId（用户 JWT 误用）→ FORBIDDEN(403)，且不触发任何写", async () => {
    // TEST_USER 无 deviceId 字段（Task 8 设备 token 识别落地前的固定形态）。
    // 路由 spec 未挂全局 ErrorsFilter，403 语义在 AppError.errorCode 上断言
    // （CommonErrorCode.FORBIDDEN 的 httpStatus=403 由 ErrorsFilter 映射）。
    await expect(
      controller.switchOrg(
        { userId: "u-1", email: "owner@x.io", orgId: null },
        { orgId: "o-2" } as Parameters<typeof controller.switchOrg>[1],
      ),
    ).rejects.toMatchObject({ errorCode: CommonErrorCode.FORBIDDEN });

    expect(memberships.assertMember).not.toHaveBeenCalled();
    expect(devices.updateOrg).not.toHaveBeenCalled();
    expect(users.setActiveOrg).not.toHaveBeenCalled();
  });
});
