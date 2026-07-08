import "reflect-metadata";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import {
  CommonModule,
  ErrorsFilter,
  I18nZodValidationPipe,
  ResponseInterceptor,
  traceIdMiddleware,
} from "@meshbot/common";
import { AssetsModule } from "@meshbot/assets";
import { MainModule } from "@meshbot/main";
import type { INestApplication } from "@nestjs/common";
import { APP_GUARD, Reflector } from "@nestjs/core";
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
import { type AppConfig, APP_CONFIG } from "../../src/config/app-config.schema";
import { AuthController } from "../../src/rest/auth.controller";
import { DeviceAuthController } from "../../src/rest/device-auth.controller";
import { DeviceController } from "../../src/rest/device.controller";
import { OrgController } from "../../src/rest/org.controller";
import { ModelGatewayModule } from "../../src/model-gateway/model-gateway.module";
import {
  GatewayModelNotFoundError,
  ModelGatewayService,
} from "../../src/model-gateway/model-gateway.service";
import {
  buildCaptureEmailModule,
  CaptureEmailSender,
} from "../setup/capture-email-sender";
import { registerAndVerify } from "../setup/register-and-verify";
import {
  createTestDb,
  isPostgresReachable,
  type TestDbContext,
} from "../setup/test-db";

const I18N_PATH = path.join(__dirname, "..", "..", "i18n");

const TEST_APP_CONFIG = {
  jwt: { secret: "e2e-test-secret", expires: "1h" },
  webMainBase: "http://web-main.test",
} as AppConfig;

const captureSender = new CaptureEmailSender();
const TestEmailModule = buildCaptureEmailModule(captureSender);

/** 生成一对 PKCE verifier/challenge（sha256 hex，与 DeviceAuthService 校验规则一致）。 */
function makePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("hex");
  return { verifier, challenge };
}

/**
 * `ModelGatewayService` 的测试替身：避免真调 langchain/厂商 API。
 * `model === "m1"` 模拟归属当前 org 的模型；其余一律当"归属解析失败"
 * （对应真实 `OrgModelConfigService.resolveDecrypted` 找不到时的行为），
 * 覆盖跨 org 模型 id 场景，不必在 Postgres 里真建第二个 org 的配置。
 */
class FakeModelGatewayService {
  async complete(orgId: string, req: { model: string }, id: string) {
    if (req.model !== "m1") {
      throw new GatewayModelNotFoundError(req.model);
    }
    return {
      id,
      object: "chat.completion",
      created: 0,
      model: req.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: `echo:${orgId}` },
          finish_reason: "stop",
        },
      ],
    };
  }
}

