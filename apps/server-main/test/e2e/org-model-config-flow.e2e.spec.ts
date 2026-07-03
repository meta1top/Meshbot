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
import { AgentConfigController } from "../../src/rest/agent-config.controller";
import { AuthController } from "../../src/rest/auth.controller";
import { DeviceAuthController } from "../../src/rest/device-auth.controller";
import { DeviceController } from "../../src/rest/device.controller";
import { OrgController } from "../../src/rest/org.controller";
import { OrgModelConfigController } from "../../src/rest/org-model-config.controller";
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

describe("server-main 组织模型配置权限 e2e", () => {
  let app: INestApplication;
  let dbCtx: TestDbContext | null = null;
  let skipReason: string | null = null;

  beforeAll(async () => {
    if (!(await isPostgresReachable())) {
      skipReason = "Postgres unreachable; run `pnpm dev:db:up`";
      console.warn(`[org-model-config-flow] ${skipReason}`);
      return;
    }
    dbCtx = await createTestDb();

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
        MainModule.forRoot(
          { expiresDays: 7 },
          { encryptionKey: "e2e-encryption-key-0123456789abcdef" },
        ),
      ],
      controllers: [
        AuthController,
        OrgController,
        DeviceAuthController,
        DeviceController,
        OrgModelConfigController,
        AgentConfigController,
      ],
      providers: [
        { provide: APP_CONFIG, useValue: TEST_APP_CONFIG },
        JwtMainStrategy,
        { provide: APP_GUARD, useClass: JwtAuthGuard },
      ],
    }).compile();

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
      console.warn(`[org-model-config-flow] skipping: ${skipReason}`);
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
        deviceName: "Agent Box",
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

  it("owner 建配置 → 打码列表 → 成员 403 → agent 端点解密 apiKey → disable 后为空", async () => {
    if (maybeSkip()) return;

    // owner 建组织
    const ownerToken = await registerAndToken("owner@modelcfg.io");
    const orgRes = await request(app.getHttpServer())
      .post("/api/orgs")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "ModelCfgOrg" });
    const orgId = orgRes.body.data.id as string;

    // 邀请成员并接受
    const inviteRes = await request(app.getHttpServer())
      .post(`/api/orgs/${orgId}/invitations`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ email: "member@modelcfg.io" });
    const inviteCode = inviteRes.body.data.token as string;
    const memberToken = await registerAndToken("member@modelcfg.io");
    await request(app.getHttpServer())
      .post("/api/orgs/invitations/accept")
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ token: inviteCode });

    // owner 新建模型配置
    const createRes = await request(app.getHttpServer())
      .post(`/api/orgs/${orgId}/model-configs`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        name: "GPT-4o",
        providerType: "openai",
        model: "gpt-4o",
        apiKey: "sk-secret-value-1234",
        baseUrl: "https://api.openai.com/v1",
        contextWindow: 128_000,
        enabled: true,
      });
    expect(createRes.body).toMatchObject({ success: true });
    const configId = createRes.body.data.id as string;
    expect(createRes.body.data.apiKeyMasked).toBe("****1234");
    expect(createRes.body.data.apiKeyMasked).not.toContain("sk-secret-value");

    // owner 列表：打码
    const listRes = await request(app.getHttpServer())
      .get(`/api/orgs/${orgId}/model-configs`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(listRes.body.data).toHaveLength(1);
    expect(listRes.body.data[0].apiKeyMasked).toBe("****1234");

    // 成员 POST 被 403 ORG_FORBIDDEN
    const forbiddenRes = await request(app.getHttpServer())
      .post(`/api/orgs/${orgId}/model-configs`)
      .set("Authorization", `Bearer ${memberToken}`)
      .send({
        name: "Should Fail",
        providerType: "openai",
        model: "gpt-4o-mini",
        apiKey: "sk-should-not-be-created",
      });
    expect(forbiddenRes.status).toBe(403);
    expect(forbiddenRes.body).toMatchObject({ success: false, code: 2004 });

    // agent 端点用 device token 拿到解密后的 apiKey
    const deviceToken = await issueDeviceToken(ownerToken);
    const agentListRes = await request(app.getHttpServer())
      .get("/api/agent/model-configs")
      .set("Authorization", `Bearer ${deviceToken}`);
    expect(agentListRes.body).toMatchObject({ success: true });
    expect(agentListRes.body.data).toHaveLength(1);
    expect(agentListRes.body.data[0]).toMatchObject({
      id: configId,
      apiKey: "sk-secret-value-1234",
      model: "gpt-4o",
    });

    // disable 后 agent 列表为空
    const updateRes = await request(app.getHttpServer())
      .patch(`/api/orgs/${orgId}/model-configs/${configId}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ enabled: false });
    expect(updateRes.body).toMatchObject({
      success: true,
      data: { enabled: false },
    });

    const agentListAfterDisable = await request(app.getHttpServer())
      .get("/api/agent/model-configs")
      .set("Authorization", `Bearer ${deviceToken}`);
    expect(agentListAfterDisable.body.data).toEqual([]);
  });
});
