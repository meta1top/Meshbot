import type {
  CanActivate,
  ExecutionContext,
  INestApplication,
} from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { EMAIL_SENDER, type EmailSender } from "../src/email/email-sender";
import { OrgController } from "../src/rest/org.controller";

// 仅做路由 / 委派验证，service 全部 mock（无 DB）。
// 用与 @meshbot/main 同名的 class token 注册 mock。
import {
  InvitationService,
  MembershipService,
  OrgService,
  UserService,
} from "@meshbot/main";

const TEST_USER = { userId: "u-1", email: "owner@x.io" };

/** 测试用守卫：模拟全局 JwtAuthGuard 注入 req.user。 */
class FakeAuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    ctx.switchToHttp().getRequest().user = TEST_USER;
    return true;
  }
}

describe("OrgController 路由顺序与邮件失败语义", () => {
  let app: INestApplication;
  let orgs: { [k: string]: jest.Mock };
  let memberships: { [k: string]: jest.Mock };
  let invitations: { [k: string]: jest.Mock };
  let users: { [k: string]: jest.Mock };
  let email: { sendInvitation: jest.Mock };

  beforeEach(async () => {
    orgs = {
      persistNewOrg: jest.fn(),
      assertOwner: jest.fn().mockResolvedValue(undefined),
      getOrgOrThrow: jest.fn().mockResolvedValue({ id: "o-1", name: "Acme" }),
    };
    memberships = {
      listOrgsForUser: jest.fn().mockResolvedValue([]),
      listMembers: jest.fn().mockResolvedValue([]),
      isMember: jest.fn().mockResolvedValue(true),
    };
    invitations = {
      createInvitation: jest.fn().mockResolvedValue({
        id: "i-1",
        email: "new@x.io",
        status: "pending",
        token: "tok-abc",
        expiresAt: new Date("2026-07-01T00:00:00Z"),
        createdAt: new Date("2026-06-10T00:00:00Z"),
      }),
      listPending: jest.fn().mockResolvedValue([]),
      revoke: jest.fn(),
      findById: jest.fn(),
      acceptInvitation: jest
        .fn()
        .mockResolvedValue({ orgId: "o-1", orgName: "Acme" }),
    };
    users = {
      findById: jest
        .fn()
        .mockResolvedValue({ id: "u-1", displayName: "Owner" }),
    };
    email = { sendInvitation: jest.fn().mockResolvedValue(undefined) };

    const moduleRef = await Test.createTestingModule({
      controllers: [OrgController],
      providers: [
        { provide: OrgService, useValue: orgs },
        { provide: MembershipService, useValue: memberships },
        { provide: InvitationService, useValue: invitations },
        { provide: UserService, useValue: users },
        { provide: EMAIL_SENDER, useValue: email satisfies EmailSender },
        { provide: APP_GUARD, useClass: FakeAuthGuard },
      ],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it("POST /orgs/invitations/accept 命中 accept（静态段优先于 :id 参数路由）", async () => {
    const res = await request(app.getHttpServer())
      .post("/orgs/invitations/accept")
      .send({ token: "tok-abc" })
      .expect(201);

    expect(res.body).toEqual({ orgId: "o-1", orgName: "Acme" });
    expect(invitations.acceptInvitation).toHaveBeenCalledWith(
      "tok-abc",
      TEST_USER.userId,
    );
    // 关键：没有被 @Post(":id/invitations") 以 id="invitations" 截获
    expect(orgs.assertOwner).not.toHaveBeenCalled();
    expect(invitations.createInvitation).not.toHaveBeenCalled();
  });

  it("POST /orgs/:id/invitations 仍正常命中 invite（参数路由不受 accept 影响）", async () => {
    const res = await request(app.getHttpServer())
      .post("/orgs/o-1/invitations")
      .send({ email: "new@x.io" })
      .expect(201);

    expect(orgs.assertOwner).toHaveBeenCalledWith("o-1", TEST_USER.userId);
    expect(invitations.createInvitation).toHaveBeenCalledWith(
      "o-1",
      TEST_USER.userId,
      "new@x.io",
    );
    expect(email.sendInvitation).toHaveBeenCalledWith(
      "new@x.io",
      expect.objectContaining({ orgName: "Acme", code: "tok-abc" }),
    );
    expect(res.body.token).toBe("tok-abc");
  });

  it("邀请邮件发送失败不影响邀请创建（仍返回 201 + 摘要）", async () => {
    email.sendInvitation.mockRejectedValue(new Error("smtp down"));

    const res = await request(app.getHttpServer())
      .post("/orgs/o-1/invitations")
      .send({ email: "new@x.io" })
      .expect(201);

    expect(res.body.id).toBe("i-1");
    expect(res.body.token).toBe("tok-abc");
  });
});
