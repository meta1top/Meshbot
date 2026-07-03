import "reflect-metadata";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import {
  CommonModule,
  ErrorsFilter,
  I18nZodValidationPipe,
  ResponseInterceptor,
  WsExceptionFilter,
  traceIdMiddleware,
} from "@meshbot/common";
import { AssetsModule } from "@meshbot/assets";
import { MainErrorCode, MainModule, REDIS_CLIENT } from "@meshbot/main";
import { IM_WS_EVENTS, IM_WS_NAMESPACE } from "@meshbot/types";
import type {
  ConversationSummary,
  ImAgentInboundEvent,
  ImMessage,
  PresenceState,
} from "@meshbot/types";
import type { INestApplication } from "@nestjs/common";
import { APP_GUARD, Reflector } from "@nestjs/core";
import { EventEmitterModule } from "@nestjs/event-emitter";
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
import { io as createClient, type Socket } from "socket.io-client";

import { emitUntilEvent, waitForEvent } from "../setup/ws-test-utils";
import { JwtAuthGuard } from "../../src/auth/jwt-auth.guard";
import { JwtMainStrategy } from "../../src/auth/jwt.strategy";
import { type AppConfig, APP_CONFIG } from "../../src/config/app-config.schema";
import { AgentDeviceController } from "../../src/rest/agent-device.controller";
import { AuthController } from "../../src/rest/auth.controller";
import { DeviceAuthController } from "../../src/rest/device-auth.controller";
import { DeviceController } from "../../src/rest/device.controller";
import { ImController } from "../../src/rest/im.controller";
import { OrgController } from "../../src/rest/org.controller";
import { HealthGateway } from "../../src/ws/health.gateway";
import { ImGateway } from "../../src/ws/im.gateway";
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
  jwt: { secret: "agent-dm-e2e-secret", expires: "1h" },
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
 * 子项目B（设备 Agent 反向通道）Phase 1 收官 e2e：
 * Agent-DM 建会话 → 定向下发 agent.inbound → 设备回流盖 agent 身份 → 列会话 → 在线态。
 *
 * 装配复制 `device-auth-flow.e2e.spec.ts`（设备授权 start/approve/exchange）+
 * `im-flow.spec.ts`（WS e2e：`app.listen(0)` + socket.io-client 连 `ws/im`）。
 */
