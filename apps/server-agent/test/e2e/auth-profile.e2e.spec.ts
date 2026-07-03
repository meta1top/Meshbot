import "reflect-metadata";
import path from "node:path";
import { AccountContextService } from "@meshbot/agent";
import { ErrorsFilter, TxTypeOrmModule } from "@meshbot/common";
import { type INestApplication } from "@nestjs/common";
import { APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { EventEmitterModule } from "@nestjs/event-emitter";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { Test } from "@nestjs/testing";
import { TypeOrmModule } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { I18nJsonLoader, I18nModule, I18nService } from "nestjs-i18n";
import request from "supertest";
import { AccountContextInterceptor } from "../../src/account/account-context.interceptor";
import { AccountRuntimeRegistry } from "../../src/account/account-runtime.registry";
import { CloudClientService } from "../../src/cloud/cloud-client.service";
import { AuthController } from "../../src/controllers/auth.controller";
import { CloudIdentity } from "../../src/entities/cloud-identity.entity";
import { JwtAuthGuard } from "../../src/guards/jwt-auth.guard";
import { CloudAuthService } from "../../src/services/cloud-auth.service";
import { CloudIdentityService } from "../../src/services/cloud-identity.service";
import { CloudMetaService } from "../../src/services/cloud-meta.service";
import { DeviceAuthorizeService } from "../../src/services/device-authorize.service";
import { JWT_SECRET, JwtStrategy } from "../../src/strategies/jwt.strategy";

/** 浏览器授权登录 e2e：桩掉 CloudClientService，验证 start/complete/poll + 本地 JWT 守卫。 */
describe("Auth profile e2e（浏览器授权登录）", () => {
  let app: INestApplication;
  let token: string;

  const cloudStub = {
    post: jest.fn(async (p: string) => {
      if (p === "/api/device-auth/start") {
        return {
          requestId: "req-1",
          verifyUrl: "http://cloud/authorize?request=req-1",
        };
      }
      if (p === "/api/device-auth/exchange") {
        return {
          deviceToken: "mbd_tok",
          user: { id: "u1", email: "alice@x.io", displayName: "Alice" },
          orgId: "o1",
        };
      }
      throw new Error(`unexpected post ${p}`);
    }),
    get: jest.fn().mockResolvedValue({
      user: { id: "u1", email: "alice@x.io", displayName: "Alice" },
      activeOrg: { id: "o1", name: "Acme", role: "owner" },
      memberships: [{ id: "o1", name: "Acme", role: "owner" }],
    }),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: "better-sqlite3",
          database: ":memory:",
          entities: [CloudIdentity],
          synchronize: true,
        }),
        TxTypeOrmModule.forFeature([CloudIdentity]),
        PassportModule,
        JwtModule.register({
          secret: JWT_SECRET,
          signOptions: { expiresIn: "7d" },
        }),
        EventEmitterModule.forRoot(),
        I18nModule.forRoot({
          fallbackLanguage: "zh",
          loader: I18nJsonLoader,
          loaderOptions: {
            path: path.join(__dirname, "../../i18n"),
          },
        }),
      ],
      controllers: [AuthController],
      providers: [
        CloudIdentityService,
        CloudAuthService,
        DeviceAuthorizeService,
        CloudMetaService,
        JwtStrategy,
        // v3：profile 路由按账号读镜像，需账号上下文（拦截器在 JWT 守卫后注入 sub）
        AccountContextService,
        { provide: CloudClientService, useValue: cloudStub },
        // T4.2：CloudAuthService 现在依赖 AccountRuntimeRegistry，桩掉避免完整初始化
        {
          provide: AccountRuntimeRegistry,
          useValue: {
            createRuntime: jest.fn().mockResolvedValue(undefined),
            teardownRuntime: jest.fn().mockResolvedValue(undefined),
            has: jest.fn().mockReturnValue(false),
          },
        },
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_INTERCEPTOR, useClass: AccountContextInterceptor },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    // 对齐 main.ts：ErrorsFilter 把 AppError 映射成 errorCode.httpStatus
    app.useGlobalFilters(new ErrorsFilter(app.get(I18nService)));
    await app.init();

    const started = await request(app.getHttpServer())
      .post("/api/auth/authorize/start")
      .send({});
    const requestId: string = started.body.requestId;

    await request(app.getHttpServer())
      .get("/api/auth/callback")
      .query({ request: requestId, code: "user-code-1" })
      .expect(200);

    const polled = await request(app.getHttpServer())
      .post("/api/auth/authorize/poll")
      .send({ requestId });
    token = polled.body.access_token;
  });

  afterAll(async () => {
    await app.close();
  });

  it("start → callback → poll 完成浏览器授权登录并返回本地 access_token", () => {
    expect(typeof token).toBe("string");
    expect(cloudStub.post).toHaveBeenCalledWith(
      "/api/device-auth/start",
      expect.objectContaining({ codeChallenge: expect.any(String) }),
    );
    expect(cloudStub.post).toHaveBeenCalledWith(
      "/api/device-auth/exchange",
      expect.objectContaining({ requestId: "req-1", userCode: "user-code-1" }),
    );
    expect(cloudStub.get).toHaveBeenCalledWith("/api/auth/profile", "mbd_tok");
  });

  it("GET /api/auth/profile 无 token 返回 401", async () => {
    await request(app.getHttpServer()).get("/api/auth/profile").expect(401);
  });

  it("GET /api/auth/profile 有效 token 返回镜像里的当前用户", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/auth/profile")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(res.body.email).toBe("alice@x.io");
    expect(res.body.id).toBe("u1");
    expect(res.body.org).toEqual({ id: "o1", name: "Acme", role: "owner" });
  });

  it("GET /api/auth/profile 无效 token 返回 401", async () => {
    await request(app.getHttpServer())
      .get("/api/auth/profile")
      .set("Authorization", "Bearer not-a-valid-jwt")
      .expect(401);
  });

  it("GET /api/auth/profile —— JWT 有效但身份镜像已删除返回 401", async () => {
    // v3：镜像行被删除（如另端清理）后，本地 JWT 仍有效但 profile 必须 401。
    // JWT sub = cloudUserId = 'u1'（兑换响应里的 user.id）。
    await app.get(DataSource).getRepository(CloudIdentity).delete({
      cloudUserId: "u1",
    });

    await request(app.getHttpServer())
      .get("/api/auth/profile")
      .set("Authorization", `Bearer ${token}`)
      .expect(401);
  });
});