describe("server-main 云端模型网关 chat/completions e2e", () => {
  let app: INestApplication;
  let dbCtx: TestDbContext | null = null;
  let skipReason: string | null = null;

  beforeAll(async () => {
    if (!(await isPostgresReachable())) {
      skipReason = "Postgres unreachable; run `pnpm dev:db:up`";
      console.warn(`[model-gateway] ${skipReason}`);
      return;
    }
    dbCtx = await createTestDb();

    // 与 AppModule.forRoot() 同一手法：MainModule.forRoot() 只调一次，
    // 同一个 DynamicModule 对象引用同时喂给测试模块自身的 imports 和
    // ModelGatewayModule.forRoot()，避免 NestJS 按引用去重导致重复实例化
    // OrgModelConfigService 等 Service（见 model-gateway.module.ts 注释）。
    const mainModule = MainModule.forRoot(
      { expiresDays: 7 },
      { encryptionKey: "e2e-encryption-key-0123456789abcdef" },
    );

    const moduleRef = await Test.createTestingModule({
      imports: [
        CommonModule.forRoot({}),
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
        TestEmailModule,
        // MainModule 的 SkillMarketService 依赖全局 AssetsModule 的 AssetService；
        // 本 e2e 不测资产，仅为满足 DI（minio 不可达由 onModuleInit 兜底告警）。
        AssetsModule.forRoot({
          provider: "minio",
          minio: {
            endPoint: "localhost",
            port: 9000,
            useSSL: false,
            accessKey: "x",
            secretKey: "x",
            bucket: "test",
          },
        }),
        mainModule,
        // 真实模块装配（app.module.ts 同款 forRoot(mainModule) 用法），
        // 只在下方 overrideProvider 把内部 ModelGatewayService 换成测试替身。
        ModelGatewayModule.forRoot(mainModule),
      ],
      controllers: [
        AuthController,
        OrgController,
        DeviceAuthController,
        DeviceController,
      ],
      providers: [
        { provide: APP_CONFIG, useValue: TEST_APP_CONFIG },
        JwtMainStrategy,
        { provide: APP_GUARD, useClass: JwtAuthGuard },
      ],
    })
      .overrideProvider(ModelGatewayService)
      .useClass(FakeModelGatewayService)
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix("api");
    app.use(traceIdMiddleware);
    const i18n = app.get(I18nService);
    const reflector = app.get(Reflector);
    app.useGlobalPipes(new I18nZodValidationPipe(i18n));
    app.useGlobalInterceptors(new ResponseInterceptor(reflector));
    app.useGlobalFilters(new ErrorsFilter(i18n));
    await app.init();
  }, 30_000);

  afterAll(async () => {
    if (app) await app.close();
    if (dbCtx) await dbCtx.cleanup();
  });

  function maybeSkip(): boolean {
    if (skipReason) {
      console.warn(`[model-gateway] skipping: ${skipReason}`);
      return true;
    }
    return false;
  }

  async function registerAndToken(email: string): Promise<string> {
    return registerAndVerify(app, captureSender, email);
  }

  /** 走完整设备授权流程，拿到绑定当前活跃组织的 device token。 */
  async function issueDeviceToken(userToken: string): Promise<string> {
    const { verifier, challenge } = makePkce();
    const startRes = await request(app.getHttpServer())
      .post("/api/device-auth/start")
      .send({
        deviceName: "Gateway Box",
        platform: "linux",
        codeChallenge: challenge,
      });
    const requestId = startRes.body.data.requestId as string;

    const approveRes = await request(app.getHttpServer())
      .post("/api/device-auth/approve")
      .set("Authorization", `Bearer ${userToken}`)
      .send({ requestId });
    const userCode = approveRes.body.data.userCode as string;

    const exchangeRes = await request(app.getHttpServer())
      .post("/api/device-auth/exchange")
      .send({ requestId, userCode, codeVerifier: verifier });
    return exchangeRes.body.data.deviceToken as string;
  }

  it("带有效 device token + 非流式 → 200 且返回 completion", async () => {
    if (maybeSkip()) return;

    const ownerToken = await registerAndToken("owner@gateway.io");
    await request(app.getHttpServer())
      .post("/api/orgs")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "GatewayOrg" });
    const deviceToken = await issueDeviceToken(ownerToken);

    const res = await request(app.getHttpServer())
      .post("/api/v1/chat/completions")
      .set("Authorization", `Bearer ${deviceToken}`)
      .send({ model: "m1", messages: [{ role: "user", content: "hi" }] });

    expect(res.status).toBe(200);
    expect(res.body.object).toBe("chat.completion");
    expect(res.body.choices[0].message.content).toContain("echo:");
  });

  it("无 token → 401", async () => {
    if (maybeSkip()) return;

    const res = await request(app.getHttpServer())
      .post("/api/v1/chat/completions")
      .send({ model: "m1", messages: [] });
    expect(res.status).toBe(401);
  });

  it("跨 org 模型 id → 404", async () => {
    if (maybeSkip()) return;

    const ownerToken = await registerAndToken("owner2@gateway.io");
    await request(app.getHttpServer())
      .post("/api/orgs")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "GatewayOrg2" });
    const deviceToken = await issueDeviceToken(ownerToken);

    const res = await request(app.getHttpServer())
      .post("/api/v1/chat/completions")
      .set("Authorization", `Bearer ${deviceToken}`)
      .send({ model: "other-org-model", messages: [] });
    expect(res.status).toBe(404);
  });
});