describe("server-main Agent-DM 反向通道 e2e", () => {
  let app: INestApplication;
  let port: number;
  let dbCtx: TestDbContext | null = null;
  let skipReason: string | null = null;

  beforeAll(async () => {
    if (!(await isPostgresReachable())) {
      skipReason = "Postgres unreachable; run `pnpm dev:db:up`";
      console.warn(`[agent-dm-flow] ${skipReason}`);
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
          secret: "agent-dm-e2e-secret",
          signOptions: { expiresIn: "1h" },
        }),
        TestEmailModule,
        EventEmitterModule.forRoot(),
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
        ImController,
        AgentDeviceController,
      ],
      providers: [
        { provide: APP_CONFIG, useValue: TEST_APP_CONFIG },
        { provide: REDIS_CLIENT, useValue: null },
        JwtMainStrategy,
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        WsExceptionFilter,
        HealthGateway,
        ImGateway,
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

    await app.listen(0);
    const addr = app.getHttpServer().address();
    if (!addr || typeof addr === "string") {
      throw new Error("无法解析 Agent-DM e2e 端口");
    }
    port = addr.port;
  }, 30_000);

  afterAll(async () => {
    if (app) await app.close();
    if (dbCtx) await dbCtx.cleanup();
  });

  function maybeSkip(): boolean {
    if (skipReason) {
      console.warn(`[agent-dm-flow] skipping: ${skipReason}`);
      return true;
    }
    return false;
  }

  /** 注册用户并返回 JWT token（不含 orgId，需 switch-org 刷新）。 */
  async function registerAndToken(email: string): Promise<string> {
    return registerAndVerify(
      app,
      captureSender,
      email,
      "password1",
      email.split("@")[0],
    );
  }

  /** 从 JWT token 中提取 userId（base64 decode middle segment）。 */
  function parseUserId(token: string): string {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1], "base64").toString(),
    ) as { userId: string };
    return payload.userId;
  }

  /**
   * 建组织 + 刷新 token（switch-org 使 JWT 携带 orgId，ImController.requireOrg 需要）。
   */
  async function createOrgAndSwitch(
    token0: string,
    orgName: string,
  ): Promise<{ orgId: string; token: string }> {
    const orgRes = await request(app.getHttpServer())
      .post("/api/orgs")
      .set("Authorization", `Bearer ${token0}`)
      .send({ name: orgName });
    const orgId = orgRes.body.data.id as string;

    const switchRes = await request(app.getHttpServer())
      .post("/api/auth/switch-org")
      .set("Authorization", `Bearer ${token0}`)
      .send({ orgId });
    const token = switchRes.body.data.token as string;

    return { orgId, token };
  }

  /**
   * 走完整设备授权流程（start → approve → exchange）拿 deviceToken，
   * 再用 GET /api/devices 按名字反查 deviceId（exchange 响应不含 deviceId）。
   */
  async function provisionDevice(
    userToken: string,
    deviceName: string,
  ): Promise<{ deviceToken: string; deviceId: string }> {
    const { verifier, challenge } = makePkce();
    const startRes = await request(app.getHttpServer())
      .post("/api/device-auth/start")
      .send({
        deviceName,
        platform: "darwin",
        codeChallenge: challenge,
        redirectUri: "http://localhost:8899/callback",
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
    const deviceToken = exchangeRes.body.data.deviceToken as string;

    const listRes = await request(app.getHttpServer())
      .get("/api/devices")
      .set("Authorization", `Bearer ${userToken}`);
    const device = (listRes.body.data as { id: string; name: string }[]).find(
      (d) => d.name === deviceName,
    );
    if (!device) {
      throw new Error(`provisionDevice: 未找到设备 ${deviceName}`);
    }
    return { deviceToken, deviceId: device.id };
  }

  /** 建立 socket.io 连接到 ws/im namespace（浏览器 JWT 或 device token 均可）。 */
  function connectIm(token: string): Socket {
    return createClient(`http://localhost:${port}/${IM_WS_NAMESPACE}`, {
      auth: { token },
      transports: ["websocket"],
      reconnection: false,
      forceNew: true,
    });
  }

  /**
   * 等待 socket 收到「满足 predicate」的事件；用 `.on`（非 once）+ 手动摘除监听，
   * 用于房间内会混入其它无关事件（如自己消息的房间回声）时按内容过滤。
   */
  function waitForFilteredEvent<T>(
    socket: Socket,
    event: string,
    predicate: (payload: T) => boolean,
    timeoutMs = 5_000,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.off(event, handler);
        reject(
          new Error(
            `[ws-test] filtered event "${event}" timeout after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
      function handler(payload: T): void {
        if (predicate(payload)) {
          clearTimeout(timer);
          socket.off(event, handler);
          resolve(payload);
        }
      }
      socket.on(event, handler);
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 场景 1-6：注册 → 建组织 → 设备授权 → 建 Agent-DM → WS 定向下发 → 设备回流盖身份 →
  //           列会话 → 在线态
  // ──────────────────────────────────────────────────────────────────────────
  it("Agent-DM 反向通道全链路：建会话 → agent.inbound 定向下发 → 设备回流 → 列会话 → 在线态", async () => {
    if (maybeSkip()) return;

    // 场景 1：注册 → 建组织 → 设备授权拿 deviceToken
    const aliceToken0 = await registerAndToken("alice-agentdm@test.io");
    const aliceUserId = parseUserId(aliceToken0);
    const { orgId, token: aliceToken } = await createOrgAndSwitch(
      aliceToken0,
      "AgentDmOrg",
    );
    const { deviceToken, deviceId } = await provisionDevice(
      aliceToken,
      "Alice Agent Device",
    );

    // 场景 2：POST /api/agent-dms 建 Agent-DM 会话
    const createRes = await request(app.getHttpServer())
      .post("/api/agent-dms")
      .set("Authorization", `Bearer ${aliceToken}`)
      .send({ deviceId });
    expect(createRes.status).toBe(201);
    expect(createRes.body.success).toBe(true);
    const summary = createRes.body.data as ConversationSummary;
    expect(summary.agentDeviceId).toBe(deviceId);
    const conversationId = summary.id;

    // 双端连接 ws/im：浏览器 JWT（Alice）+ device token（模拟设备 Agent）
    const aliceSock = connectIm(aliceToken);
    const deviceSock = connectIm(deviceToken);

    try {
      await Promise.all([
        waitForEvent(aliceSock, "connect"),
        waitForEvent(deviceSock, "connect"),
      ]);
      // onAuthedConnect 异步 join 房间（org/conv/device），emitUntilEvent 的周期重发
      // 已覆盖此竞态，这里额外留个短暂余量与 im-flow.spec.ts 保持一致的稳健性。
      await new Promise((r) => setTimeout(r, 200));

      // 场景 3：浏览器发消息 → 设备收到 im.agent_inbound（定向下发到 device room）
      const inboundPromise = waitForEvent<ImAgentInboundEvent>(
        deviceSock,
        IM_WS_EVENTS.agentInbound,
      );
      const inbound = await emitUntilEvent(
        aliceSock,
        IM_WS_EVENTS.send,
        { conversationId, content: "你好 Agent" },
        inboundPromise,
      );
      expect(inbound.conversationId).toBe(conversationId);
      expect(inbound.content).toBe("你好 Agent");
      expect(inbound.senderUserId).toBe(aliceUserId);
      expect(inbound.messageId).toBeTruthy();

      // 场景 4：设备回流 → 浏览器收到 im.message，senderType='agent' senderId=deviceId
      const agentMsgPromise = waitForFilteredEvent<ImMessage>(
        aliceSock,
        IM_WS_EVENTS.message,
        (m) => m.senderType === "agent" && m.content === "结果",
      );
      const agentMsg = await emitUntilEvent(
        deviceSock,
        IM_WS_EVENTS.send,
        { conversationId, content: "结果" },
        agentMsgPromise,
      );
      expect(agentMsg.conversationId).toBe(conversationId);
      expect(agentMsg.senderType).toBe("agent");
      expect(agentMsg.senderId).toBe(deviceId);

      // 场景 5：GET /api/agent/conversations（deviceToken）含该会话
      const listRes = await request(app.getHttpServer())
        .get("/api/agent/conversations")
        .set("Authorization", `Bearer ${deviceToken}`);
      expect(listRes.body.success).toBe(true);
      const convIds = (
        listRes.body.data as { conversationId: string; orgId: string }[]
      ).map((c) => c.conversationId);
      expect(convIds).toContain(conversationId);
      const listedOrgIds = (
        listRes.body.data as { conversationId: string; orgId: string }[]
      )
        .filter((c) => c.conversationId === conversationId)
        .map((c) => c.orgId);
      expect(listedOrgIds).toEqual([orgId]);

      // 场景 6：在线态 —— device socket 连着时 true
      const onlineRes = await request(app.getHttpServer())
        .get(`/api/devices/${deviceId}/online`)
        .set("Authorization", `Bearer ${aliceToken}`);
      expect(onlineRes.body.data).toEqual({ online: true });

      // 断开前先注册离线 presence 监听，规避「先断开、presence 广播早于监听注册」的竞态
      const offlinePromise = waitForFilteredEvent<PresenceState>(
        aliceSock,
        IM_WS_EVENTS.presence,
        (p) => p.userId === `agent:${deviceId}` && p.online === false,
      );
      deviceSock.disconnect();
      await offlinePromise;

      const offlineRes = await request(app.getHttpServer())
        .get(`/api/devices/${deviceId}/online`)
        .set("Authorization", `Bearer ${aliceToken}`);
      expect(offlineRes.body.data).toEqual({ online: false });
    } finally {
      if (aliceSock.connected) aliceSock.disconnect();
      if (deviceSock.connected) deviceSock.disconnect();
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 场景 7：负面 —— 非本人 deviceId 建 Agent-DM
  // ──────────────────────────────────────────────────────────────────────────
  it("负面：非本人 deviceId 建 Agent-DM → 400 AGENT_DEVICE_INVALID", async () => {
    if (maybeSkip()) return;

    const carolToken0 = await registerAndToken("carol-agentdm@test.io");
    const { token: carolToken } = await createOrgAndSwitch(
      carolToken0,
      "CarolOrg",
    );
    const { deviceId: carolDeviceId } = await provisionDevice(
      carolToken,
      "Carol Device",
    );

    const daveToken0 = await registerAndToken("dave-agentdm@test.io");
    const { token: daveToken } = await createOrgAndSwitch(
      daveToken0,
      "DaveOrg",
    );

    const res = await request(app.getHttpServer())
      .post("/api/agent-dms")
      .set("Authorization", `Bearer ${daveToken}`)
      .send({ deviceId: carolDeviceId });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      success: false,
      code: MainErrorCode.AGENT_DEVICE_INVALID.code,
    });
  });
});
