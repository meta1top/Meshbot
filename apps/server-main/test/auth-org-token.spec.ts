/**
 * SP-0 Task 1 降级单测（Postgres 不可达时替代 e2e）
 *
 * 覆盖：
 * 1. JwtMainStrategy.validate() 返回含 orgId 字段
 * 2. AuthController.signResponse 把 activeOrgId 签进 JWT payload
 */
import "reflect-metadata";
import type { CanActivate, ExecutionContext } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { JwtModule, JwtService } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { Test } from "@nestjs/testing";

import { JwtMainStrategy, type JwtMainPayload } from "../src/auth/jwt.strategy";
import { APP_CONFIG } from "../src/config/app-config.schema";
import { EMAIL_SENDER } from "../src/email/email-sender";
import { AuthController } from "../src/rest/auth.controller";

import { AppError } from "@meshbot/common";
import {
  EmailVerificationService,
  MainErrorCode,
  MembershipService,
  SwitchOrgDto,
  UserService,
} from "@meshbot/main";

const TEST_SECRET = "unit-test-secret";

const TEST_APP_CONFIG = {
  jwt: { secret: TEST_SECRET, expires: "1h" },
} as const;

/** 跳过 JWT 鉴权的假守卫（不影响 signResponse 测试） */
class BypassAuthGuard implements CanActivate {
  canActivate(_ctx: ExecutionContext): boolean {
    return true;
  }
}

// ──────────────────────────────────────────────
// 1. JwtMainStrategy.validate() 含 orgId
// ──────────────────────────────────────────────
describe("JwtMainStrategy.validate()", () => {
  it("payload 含 orgId=null 时原样返回 orgId:null", () => {
    const strategy = new JwtMainStrategy(
      TEST_APP_CONFIG as Parameters<
        typeof JwtMainStrategy.prototype.constructor
      >[0],
    );
    const payload: JwtMainPayload = {
      userId: "u-001",
      email: "user@test.io",
      orgId: null,
    };
    const result = strategy.validate(payload);
    expect(result.orgId).toBeNull();
    expect(result.userId).toBe("u-001");
    expect(result.email).toBe("user@test.io");
  });

  it("payload 含 orgId='o-999' 时原样返回", () => {
    const strategy = new JwtMainStrategy(
      TEST_APP_CONFIG as Parameters<
        typeof JwtMainStrategy.prototype.constructor
      >[0],
    );
    const payload: JwtMainPayload = {
      userId: "u-001",
      email: "user@test.io",
      orgId: "o-999",
    };
    const result = strategy.validate(payload);
    expect(result.orgId).toBe("o-999");
  });

  it("payload 缺少 orgId（旧 token）时返回 orgId:null", () => {
    const strategy = new JwtMainStrategy(
      TEST_APP_CONFIG as Parameters<
        typeof JwtMainStrategy.prototype.constructor
      >[0],
    );
    // 模拟旧 payload（不含 orgId）
    const payload = {
      userId: "u-001",
      email: "user@test.io",
    } as JwtMainPayload;
    const result = strategy.validate(payload);
    expect(result.orgId).toBeNull();
  });
});

