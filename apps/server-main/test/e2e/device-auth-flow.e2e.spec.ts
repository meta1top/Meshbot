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

// e2e 只消费 config.jwt / config.webMainBase，partial cast 即可
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

describe("server-main 设备授权全流程 e2e", () => {
  let app: INestApplication;
  let dbCtx: TestDbContext | null = null;
  let skipReason: string | null = null;

  beforeAll(async () => {
    if (!(await isPostgresReachable())) {
      skipReason = "Postgres unreachable; run `pnpm dev:db:up`";
      console.warn(`[device-auth-flow] ${skipReason}`);
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
      console.warn(`[device-auth-flow] skipping: ${skipReason}`);
      return true;
    }
    return false;
  }

  async function registerAndToken(email: string): Promise<string> {
    return registerAndVerify(app, captureSender, email);
  }

  it("设备授权全流程：start → approve → exchange → 设备身份可用 → switch-org → revoke", async () => {
    if (maybeSkip()) return;

    // 1. 注册 + 验证邮箱拿 JWT
    const aliceToken = await registerAndToken("alice@device.io");

    // 2. 建组织
    const orgRes = await request(app.getHttpServer())
      .post("/api/orgs")
      .set("Authorization", `Bearer ${aliceToken}`)
      .send({ name: "DeviceOrg" });
    expect(orgRes.body).toMatchObject({ success: true });
    const orgId = orgRes.body.data.id as string;

    // 3. 本地 Agent 发起授权请求（公开端点，无凭据）
    const { verifier, challenge } = makePkce();
    const startRes = await request(app.getHttpServer())
      .post("/api/device-auth/start")
      .send({
        deviceName: "Alice MacBook",
        platform: "darwin",
        codeChallenge: challenge,
        redirectUri: "http://localhost:8899/callback",
      });
    expect(startRes.body).toMatchObject({ success: true });
    const requestId = startRes.body.data.requestId as string;
    expect(startRes.body.data.verifyUrl).toBe(
      `http://web-main.test/authorize?request=${requestId}`,
    );

    // 4. 授权确认页读取请求信息（需登录）
    const getReqRes = await request(app.getHttpServer())
      .get(`/api/device-auth/requests/${requestId}`)
      .set("Authorization", `Bearer ${aliceToken}`);
    expect(getReqRes.body).toMatchObject({
      success: true,
      data: {
        deviceName: "Alice MacBook",
        platform: "darwin",
        status: "pending",
      },
    });

    // 5. 用户批准
    const approveRes = await request(app.getHttpServer())
      .post("/api/device-auth/approve")
      .set("Authorization", `Bearer ${aliceToken}`)
      .send({ requestId });
    expect(approveRes.body).toMatchObject({ success: true });
    const userCode = approveRes.body.data.userCode as string;
    expect(approveRes.body.data.redirectUri).toBe(
      "http://localhost:8899/callback",
    );

    // 6. 本地 Agent 兑换（公开端点，无凭据）
    const exchangeRes = await request(app.getHttpServer())
      .post("/api/device-auth/exchange")
      .send({ requestId, userCode, codeVerifier: verifier });
    expect(exchangeRes.body).toMatchObject({ success: true });
    const deviceToken = exchangeRes.body.data.deviceToken as string;
    expect(deviceToken).toMatch(/^mbd_/);
    expect(exchangeRes.body.data.orgId).toBe(orgId);
    expect(exchangeRes.body.data.user.email).toBe("alice@device.io");

    // 7. device token 可直接当身份用
    const profileRes = await request(app.getHttpServer())
      .get("/api/auth/profile")
      .set("Authorization", `Bearer ${deviceToken}`)
      .expect(200);
    expect(profileRes.body.data.user.id).toBe(exchangeRes.body.data.user.id);

    // 8. 设备列表（用户 JWT）
    const listRes = await request(app.getHttpServer())
      .get("/api/devices")
      .set("Authorization", `Bearer ${aliceToken}`);
    expect(listRes.body.data).toHaveLength(1);
    const deviceId = listRes.body.data[0].id as string;
    expect(listRes.body.data[0].name).toBe("Alice MacBook");

    // 9. 切换组织（先建第二个组织并加入 —— 建组织者自动是 owner/member）
    const org2Res = await request(app.getHttpServer())
      .post("/api/orgs")
      .set("Authorization", `Bearer ${aliceToken}`)
      .send({ name: "DeviceOrg2" });
    const org2Id = org2Res.body.data.id as string;

    const switchRes = await request(app.getHttpServer())
      .post("/api/devices/switch-org")
      .set("Authorization", `Bearer ${deviceToken}`)
      .send({ orgId: org2Id });
    expect(switchRes.body).toMatchObject({ success: true, data: { ok: true } });

    const deviceRow = await dbCtx?.ds.query(
      `SELECT org_id FROM device WHERE id = $1`,
      [deviceId],
    );
    expect(deviceRow?.[0]?.org_id).toBe(org2Id);

    // 10. 吊销设备（用户 JWT）；再用旧 device token 打 profile → 401
    const revokeRes = await request(app.getHttpServer())
      .delete(`/api/devices/${deviceId}`)
      .set("Authorization", `Bearer ${aliceToken}`);
    expect(revokeRes.body).toMatchObject({ success: true, data: { ok: true } });

    const profileAfterRevoke = await request(app.getHttpServer())
      .get("/api/auth/profile")
      .set("Authorization", `Bearer ${deviceToken}`);
    expect(profileAfterRevoke.status).toBe(401);
    expect(profileAfterRevoke.body.success).toBe(false);
  });

  it("负面：错误 userCode 兑换 5 次后正确码也失效", async () => {
    if (maybeSkip()) return;
    const bobToken = await registerAndToken("bob@device.io");
    await request(app.getHttpServer())
      .post("/api/orgs")
      .set("Authorization", `Bearer ${bobToken}`)
      .send({ name: "BobOrg" });

    const { verifier, challenge } = makePkce();
    const startRes = await request(app.getHttpServer())
      .post("/api/device-auth/start")
      .send({
        deviceName: "Bob PC",
        platform: "win32",
        codeChallenge: challenge,
      });
    const requestId = startRes.body.data.requestId as string;

    const approveRes = await request(app.getHttpServer())
      .post("/api/device-auth/approve")
      .set("Authorization", `Bearer ${bobToken}`)
      .send({ requestId });
    const userCode = approveRes.body.data.userCode as string;

    // 连续 5 次错误 userCode
    for (let i = 0; i < 5; i++) {
      const res = await request(app.getHttpServer())
        .post("/api/device-auth/exchange")
        .send({
          requestId,
          userCode: "wrong-code-value",
          codeVerifier: verifier,
        });
      expect(res.body).toMatchObject({ success: false, code: 2025 });
    }

    // 第 5 次已耗尽 attempts，请求作废；即便这次用回正确 userCode 也失败
    const finalRes = await request(app.getHttpServer())
      .post("/api/device-auth/exchange")
      .send({ requestId, userCode, codeVerifier: verifier });
    expect(finalRes.body).toMatchObject({ success: false, code: 2025 });
  });

  it("负面：过期请求兑换失败（DEVICE_AUTH_EXPIRED）", async () => {
    if (maybeSkip()) return;
    const { challenge } = makePkce();
    const startRes = await request(app.getHttpServer())
      .post("/api/device-auth/start")
      .send({
        deviceName: "Expired Device",
        platform: "linux",
        codeChallenge: challenge,
      });
    const requestId = startRes.body.data.requestId as string;

    // 绕过时钟：直接把 expires_at 改到过去
    await dbCtx?.ds.query(
      `UPDATE "device_auth_request" SET "expires_at" = now() - interval '1 day' WHERE "id" = $1`,
      [requestId],
    );

    const exchangeRes = await request(app.getHttpServer())
      .post("/api/device-auth/exchange")
      .send({
        requestId,
        userCode: "whatever-code",
        codeVerifier: "x".repeat(32),
      });
    expect(exchangeRes.body).toMatchObject({ success: false, code: 2026 });
  });
});
