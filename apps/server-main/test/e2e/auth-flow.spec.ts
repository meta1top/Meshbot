import "reflect-metadata";
import path from "node:path";
import {
  CommonModule,
  I18nExceptionFilter,
  I18nZodValidationPipe,
} from "@meshbot/common";
import { MainModule } from "@meshbot/main";
import type { INestApplication } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_GUARD } from "@nestjs/core";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { Test } from "@nestjs/testing";
import { TypeOrmModule } from "@nestjs/typeorm";
import {
  AcceptLanguageResolver,
  HeaderResolver,
  I18nJsonLoader,
  I18nModule,
  I18nService,
} from "nestjs-i18n";
import request from "supertest";

import { JwtAuthGuard } from "../../src/auth/jwt-auth.guard";
import { JwtMainStrategy } from "../../src/auth/jwt.strategy";
import { AuthController } from "../../src/rest/auth.controller";
import {
  createTestDb,
  isPostgresReachable,
  type TestDbContext,
} from "../setup/test-db";

const I18N_PATH = path.join(__dirname, "..", "..", "i18n");

describe("server-main auth e2e (register + login)", () => {
  let app: INestApplication;
  let dbCtx: TestDbContext | null = null;
  let skipReason: string | null = null;

  beforeAll(async () => {
    const reachable = await isPostgresReachable();
    if (!reachable) {
      skipReason = "Postgres unreachable; run `pnpm dev:db:up` to enable e2e";
      console.warn(`[auth-flow] ${skipReason}`);
      return;
    }
    dbCtx = await createTestDb();

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ JWT_SECRET: "e2e-test-secret", JWT_EXPIRES: "1h" })],
        }),
        CommonModule.forRoot(),
        I18nModule.forRoot({
          fallbackLanguage: "zh",
          loader: I18nJsonLoader,
          loaderOptions: { path: I18N_PATH },
          resolvers: [
            new HeaderResolver(["x-lang"]),
            new AcceptLanguageResolver(),
          ],
        }),
        TypeOrmModule.forRoot(dbCtx.dataSourceOptions),
        PassportModule,
        JwtModule.register({
          secret: "e2e-test-secret",
          signOptions: { expiresIn: "1h" },
        }),
        MainModule,
      ],
      controllers: [AuthController],
      providers: [
        JwtMainStrategy,
        { provide: APP_GUARD, useClass: JwtAuthGuard },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix("api");
    const i18n = app.get(I18nService);
    app.useGlobalPipes(new I18nZodValidationPipe(i18n));
    app.useGlobalFilters(new I18nExceptionFilter(i18n));
    await app.init();
  }, 30_000);

  afterAll(async () => {
    if (app) await app.close();
    if (dbCtx) await dbCtx.cleanup();
  });

  function maybeSkip() {
    if (skipReason) {
      console.warn(`[auth-flow] skipping: ${skipReason}`);
      return true;
    }
    return false;
  }

  const ALICE = {
    email: "alice@test.io",
    password: "alicepass1",
    displayName: "Alice",
  };

  it("POST /auth/register — 注册成功返回 token + user", async () => {
    if (maybeSkip()) return;
    const res = await request(app.getHttpServer())
      .post("/api/auth/register")
      .send(ALICE);
    expect(res.status).toBe(201);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user).toMatchObject({
      email: ALICE.email,
      displayName: ALICE.displayName,
    });
    expect(res.body.user.id).toBeTruthy();
  });

  it("POST /auth/register — 同 email 二次注册抛 409 + 中文 i18n", async () => {
    if (maybeSkip()) return;
    const res = await request(app.getHttpServer())
      .post("/api/auth/register")
      .send(ALICE);
    expect(res.status).toBe(409);
    expect(res.body.message).toBe("邮箱已被注册");
  });

  it("POST /auth/login — 正确密码返回 token", async () => {
    if (maybeSkip()) return;
    const res = await request(app.getHttpServer())
      .post("/api/auth/login")
      .send({ email: ALICE.email, password: ALICE.password });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
  });

  it("POST /auth/login — 错误密码抛 401 + 英文 i18n", async () => {
    if (maybeSkip()) return;
    const res = await request(app.getHttpServer())
      .post("/api/auth/login")
      .set("Accept-Language", "en")
      .send({ email: ALICE.email, password: "wrong" });
    expect(res.status).toBe(401);
    expect(res.body.message).toBe("Invalid email or password");
  });

  it("POST /auth/register — 非法 DTO 中文报错走 i18n 翻译", async () => {
    if (maybeSkip()) return;
    const res = await request(app.getHttpServer())
      .post("/api/auth/register")
      .send({ email: "not-an-email", password: "short", displayName: "" });
    expect(res.status).toBe(400);
    const messages = res.body.errors.map((e: { message: string }) => e.message);
    expect(messages).toEqual(
      expect.arrayContaining(["邮箱格式不正确", "密码至少 8 位", "必填字段"]),
    );
  });

  it("POST /auth/register — 非法 DTO 英文报错走 i18n 翻译", async () => {
    if (maybeSkip()) return;
    const res = await request(app.getHttpServer())
      .post("/api/auth/register")
      .set("Accept-Language", "en")
      .send({ email: "not-an-email", password: "short", displayName: "" });
    expect(res.status).toBe(400);
    const messages = res.body.errors.map((e: { message: string }) => e.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        "Invalid email format",
        "Password must be at least 8 characters",
        "Required field",
      ]),
    );
  });

  it("无 token 访问 protected health 403 — 框架预留：当前 health 是 @Public，不验证此场景", async () => {
    if (maybeSkip()) return;
    // 仅留位标：等 meshbot 真业务加 protected endpoint 后再补 401 / 403 用例
    expect(true).toBe(true);
  });
});
