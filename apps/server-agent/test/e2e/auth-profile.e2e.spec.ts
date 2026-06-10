import "reflect-metadata";
import path from "node:path";
import { ErrorsFilter, TxTypeOrmModule } from "@meshbot/common";
import { type INestApplication } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { Test } from "@nestjs/testing";
import { TypeOrmModule } from "@nestjs/typeorm";
import { I18nJsonLoader, I18nModule, I18nService } from "nestjs-i18n";
import request from "supertest";
import { CloudClientService } from "../../src/cloud/cloud-client.service";
import { AuthController } from "../../src/controllers/auth.controller";
import { CloudIdentity } from "../../src/entities/cloud-identity.entity";
import { JwtAuthGuard } from "../../src/guards/jwt-auth.guard";
import { CloudAuthService } from "../../src/services/cloud-auth.service";
import { CloudIdentityService } from "../../src/services/cloud-identity.service";
import { JWT_SECRET, JwtStrategy } from "../../src/strategies/jwt.strategy";

/** 云端代理 auth e2e：桩掉 CloudClientService，验证镜像写入 + 本地 JWT 守卫。 */
describe("Auth profile e2e（云端代理）", () => {
  let app: INestApplication;
  let token: string;

  const cloudStub = {
    post: jest.fn().mockResolvedValue({
      token: "cloud-jwt",
      expiresIn: "7d",
      user: { id: "u1", email: "alice@x.io", displayName: "Alice" },
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
        JwtStrategy,
        { provide: CloudClientService, useValue: cloudStub },
        { provide: APP_GUARD, useClass: JwtAuthGuard },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    // 对齐 main.ts：ErrorsFilter 把 AppError 映射成 errorCode.httpStatus
    app.useGlobalFilters(new ErrorsFilter(app.get(I18nService)));
    await app.init();

    const reg = await request(app.getHttpServer())
      .post("/api/auth/login")
      .send({ email: "alice@x.io", password: "pw123456" });
    token = reg.body.access_token;
  });

  afterAll(async () => {
    await app.close();
  });

  it("POST /api/auth/login 代理云端并返回本地 access_token", () => {
    expect(typeof token).toBe("string");
    expect(cloudStub.post).toHaveBeenCalledWith("/api/auth/login", {
      email: "alice@x.io",
      password: "pw123456",
    });
    expect(cloudStub.get).toHaveBeenCalledWith(
      "/api/auth/profile",
      "cloud-jwt",
    );
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

  it("GET /api/auth/profile —— JWT 有效但身份镜像已清空返回 401", async () => {
    // 登出 / 云端 401 处理器清镜像后，本地 JWT 仍有效但 profile 必须 401
    await app.get(CloudIdentityService).clear();

    await request(app.getHttpServer())
      .get("/api/auth/profile")
      .set("Authorization", `Bearer ${token}`)
      .expect(401);
  });
});
