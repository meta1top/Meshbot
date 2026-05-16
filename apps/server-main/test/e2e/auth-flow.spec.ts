import "reflect-metadata";
import path from "node:path";
import {
  CommonModule,
  type CommonModuleOptions,
  I18nExceptionFilter,
  I18nZodValidationPipe,
  RedisCacheProvider,
  RedisLockProvider,
} from "@meshbot/common";
import { MainModule } from "@meshbot/main";
import type { INestApplication } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_GUARD } from "@nestjs/core";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { Test } from "@nestjs/testing";
import { TypeOrmModule } from "@nestjs/typeorm";
import Redis from "ioredis";
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

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

async function isRedisReachable(): Promise<boolean> {
  const probe = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 1,
    lazyConnect: false,
    connectTimeout: 1_000,
  });
  return new Promise((resolve) => {
    let settled = false;
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      probe.disconnect();
      resolve(ok);
    };
    probe.on("ready", () => settle(true));
    probe.on("error", () => settle(false));
    setTimeout(() => settle(false), 1_200);
  });
}

type Mode = "memory" | "redis";

interface ProviderRef {
  redis?: Redis;
}

function buildCommonOptions(mode: Mode, ref: ProviderRef): CommonModuleOptions {
  if (mode === "memory") return {};
  const redis = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 3,
    lazyConnect: false,
  });
  ref.redis = redis;
  return {
    lock: new RedisLockProvider(redis),
    cache: new RedisCacheProvider(redis),
  };
}

// 测试用例覆盖 memory + redis 双 provider 链路。redis 不可达时该 block skip。
describe.each<[Mode]>([
  ["memory"],
  ["redis"],
])("server-main auth e2e (%s)", (mode) => {
  let app: INestApplication;
  let dbCtx: TestDbContext | null = null;
  let skipReason: string | null = null;
  const providerRef: ProviderRef = {};

  beforeAll(async () => {
    const pgOk = await isPostgresReachable();
    if (!pgOk) {
      skipReason = "Postgres unreachable; run `pnpm dev:db:up`";
      console.warn(`[auth-flow:${mode}] ${skipReason}`);
      return;
    }
    if (mode === "redis") {
      const redisOk = await isRedisReachable();
      if (!redisOk) {
        skipReason = `Redis unreachable at ${REDIS_URL}; run 'pnpm dev:db:up'（含 redis 服务）`;
        console.warn(`[auth-flow:${mode}] ${skipReason}`);
        return;
      }
    }
    dbCtx = await createTestDb();
    const commonOptions = buildCommonOptions(mode, providerRef);

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ JWT_SECRET: "e2e-test-secret", JWT_EXPIRES: "1h" })],
        }),
        CommonModule.forRoot(commonOptions),
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
    if (providerRef.redis) providerRef.redis.disconnect();
  });

  function maybeSkip() {
    if (skipReason) {
      console.warn(`[auth-flow:${mode}] skipping: ${skipReason}`);
      return true;
    }
    return false;
  }

  const ALICE = {
    email: `alice-${mode}@test.io`,
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
});
