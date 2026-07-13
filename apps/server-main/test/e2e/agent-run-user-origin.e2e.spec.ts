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
import { MainModule, REDIS_CLIENT } from "@meshbot/main";
import {
  type AgentRunControlInput,
  type AgentRunEnd,
  type AgentRunFrame,
  type AgentRunStartInput,
  type DeviceQueryRequestInput,
  type DeviceQueryResponse,
  IM_WS_EVENTS,
  IM_WS_NAMESPACE,
  type PresenceState,
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
import { AuthController } from "../../src/rest/auth.controller";
import { DeviceAuthController } from "../../src/rest/device-auth.controller";
import { DeviceController } from "../../src/rest/device.controller";
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
  jwt: { secret: "l3-user-origin-e2e-secret", expires: "1h" },
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
 * L3 用户发起方 e2e —— server-main 的 agent.run.* / device.query.* 泛化协议
 * 全链验证（真 socket.io 双角色）：
 *
 * - A：浏览器用户连接（web-main，用户 JWT，`requesterDeviceId` 编码为 `"user:" + socketId`）
 * - B：设备连接（本地 Agent，device token，room 语义稳定）
 *
 * A、B 属于同一账号（B 是 A 的自有设备）——与 `im-flow.spec.ts` 的「同 org 两成员」
 * 场景不同，这里校验的是 `target.userId === requesterUserId` 的自有设备路由。
 */
describe("server-main L3 用户发起方 e2e（真 WS 双角色）", () => {
  let app: INestApplication;
  let port: number;
  let dbCtx: TestDbContext | null = null;
  let skipReason: string | null = null;

  beforeAll(async () => {
    if (!(await isPostgresReachable())) {
      skipReason = "Postgres unreachable; run `pnpm dev:db:up`";
      console.warn(`[agent-run-user-origin] ${skipReason}`);
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
          secret: "l3-user-origin-e2e-secret",
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
      throw new Error("无法解析 e2e 端口");
    }
    port = addr.port;
  }, 30_000);

  afterAll(async () => {
    if (app) await app.close();
    if (dbCtx) await dbCtx.cleanup();
  });

  function maybeSkip(): boolean {
    if (skipReason) {
      console.warn(`[agent-run-user-origin] skipping: ${skipReason}`);
      return true;
    }
    return false;
  }

  async function registerAndToken(email: string): Promise<string> {
    return registerAndVerify(app, captureSender, email);
  }

  function parseUserId(token: string): string {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1], "base64").toString(),
    ) as { userId: string };
    return payload.userId;
  }

  /** 建立 socket.io 连接到 ws/im namespace（用户 JWT 或设备 token 均走此入口）。 */
  function connectSocket(token: string): Socket {
    return createClient(`http://localhost:${port}/${IM_WS_NAMESPACE}`, {
      auth: { token },
      transports: ["websocket"],
      reconnection: false,
      forceNew: true,
    });
  }

  /**
   * 用已登录用户 token 为其新增一台设备（device-auth start → approve → exchange），
   * 按 `deviceName` 从 `/api/devices` 找回新建行拿到 `deviceId`。
   * 不传 machineId：DeviceService.issueDevice 无 machineId 时每次新建，天然互不复用。
   */
  async function addDevice(
    userToken: string,
    deviceName: string,
  ): Promise<{ deviceToken: string; deviceId: string }> {
    const { verifier, challenge } = makePkce();
    const startRes = await request(app.getHttpServer())
      .post("/api/device-auth/start")
      .send({ deviceName, platform: "darwin", codeChallenge: challenge });
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
    const row = (listRes.body.data as Array<{ id: string; name: string }>).find(
      (d) => d.name === deviceName,
    );
    if (!row) throw new Error(`未找到设备 ${deviceName}`);

    return { deviceToken, deviceId: row.id };
  }

  /**
   * 注册用户 + 建组织（自动设为 activeOrgId）+ 为其注册一台设备，返回双端凭据。
   * A（浏览器用户连接）与 B（设备连接）属于同一账号——L3 自有设备路由场景。
   */
  async function setupUserWithDevice(
    email: string,
    orgName: string,
    deviceName: string,
  ): Promise<{
    userToken: string;
    userId: string;
    orgId: string;
    deviceToken: string;
    deviceId: string;
  }> {
    const userToken = await registerAndToken(email);
    const userId = parseUserId(userToken);

    const orgRes = await request(app.getHttpServer())
      .post("/api/orgs")
      .set("Authorization", `Bearer ${userToken}`)
      .send({ name: orgName });
    const orgId = orgRes.body.data.id as string;

    const { deviceToken, deviceId } = await addDevice(userToken, deviceName);

    return { userToken, userId, orgId, deviceToken, deviceId };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 用例 1-3：A(user) 发起 run → B(device) 收 start；B 回帧/结束 → A 收到
  // ──────────────────────────────────────────────────────────────────────────
  it("A(user) emit agentRunStart → B 收到 start(requesterDeviceId 前缀 user:)；B frame/end → A 收到", async () => {
    if (maybeSkip()) return;

    const { userToken, deviceToken, deviceId } = await setupUserWithDevice(
      "l3-a1@test.io",
      "L3Org1",
      "L3Device1",
    );

    const sockA = connectSocket(userToken);
    const sockB = connectSocket(deviceToken);
    try {
      await Promise.all([
        waitForEvent(sockA, "connect"),
        waitForEvent(sockB, "connect"),
      ]);

      const streamId = `stream-${Date.now()}`;
      const startPayload: AgentRunStartInput = {
        streamId,
        targetDeviceId: deviceId,
        mode: "create",
        content: "hello agent",
      };

      // 用例1：A start → B 收到，requesterDeviceId 前缀 "user:"
      const startPromise = waitForEvent<
        AgentRunStartInput & { requesterDeviceId: string }
      >(sockB, IM_WS_EVENTS.agentRunStart);
      const startReceived = await emitUntilEvent(
        sockA,
        IM_WS_EVENTS.agentRunStart,
        startPayload,
        startPromise,
      );
      expect(startReceived.streamId).toBe(streamId);
      expect(startReceived.mode).toBe("create");
      expect(startReceived.content).toBe("hello agent");
      expect(startReceived.requesterDeviceId.startsWith("user:")).toBe(true);

      // 用例2：B frame → A 收到，requesterDeviceId 原样回填(不解析)
      const framePromise = waitForEvent<AgentRunFrame>(
        sockA,
        IM_WS_EVENTS.agentRunFrame,
      );
      sockB.emit(IM_WS_EVENTS.agentRunFrame, {
        streamId,
        requesterDeviceId: startReceived.requesterDeviceId,
        seq: 1,
        sessionId: "sess-1",
        event: "chunk",
        payload: { text: "hi" },
      } satisfies AgentRunFrame);
      const frameReceived = await framePromise;
      expect(frameReceived.requesterDeviceId).toBe(
        startReceived.requesterDeviceId,
      );
      expect(frameReceived.seq).toBe(1);
      expect(frameReceived.sessionId).toBe("sess-1");

      // 用例3：B end → A 收到
      const endPromise = waitForEvent<AgentRunEnd>(
        sockA,
        IM_WS_EVENTS.agentRunEnd,
      );
      sockB.emit(IM_WS_EVENTS.agentRunEnd, {
        streamId,
        requesterDeviceId: startReceived.requesterDeviceId,
        reason: "done",
      } satisfies AgentRunEnd);
      const endReceived = await endPromise;
      expect(endReceived.reason).toBe("done");
      expect(endReceived.streamId).toBe(streamId);
    } finally {
      sockA.disconnect();
      sockB.disconnect();
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 用例 4：A control → B 收到；越权用户 C 用同 streamId 发 control → B 不应收到
  // ──────────────────────────────────────────────────────────────────────────
  it("A emit agentRunControl → B 收到；另一用户 C 用同 streamId 发 control → B 不收到（越权拒）", async () => {
    if (maybeSkip()) return;

    const { userToken, deviceToken, deviceId } = await setupUserWithDevice(
      "l3-a4@test.io",
      "L3Org4",
      "L3Device4",
    );
    const tokenC = await registerAndToken("l3-c4@test.io");

    const sockA = connectSocket(userToken);
    const sockB = connectSocket(deviceToken);
    const sockC = connectSocket(tokenC);
    try {
      await Promise.all([
        waitForEvent(sockA, "connect"),
        waitForEvent(sockB, "connect"),
        waitForEvent(sockC, "connect"),
      ]);

      const streamId = `stream-ctl-${Date.now()}`;

      // 先建立路由：A start，等 B 收到（确保 B 已在线且路由已登记）
      const startPromise = waitForEvent(sockB, IM_WS_EVENTS.agentRunStart);
      await emitUntilEvent(
        sockA,
        IM_WS_EVENTS.agentRunStart,
        {
          streamId,
          targetDeviceId: deviceId,
          mode: "create",
          content: "x",
        } satisfies AgentRunStartInput,
        startPromise,
      );

      const controlPayload: AgentRunControlInput = {
        streamId,
        targetDeviceId: deviceId,
        sessionId: "sess-ctl",
        kind: "interrupt",
      };

      // A control → B 收到
      const controlPromise = waitForEvent<
        AgentRunControlInput & { requesterDeviceId: string }
      >(sockB, IM_WS_EVENTS.agentRunControl);
      const controlReceived = await emitUntilEvent(
        sockA,
        IM_WS_EVENTS.agentRunControl,
        controlPayload,
        controlPromise,
      );
      expect(controlReceived.kind).toBe("interrupt");
      expect(controlReceived.requesterDeviceId.startsWith("user:")).toBe(true);

      // C（另一用户，与该 streamId 无关）用同 streamId 发 control → B 不应收到
      let unauthorizedReceived = false;
      sockB.once(IM_WS_EVENTS.agentRunControl, () => {
        unauthorizedReceived = true;
      });
      sockC.emit(IM_WS_EVENTS.agentRunControl, controlPayload);
      await new Promise((r) => setTimeout(r, 600));
      expect(unauthorizedReceived).toBe(false);
    } finally {
      sockA.disconnect();
      sockB.disconnect();
      sockC.disconnect();
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 用例 5：A 断开重连后 B 再回流帧 → 无人收到且不报错（路由已清理）
  // ──────────────────────────────────────────────────────────────────────────
  it("A 断开重连(新 socket)后 B 用旧 streamId 回流帧 → 无人收到且不报错（路由已清理）", async () => {
    if (maybeSkip()) return;

    const { userToken, userId, deviceToken, deviceId } =
      await setupUserWithDevice("l3-a5@test.io", "L3Org5", "L3Device5");

    const sockB = connectSocket(deviceToken);
    await waitForEvent(sockB, "connect");

    const sockA = connectSocket(userToken);
    try {
      await waitForEvent(sockA, "connect");

      const streamId = `stream-reconnect-${Date.now()}`;
      const startPromise = waitForEvent(sockB, IM_WS_EVENTS.agentRunStart);
      await emitUntilEvent(
        sockA,
        IM_WS_EVENTS.agentRunStart,
        {
          streamId,
          targetDeviceId: deviceId,
          mode: "create",
          content: "x",
        } satisfies AgentRunStartInput,
        startPromise,
      );

      // 哨兵：B 等 A 的下线 presence 广播作为「handleDisconnect 已跑完 cleanupRoutes」
      // 的信号 —— cleanupRoutes 在 handleDisconnect 内严格先于 presence 下线广播
      // 执行（同一异步函数体顺序代码），比写死 sleep 更贴合真实时序。
      const offlineSentinel = new Promise<void>((resolve) => {
        const handler = (p: PresenceState) => {
          if (p.userId === userId && !p.online) {
            sockB.off(IM_WS_EVENTS.presence, handler);
            resolve();
          }
        };
        sockB.on(IM_WS_EVENTS.presence, handler);
      });
      const offlineTimeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("等待 A 下线广播超时")), 4_000),
      );

      sockA.disconnect();
      await Promise.race([offlineSentinel, offlineTimeout]);

      // 新 socket 重连 A
      const sockA2 = connectSocket(userToken);
      try {
        await waitForEvent(sockA2, "connect");

        let gotFrame = false;
        sockA2.once(IM_WS_EVENTS.agentRunFrame, () => {
          gotFrame = true;
        });

        // B 用旧 streamId 回流帧（路由已被 A 断连清理，应被静默丢弃）
        sockB.emit(IM_WS_EVENTS.agentRunFrame, {
          streamId,
          requesterDeviceId: "user:stale",
          seq: 1,
          sessionId: "sess-stale",
          event: "chunk",
          payload: {},
        } satisfies AgentRunFrame);

        await new Promise((r) => setTimeout(r, 600));
        expect(gotFrame).toBe(false);

        // 服务未崩：B 在同一连接上仍能正常发起后续动作（如再次收到心跳级 ping 无异常）
        sockB.emit(IM_WS_EVENTS.ping, {});
      } finally {
        sockA2.disconnect();
      }
    } finally {
      if (sockA.connected) sockA.disconnect();
      sockB.disconnect();
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 用例 5 变体：同一用户两个 socket（多标签）各自 streamId 互不串
  // ──────────────────────────────────────────────────────────────────────────
  it("同一用户两个 socket(多标签) 各自 streamId 互不串", async () => {
    if (maybeSkip()) return;

    const { userToken, deviceToken, deviceId } = await setupUserWithDevice(
      "l3-a5b@test.io",
      "L3Org5b",
      "L3Device5b",
    );

    const sockA1 = connectSocket(userToken);
    const sockA2 = connectSocket(userToken);
    const sockB = connectSocket(deviceToken);
    try {
      await Promise.all([
        waitForEvent(sockA1, "connect"),
        waitForEvent(sockA2, "connect"),
        waitForEvent(sockB, "connect"),
      ]);

      const stream1 = `tab1-${Date.now()}`;
      const stream2 = `tab2-${Date.now()}`;

      const start1Promise = waitForEvent<
        AgentRunStartInput & { requesterDeviceId: string }
      >(sockB, IM_WS_EVENTS.agentRunStart);
      const start1 = await emitUntilEvent(
        sockA1,
        IM_WS_EVENTS.agentRunStart,
        {
          streamId: stream1,
          targetDeviceId: deviceId,
          mode: "create",
          content: "tab1",
        } satisfies AgentRunStartInput,
        start1Promise,
      );

      const start2Promise = waitForEvent<
        AgentRunStartInput & { requesterDeviceId: string }
      >(sockB, IM_WS_EVENTS.agentRunStart);
      const start2 = await emitUntilEvent(
        sockA2,
        IM_WS_EVENTS.agentRunStart,
        {
          streamId: stream2,
          targetDeviceId: deviceId,
          mode: "create",
          content: "tab2",
        } satisfies AgentRunStartInput,
        start2Promise,
      );

      // 两个 tab 各自 socketId 编码不同，requesterDeviceId 必须不同
      expect(start1.requesterDeviceId).not.toBe(start2.requesterDeviceId);

      // B 回 stream1 帧 → 只有 A1 收到，A2 不收到
      let a2GotFrame = false;
      sockA2.once(IM_WS_EVENTS.agentRunFrame, () => {
        a2GotFrame = true;
      });
      const frame1Promise = waitForEvent<AgentRunFrame>(
        sockA1,
        IM_WS_EVENTS.agentRunFrame,
      );
      sockB.emit(IM_WS_EVENTS.agentRunFrame, {
        streamId: stream1,
        requesterDeviceId: start1.requesterDeviceId,
        seq: 1,
        sessionId: "s1",
        event: "chunk",
        payload: {},
      } satisfies AgentRunFrame);
      const frame1 = await frame1Promise;
      expect(frame1.streamId).toBe(stream1);
      await new Promise((r) => setTimeout(r, 300));
      expect(a2GotFrame).toBe(false);

      // B 回 stream2 帧 → 只有 A2 收到，A1 不收到
      let a1GotExtra = false;
      sockA1.once(IM_WS_EVENTS.agentRunFrame, () => {
        a1GotExtra = true;
      });
      const frame2Promise = waitForEvent<AgentRunFrame>(
        sockA2,
        IM_WS_EVENTS.agentRunFrame,
      );
      sockB.emit(IM_WS_EVENTS.agentRunFrame, {
        streamId: stream2,
        requesterDeviceId: start2.requesterDeviceId,
        seq: 1,
        sessionId: "s2",
        event: "chunk",
        payload: {},
      } satisfies AgentRunFrame);
      const frame2 = await frame2Promise;
      expect(frame2.streamId).toBe(stream2);
      await new Promise((r) => setTimeout(r, 300));
      expect(a1GotExtra).toBe(false);
    } finally {
      sockA1.disconnect();
      sockA2.disconnect();
      sockB.disconnect();
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 用例 6：deviceQuery：A 请求 → B 收到并回 response → A 收到；
  // 一次性路由（用后即删）/ 发送方须=登记目标设备 / 未登记 correlationId 均不送达
  // ──────────────────────────────────────────────────────────────────────────
  it("deviceQueryRequest/Response 全链 + 一次性路由语义（用后即删/发送方须=目标设备/伪造 correlationId 不送达）", async () => {
    if (maybeSkip()) return;

    const { userToken, deviceToken, deviceId } = await setupUserWithDevice(
      "l3-a6@test.io",
      "L3Org6",
      "L3Device6",
    );
    // 同账号第二台设备（非查询目标），用于验证"发送方必须=登记的目标设备"
    const { deviceToken: otherDeviceToken } = await addDevice(
      userToken,
      "L3Device6b",
    );

    const sockA = connectSocket(userToken);
    const sockB = connectSocket(deviceToken);
    const sockOther = connectSocket(otherDeviceToken);
    try {
      await Promise.all([
        waitForEvent(sockA, "connect"),
        waitForEvent(sockB, "connect"),
        waitForEvent(sockOther, "connect"),
      ]);

      const correlationId = `corr-${Date.now()}`;
      const reqPromise = waitForEvent<
        DeviceQueryRequestInput & { requesterDeviceId: string }
      >(sockB, IM_WS_EVENTS.deviceQueryRequest);
      const reqReceived = await emitUntilEvent(
        sockA,
        IM_WS_EVENTS.deviceQueryRequest,
        {
          correlationId,
          targetDeviceId: deviceId,
          kind: "sessions",
          params: {},
        } satisfies DeviceQueryRequestInput,
        reqPromise,
      );
      expect(reqReceived.correlationId).toBe(correlationId);
      expect(reqReceived.requesterDeviceId.startsWith("user:")).toBe(true);

      // B 正常响应 → A 收到
      const respPromise = waitForEvent<DeviceQueryResponse>(
        sockA,
        IM_WS_EVENTS.deviceQueryResponse,
      );
      sockB.emit(IM_WS_EVENTS.deviceQueryResponse, {
        correlationId,
        requesterDeviceId: reqReceived.requesterDeviceId,
        ok: true,
        data: [],
      } satisfies DeviceQueryResponse);
      const resp = await respPromise;
      expect(resp.ok).toBe(true);
      expect(resp.correlationId).toBe(correlationId);

      // 用后即删：B 再次用同 correlationId 响应 → A 不应再收到
      let secondReceived = false;
      sockA.once(IM_WS_EVENTS.deviceQueryResponse, () => {
        secondReceived = true;
      });
      sockB.emit(IM_WS_EVENTS.deviceQueryResponse, {
        correlationId,
        requesterDeviceId: reqReceived.requesterDeviceId,
        ok: true,
        data: [],
      } satisfies DeviceQueryResponse);
      await new Promise((r) => setTimeout(r, 500));
      expect(secondReceived).toBe(false);

      // 发送方必须 = 登记的目标设备：新开一个 correlationId，让"非目标设备"抢先伪造响应
      const correlationId2 = `corr2-${Date.now()}`;
      const req2Promise = waitForEvent<
        DeviceQueryRequestInput & { requesterDeviceId: string }
      >(sockB, IM_WS_EVENTS.deviceQueryRequest);
      const req2Received = await emitUntilEvent(
        sockA,
        IM_WS_EVENTS.deviceQueryRequest,
        {
          correlationId: correlationId2,
          targetDeviceId: deviceId,
          kind: "sessions",
          params: {},
        } satisfies DeviceQueryRequestInput,
        req2Promise,
      );

      let forgedReceived = false;
      sockA.once(IM_WS_EVENTS.deviceQueryResponse, () => {
        forgedReceived = true;
      });
      sockOther.emit(IM_WS_EVENTS.deviceQueryResponse, {
        correlationId: correlationId2,
        requesterDeviceId: req2Received.requesterDeviceId,
        ok: true,
        data: ["forged"],
      } satisfies DeviceQueryResponse);
      await new Promise((r) => setTimeout(r, 500));
      expect(forgedReceived).toBe(false);

      // 真正目标设备 B 事后正常回应同一 correlationId2 → 证明伪造尝试未破坏路由登记
      const resp2Promise = waitForEvent<DeviceQueryResponse>(
        sockA,
        IM_WS_EVENTS.deviceQueryResponse,
      );
      sockB.emit(IM_WS_EVENTS.deviceQueryResponse, {
        correlationId: correlationId2,
        requesterDeviceId: req2Received.requesterDeviceId,
        ok: true,
        data: ["real"],
      } satisfies DeviceQueryResponse);
      const resp2 = await resp2Promise;
      expect(resp2.data).toEqual(["real"]);

      // 伪造/未登记 correlationId（从未被 A 发起过）→ B 直接回应也不应送达
      let unknownReceived = false;
      sockA.once(IM_WS_EVENTS.deviceQueryResponse, () => {
        unknownReceived = true;
      });
      sockB.emit(IM_WS_EVENTS.deviceQueryResponse, {
        correlationId: `unregistered-${Date.now()}`,
        requesterDeviceId: req2Received.requesterDeviceId,
        ok: true,
        data: [],
      } satisfies DeviceQueryResponse);
      await new Promise((r) => setTimeout(r, 500));
      expect(unknownReceived).toBe(false);
    } finally {
      sockA.disconnect();
      sockB.disconnect();
      sockOther.disconnect();
    }
  });
});
