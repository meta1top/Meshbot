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
import { MainErrorCode, MainModule } from "@meshbot/main";
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
import { AgentRegistryController } from "../../src/rest/agent-registry.controller";
import { AuthController } from "../../src/rest/auth.controller";
import { DeviceAuthController } from "../../src/rest/device-auth.controller";
import { DeviceController } from "../../src/rest/device.controller";
import { OrgController } from "../../src/rest/org.controller";
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

function makePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("hex");
  return { verifier, challenge };
}

interface AgentViewRow {
  id: string;
  deviceId: string;
  localAgentId: string;
  name: string;
  avatar: string;
  description: string | null;
}

describe("server-main agent 注册 REST e2e", () => {
  let app: INestApplication;
  let dbCtx: TestDbContext | null = null;
  let skipReason: string | null = null;

  beforeAll(async () => {
    if (!(await isPostgresReachable())) {
      skipReason = "Postgres unreachable; run `pnpm dev:db:up`";
      console.warn(`[agent-registry] ${skipReason}`);
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
        AgentRegistryController,
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
      console.warn(`[agent-registry] skipping: ${skipReason}`);
      return true;
    }
    return false;
  }

  /** 走完整设备授权拿一个 device token（mbd_ 前缀）。 */
  async function issueDeviceToken(
    userToken: string,
    machineId: string,
  ): Promise<string> {
    const { verifier, challenge } = makePkce();
    const startRes = await request(app.getHttpServer())
      .post("/api/device-auth/start")
      .send({
        deviceName: "Agent Device",
        platform: "darwin",
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
      .send({ requestId, userCode, codeVerifier: verifier, machineId });
    return exchangeRes.body.data.deviceToken as string;
  }

  const a1 = {
    localAgentId: "la1",
    name: "Agent 一号",
    avatar: "",
    description: "第一个",
    visibility: "private",
  };
  const a2 = {
    localAgentId: "la2",
    name: "Agent 二号",
    avatar: "av2",
    description: null,
    visibility: "org",
  };

  it("device token PUT 对账写入，user JWT GET 读回；再 PUT 少一个则软删", async () => {
    if (maybeSkip()) return;
    const aliceToken = await registerAndVerify(
      app,
      captureSender,
      "alice@agent.io",
    );
    await request(app.getHttpServer())
      .post("/api/orgs")
      .set("Authorization", `Bearer ${aliceToken}`)
      .send({ name: "AliceOrg" });
    const deviceToken = await issueDeviceToken(aliceToken, "alice-machine");

    // 首推两个
    const put1 = await request(app.getHttpServer())
      .put("/api/agent/agents")
      .set("Authorization", `Bearer ${deviceToken}`)
      .send({ agents: [a1, a2] });
    expect(put1.body).toMatchObject({ success: true });

    const list1 = await request(app.getHttpServer())
      .get("/api/agents")
      .set("Authorization", `Bearer ${aliceToken}`);
    expect(list1.body).toMatchObject({ success: true });
    const rows1 = list1.body.data as AgentViewRow[];
    expect(rows1).toHaveLength(2);
    const byLocal = new Map(rows1.map((r) => [r.localAgentId, r]));
    expect(byLocal.get("la1")?.name).toBe("Agent 一号");
    expect(byLocal.get("la2")?.description).toBeNull();
    expect(byLocal.get("la1")?.deviceId).toBeTruthy();
    expect(byLocal.get("la1")?.id).toBeTruthy();

    // 复推只留 la1 → la2 软删
    const put2 = await request(app.getHttpServer())
      .put("/api/agent/agents")
      .set("Authorization", `Bearer ${deviceToken}`)
      .send({ agents: [a1] });
    expect(put2.body).toMatchObject({ success: true });

    const list2 = await request(app.getHttpServer())
      .get("/api/agents")
      .set("Authorization", `Bearer ${aliceToken}`);
    const rows2 = list2.body.data as AgentViewRow[];
    expect(rows2).toHaveLength(1);
    expect(rows2[0].localAgentId).toBe("la1");
    // 稳定 id：软删复活/更新不换 id
    expect(rows2[0].id).toBe(byLocal.get("la1")?.id);
  });

  it("越权：user A 的 JWT 看不到 user B 的 agent", async () => {
    if (maybeSkip()) return;
    const bobToken = await registerAndVerify(
      app,
      captureSender,
      "bob@agent.io",
    );
    await request(app.getHttpServer())
      .post("/api/orgs")
      .set("Authorization", `Bearer ${bobToken}`)
      .send({ name: "BobOrg" });
    const bobDeviceToken = await issueDeviceToken(bobToken, "bob-machine");
    await request(app.getHttpServer())
      .put("/api/agent/agents")
      .set("Authorization", `Bearer ${bobDeviceToken}`)
      .send({ agents: [{ ...a1, localAgentId: "bob-la1", name: "Bob 专属" }] });

    const carolToken = await registerAndVerify(
      app,
      captureSender,
      "carol@agent.io",
    );
    const carolList = await request(app.getHttpServer())
      .get("/api/agents")
      .set("Authorization", `Bearer ${carolToken}`);
    const carolRows = carolList.body.data as AgentViewRow[];
    expect(carolRows.every((r) => r.localAgentId !== "bob-la1")).toBe(true);
  });

  it("非 device-token 身份（user JWT）PUT 被拒（2029）", async () => {
    if (maybeSkip()) return;
    const daveToken = await registerAndVerify(
      app,
      captureSender,
      "dave@agent.io",
    );
    const res = await request(app.getHttpServer())
      .put("/api/agent/agents")
      .set("Authorization", `Bearer ${daveToken}`)
      .send({ agents: [a1] });
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe(
      MainErrorCode.AGENT_REGISTRY_REQUIRES_DEVICE_TOKEN.code,
    );
  });

  it("批次内重复 localAgentId 被 Zod 拒（校验失败）", async () => {
    if (maybeSkip()) return;
    const eveToken = await registerAndVerify(
      app,
      captureSender,
      "eve@agent.io",
    );
    await request(app.getHttpServer())
      .post("/api/orgs")
      .set("Authorization", `Bearer ${eveToken}`)
      .send({ name: "EveOrg" });
    const eveDeviceToken = await issueDeviceToken(eveToken, "eve-machine");
    const res = await request(app.getHttpServer())
      .put("/api/agent/agents")
      .set("Authorization", `Bearer ${eveDeviceToken}`)
      .send({ agents: [a1, { ...a1, name: "撞名" }] });
    expect(res.body.success).toBe(false);
  });
});
