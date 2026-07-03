import { AppError, ErrorsFilter, ResponseInterceptor } from "@meshbot/common";
import { DeviceService, MainErrorCode, UserService } from "@meshbot/main";
import { Controller, Get, type INestApplication } from "@nestjs/common";
import { APP_GUARD, Reflector } from "@nestjs/core";
import { JwtModule, JwtService } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { Test } from "@nestjs/testing";
import type { I18nService } from "nestjs-i18n";
import request from "supertest";

import { CurrentUser } from "../src/auth/current-user.decorator";
import { JwtAuthGuard } from "../src/auth/jwt-auth.guard";
import { type JwtMainPayload, JwtMainStrategy } from "../src/auth/jwt.strategy";
import { type AppConfig, APP_CONFIG } from "../src/config/app-config.schema";

// 双凭据认证守卫测试：JwtAuthGuard 同时接受浏览器 JWT 与 Agent device token
// （`mbd_` 前缀）。DeviceService / UserService 全部 mock（无 DB）。

const JWT_SECRET = "device-token-guard-test-secret";

const TEST_APP_CONFIG = {
  jwt: { secret: JWT_SECRET, expires: "1h" },
} as AppConfig;

/** i18n 桩：tryTranslate 里 translate 抛错时会 fallback 原 key，这里直接回显 key。 */
const I18N_STUB = {
  translate: (key: string) => key,
} as unknown as I18nService;

@Controller()
class WhoamiController {
  @Get("whoami")
  whoami(@CurrentUser() u: JwtMainPayload): JwtMainPayload {
    return u;
  }
}

describe("JwtAuthGuard 双凭据认证（device token + 用户 JWT）", () => {
  let app: INestApplication;
  let jwtService: JwtService;
  let devices: { verifyToken: jest.Mock };
  let users: { findById: jest.Mock };

  beforeAll(async () => {
    devices = {
      verifyToken: jest.fn().mockImplementation(async (token: string) => {
        if (token === "mbd_good") {
          return { id: "d1", userId: "u1", orgId: "o1", revokedAt: null };
        }
        throw new AppError(MainErrorCode.DEVICE_TOKEN_INVALID);
      }),
    };
    users = {
      findById: jest.fn().mockResolvedValue({ id: "u1", email: "a@x.io" }),
    };

    const moduleRef = await Test.createTestingModule({
      imports: [
        PassportModule,
        JwtModule.register({
          secret: JWT_SECRET,
          signOptions: { expiresIn: "1h" },
        }),
      ],
      controllers: [WhoamiController],
      providers: [
        { provide: APP_CONFIG, useValue: TEST_APP_CONFIG },
        { provide: DeviceService, useValue: devices },
        { provide: UserService, useValue: users },
        JwtMainStrategy,
        { provide: APP_GUARD, useClass: JwtAuthGuard },
      ],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    const reflector = app.get(Reflector);
    app.useGlobalInterceptors(new ResponseInterceptor(reflector));
    app.useGlobalFilters(new ErrorsFilter(I18N_STUB));
    await app.init();
    jwtService = moduleRef.get(JwtService);
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it("Bearer mbd_good → 200，payload = {userId,email,orgId,deviceId}", async () => {
    const res = await request(app.getHttpServer())
      .get("/whoami")
      .set("Authorization", "Bearer mbd_good")
      .expect(200);

    expect(devices.verifyToken).toHaveBeenCalledWith("mbd_good");
    expect(users.findById).toHaveBeenCalledWith("u1");
    expect(res.body.data).toEqual({
      userId: "u1",
      email: "a@x.io",
      orgId: "o1",
      deviceId: "d1",
    });
  });

  it("Bearer mbd_bad → 401（DEVICE_TOKEN_INVALID）", async () => {
    const res = await request(app.getHttpServer())
      .get("/whoami")
      .set("Authorization", "Bearer mbd_bad")
      .expect(401);

    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe(MainErrorCode.DEVICE_TOKEN_INVALID.code);
  });

  it("常规用户 JWT 仍然工作 → 200", async () => {
    const token = jwtService.sign({
      userId: "u2",
      email: "b@x.io",
      orgId: "o2",
    });

    const res = await request(app.getHttpServer())
      .get("/whoami")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(res.body.data).toEqual({
      userId: "u2",
      email: "b@x.io",
      orgId: "o2",
    });
    // 用户 JWT 不应触碰 DeviceService
    expect(devices.verifyToken).not.toHaveBeenCalledWith(token);
  });

  it("无凭据 → 401", async () => {
    await request(app.getHttpServer()).get("/whoami").expect(401);
  });
});