// ──────────────────────────────────────────────
// 2. AuthController 签 token 含 orgId
// ──────────────────────────────────────────────
describe("AuthController signResponse 签入 orgId", () => {
  let usersMock: {
    registerUser: jest.Mock;
    loginUser: jest.Mock;
    findByEmail: jest.Mock;
    markEmailVerified: jest.Mock;
  };
  let membershipsMock: { listOrgsForUser: jest.Mock };
  let emailVerificationMock: { issueCode: jest.Mock; verifyCode: jest.Mock };
  let emailSenderMock: {
    sendInvitation: jest.Mock;
    sendVerificationCode: jest.Mock;
  };

  beforeEach(() => {
    usersMock = {
      registerUser: jest.fn(),
      loginUser: jest.fn(),
      findByEmail: jest.fn(),
      markEmailVerified: jest.fn().mockResolvedValue(undefined),
    };
    membershipsMock = {
      listOrgsForUser: jest.fn().mockResolvedValue([]),
    };
    emailVerificationMock = {
      issueCode: jest.fn().mockResolvedValue("123456"),
      verifyCode: jest.fn().mockResolvedValue(undefined),
    };
    emailSenderMock = {
      sendInvitation: jest.fn().mockResolvedValue(undefined),
      sendVerificationCode: jest.fn().mockResolvedValue(undefined),
    };
  });

  // register 改造后不再签 token（发验证码 + 返回 { needVerify: true }），
  // 签 token 的职责转移到 verify-email —— 这里覆盖的是 verify-email 的编排。
  it("verify-email 返回的 token 含 orgId=null（用户未建组织）", async () => {
    const fakeUser = {
      id: "u-100",
      email: "reg@test.io",
      displayName: "Reg User",
      activeOrgId: null,
      passwordHash: "hash",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    usersMock.findByEmail.mockResolvedValue(fakeUser);

    const moduleRef = await Test.createTestingModule({
      imports: [
        PassportModule,
        JwtModule.register({
          secret: TEST_SECRET,
          signOptions: { expiresIn: "1h" },
        }),
      ],
      controllers: [AuthController],
      providers: [
        { provide: APP_CONFIG, useValue: TEST_APP_CONFIG },
        { provide: UserService, useValue: usersMock },
        { provide: MembershipService, useValue: membershipsMock },
        { provide: EmailVerificationService, useValue: emailVerificationMock },
        { provide: EMAIL_SENDER, useValue: emailSenderMock },
        { provide: APP_GUARD, useClass: BypassAuthGuard },
        JwtMainStrategy,
      ],
    }).compile();

    const controller = moduleRef.get(AuthController);
    const jwtSvc = moduleRef.get(JwtService);

    const result = await controller.verifyEmail({
      email: "reg@test.io",
      code: "123456",
    } as Parameters<typeof controller.verifyEmail>[0]);
    const decoded = jwtSvc.decode(result.token) as JwtMainPayload;

    expect(emailVerificationMock.verifyCode).toHaveBeenCalledWith(
      "reg@test.io",
      "123456",
    );
    expect(usersMock.markEmailVerified).toHaveBeenCalledWith("u-100");
    expect(decoded.orgId).toBeNull();
    expect(decoded.userId).toBe("u-100");
    expect(decoded.email).toBe("reg@test.io");
  });

  it("login 返回的 token 含 orgId='o-42'（用户已有活跃组织）", async () => {
    const fakeUser = {
      id: "u-200",
      email: "login@test.io",
      displayName: "Login User",
      activeOrgId: "o-42",
      passwordHash: "hash",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    usersMock.loginUser.mockResolvedValue(fakeUser);

    const moduleRef = await Test.createTestingModule({
      imports: [
        PassportModule,
        JwtModule.register({
          secret: TEST_SECRET,
          signOptions: { expiresIn: "1h" },
        }),
      ],
      controllers: [AuthController],
      providers: [
        { provide: APP_CONFIG, useValue: TEST_APP_CONFIG },
        { provide: UserService, useValue: usersMock },
        { provide: MembershipService, useValue: membershipsMock },
        { provide: EmailVerificationService, useValue: emailVerificationMock },
        { provide: EMAIL_SENDER, useValue: emailSenderMock },
        { provide: APP_GUARD, useClass: BypassAuthGuard },
        JwtMainStrategy,
      ],
    }).compile();

    const controller = moduleRef.get(AuthController);
    const jwtSvc = moduleRef.get(JwtService);

    const result = await controller.login({
      email: "login@test.io",
      password: "pw123456",
    } as Parameters<typeof controller.login>[0]);
    const decoded = jwtSvc.decode(result.token) as JwtMainPayload;

    expect(decoded.orgId).toBe("o-42");
  });
});

// ──────────────────────────────────────────────
// 3. AuthController.switchOrg 降级单测（Postgres 不可达，替代 e2e）
// ──────────────────────────────────────────────
describe("AuthController.switchOrg", () => {
  const TEST_USER_ID = "u-300";
  const ORG_A = "o-100";
  const ORG_B = "o-200";

  const fakeUser = {
    id: TEST_USER_ID,
    email: "switch@test.io",
    displayName: "Switch User",
    activeOrgId: ORG_A,
    passwordHash: "hash",
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  let usersMock: {
    registerUser: jest.Mock;
    loginUser: jest.Mock;
    findById: jest.Mock;
    setActiveOrg: jest.Mock;
  };
  let membershipsMock: {
    listOrgsForUser: jest.Mock;
    assertMember: jest.Mock;
  };

  beforeEach(() => {
    usersMock = {
      registerUser: jest.fn(),
      loginUser: jest.fn(),
      findById: jest.fn().mockResolvedValue(fakeUser),
      setActiveOrg: jest.fn().mockResolvedValue(undefined),
    };
    membershipsMock = {
      listOrgsForUser: jest.fn().mockResolvedValue([]),
      assertMember: jest.fn().mockResolvedValue(undefined),
    };
  });

  async function buildController() {
    const moduleRef = await Test.createTestingModule({
      imports: [
        PassportModule,
        JwtModule.register({
          secret: TEST_SECRET,
          signOptions: { expiresIn: "1h" },
        }),
      ],
      controllers: [AuthController],
      providers: [
        { provide: APP_CONFIG, useValue: TEST_APP_CONFIG },
        { provide: UserService, useValue: usersMock },
        { provide: MembershipService, useValue: membershipsMock },
        {
          provide: EmailVerificationService,
          useValue: { issueCode: jest.fn(), verifyCode: jest.fn() },
        },
        {
          provide: EMAIL_SENDER,
          useValue: {
            sendInvitation: jest.fn(),
            sendVerificationCode: jest.fn(),
          },
        },
      ],
    }).compile();

    return {
      controller: moduleRef.get(AuthController),
      jwtSvc: moduleRef.get(JwtService),
    };
  }

  it("非成员 orgId → assertMember 抛 ORG_FORBIDDEN", async () => {
    membershipsMock.assertMember.mockRejectedValue(
      new AppError(MainErrorCode.ORG_FORBIDDEN),
    );

    const { controller } = await buildController();
    const jwt: JwtMainPayload = {
      userId: TEST_USER_ID,
      email: "switch@test.io",
      orgId: ORG_A,
    };

    await expect(
      controller.switchOrg(jwt, { orgId: ORG_B } as SwitchOrgDto),
    ).rejects.toMatchObject({ errorCode: MainErrorCode.ORG_FORBIDDEN });
  });

  it("成员 → setActiveOrg 被调用 + 返回 token 含新 orgId", async () => {
    const updatedUser = { ...fakeUser, activeOrgId: ORG_B };
    usersMock.findById.mockResolvedValue(updatedUser);

    const { controller, jwtSvc } = await buildController();
    const jwt: JwtMainPayload = {
      userId: TEST_USER_ID,
      email: "switch@test.io",
      orgId: ORG_A,
    };

    const result = await controller.switchOrg(jwt, {
      orgId: ORG_B,
    } as SwitchOrgDto);

    expect(membershipsMock.assertMember).toHaveBeenCalledWith(
      ORG_B,
      TEST_USER_ID,
    );
    expect(usersMock.setActiveOrg).toHaveBeenCalledWith(TEST_USER_ID, ORG_B);
    const decoded = jwtSvc.decode(result.token) as JwtMainPayload;
    expect(decoded.orgId).toBe(ORG_B);
  });
});
