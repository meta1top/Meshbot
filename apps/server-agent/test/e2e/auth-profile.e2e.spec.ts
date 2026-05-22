import "reflect-metadata";
import path from "node:path";
import { ErrorsFilter, TxTypeOrmModule } from "@meshbot/common";
import { type INestApplication } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { Test } from "@nestjs/testing";
import { getRepositoryToken, TypeOrmModule } from "@nestjs/typeorm";
import { I18nJsonLoader, I18nModule, I18nService } from "nestjs-i18n";
import request from "supertest";
import type { Repository } from "typeorm";
import { AuthController } from "../../src/controllers/auth.controller";
import { User } from "../../src/entities/user.entity";
import { JwtAuthGuard } from "../../src/guards/jwt-auth.guard";
import { AuthService } from "../../src/services/auth.service";
import { JWT_SECRET, JwtStrategy } from "../../src/strategies/jwt.strategy";

describe("Auth profile e2e", () => {
  let app: INestApplication;
  let token: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: "better-sqlite3",
          database: ":memory:",
          entities: [User],
          synchronize: true,
        }),
        TxTypeOrmModule.forFeature([User]),
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
        AuthService,
        JwtStrategy,
        { provide: APP_GUARD, useClass: JwtAuthGuard },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    // 对齐 main.ts：ErrorsFilter 把 AppError 映射成 errorCode.httpStatus
    app.useGlobalFilters(new ErrorsFilter(app.get(I18nService)));
    await app.init();

    const reg = await request(app.getHttpServer())
      .post("/api/auth/register")
      .send({ username: "alice", password: "pw123456" });
    token = reg.body.access_token;
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /api/auth/profile 无 token 返回 401", async () => {
    await request(app.getHttpServer()).get("/api/auth/profile").expect(401);
  });

  it("GET /api/auth/profile 有效 token 返回当前用户", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/auth/profile")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(res.body.username).toBe("alice");
    expect(typeof res.body.id).toBe("string");
  });

  it("GET /api/auth/profile 无效 token 返回 401", async () => {
    await request(app.getHttpServer())
      .get("/api/auth/profile")
      .set("Authorization", "Bearer not-a-valid-jwt")
      .expect(401);
  });

  it("GET /api/auth/profile —— JWT 有效但用户已删除返回 401", async () => {
    // 仅允许一个用户注册，复用 beforeAll 的 alice token，删库后再请求
    const userRepo = app.get<Repository<User>>(getRepositoryToken(User));
    await userRepo.clear();

    await request(app.getHttpServer())
      .get("/api/auth/profile")
      .set("Authorization", `Bearer ${token}`)
      .expect(401);
  });
});
