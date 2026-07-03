import { CommonErrorCode } from "@meshbot/common";
import {
  ConversationService,
  DevicePresenceService,
  MembershipService,
  MessageService,
} from "@meshbot/main";
import type {
  CanActivate,
  ExecutionContext,
  INestApplication,
} from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { Test } from "@nestjs/testing";
import request from "supertest";

// 仅做路由 / 委派验证，service 全部 mock（无 DB）。
// 用与 @meshbot/main 同名的 class token 注册 mock。
import { AgentDeviceController } from "../src/rest/agent-device.controller";
import type { JwtMainPayload } from "../src/auth/jwt.strategy";
import { ImController } from "../src/rest/im.controller";

/**
 * 三端点覆盖两个 controller（ImController 的 agent-dms / devices/:id/online 走浏览器 JWT，
 * AgentDeviceController 的 agent/conversations 走 device token），每条用例需要不同的
 * req.user 形态，故不像 device-auth-controller.routes.spec.ts 固定单一 TEST_USER，
 * 改用可变 currentUser + FakeAuthGuard 动态读取。
 */
let currentUser: JwtMainPayload;

class FakeAuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    ctx.switchToHttp().getRequest().user = currentUser;
    return true;
  }
}

describe("Agent-DM REST 路由编排", () => {
  let app: INestApplication;
  let agentDeviceController: AgentDeviceController;
  let conversation: { [k: string]: jest.Mock };
  let devicePresence: { [k: string]: jest.Mock };

  beforeEach(async () => {
    conversation = {
      findOrCreateAgentDm: jest.fn().mockResolvedValue({
        id: "conv-1",
        type: "dm",
        visibility: "private",
        name: null,
        peer: { userId: "agent:d-1", displayName: "Mac", email: "" },
        unreadCount: 0,
        lastMessage: null,
        agentDeviceId: "d-1",
      }),
      listAgentDmsForDevice: jest
        .fn()
        .mockResolvedValue([{ conversationId: "conv-1", orgId: "org-1" }]),
    };
    devicePresence = {
      isOnline: jest.fn().mockResolvedValue(true),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [ImController, AgentDeviceController],
      providers: [
        { provide: ConversationService, useValue: conversation },
        { provide: MessageService, useValue: {} },
        { provide: MembershipService, useValue: {} },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        { provide: DevicePresenceService, useValue: devicePresence },
        { provide: APP_GUARD, useClass: FakeAuthGuard },
      ],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    agentDeviceController = moduleRef.get(AgentDeviceController);
  });

  afterEach(async () => {
    await app.close();
  });

  it("POST /agent-dms → 编排 conversation.findOrCreateAgentDm(orgId, userId, deviceId)", async () => {
    currentUser = { userId: "u-1", email: "u@x.io", orgId: "org-1" };

    const res = await request(app.getHttpServer())
      .post("/agent-dms")
      .send({ deviceId: "d-1" })
      .expect(201);

    expect(conversation.findOrCreateAgentDm).toHaveBeenCalledWith(
      "org-1",
      "u-1",
      "d-1",
    );
    expect(res.body).toEqual({
      id: "conv-1",
      type: "dm",
      visibility: "private",
      name: null,
      peer: { userId: "agent:d-1", displayName: "Mac", email: "" },
      unreadCount: 0,
      lastMessage: null,
      agentDeviceId: "d-1",
    });
  });

  it("GET /devices/:id/online → 编排 devicePresence.isOnline(orgId, id)", async () => {
    currentUser = { userId: "u-1", email: "u@x.io", orgId: "org-1" };

    const res = await request(app.getHttpServer())
      .get("/devices/d-1/online")
      .expect(200);

    expect(devicePresence.isOnline).toHaveBeenCalledWith("org-1", "d-1");
    expect(res.body).toEqual({ online: true });
  });

  it("GET /agent/conversations（device token）→ 编排 conversation.listAgentDmsForDevice(deviceId)", async () => {
    currentUser = {
      userId: "u-1",
      email: "u@x.io",
      orgId: "org-1",
      deviceId: "d-1",
    };

    const res = await request(app.getHttpServer())
      .get("/agent/conversations")
      .expect(200);

    expect(conversation.listAgentDmsForDevice).toHaveBeenCalledWith("d-1");
    expect(res.body).toEqual([{ conversationId: "conv-1", orgId: "org-1" }]);
  });

  it("GET /agent/conversations 无 deviceId（浏览器 JWT 误用）→ FORBIDDEN(403)，不触发任何查询", async () => {
    // 路由 spec 未挂全局 ErrorsFilter（依赖 I18nService，此处未装配），403 语义
    // 在 AppError.errorCode 上断言，与 device-auth-controller.routes.spec.ts 的
    // switchOrg 用例同策略（CommonErrorCode.FORBIDDEN 的 httpStatus=403 由 ErrorsFilter 映射）。
    await expect(
      agentDeviceController.listConversations({
        userId: "u-1",
        email: "u@x.io",
        orgId: "org-1",
      }),
    ).rejects.toMatchObject({ errorCode: CommonErrorCode.FORBIDDEN });

    expect(conversation.listAgentDmsForDevice).not.toHaveBeenCalled();
  });
});
