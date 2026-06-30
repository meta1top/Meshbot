import "reflect-metadata";
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
import { IM_WS_EVENTS, IM_WS_NAMESPACE } from "@meshbot/types";
import type { ConversationSummary, PresenceState } from "@meshbot/types";
import type { INestApplication } from "@nestjs/common";
import { Module } from "@nestjs/common";
import { EventEmitterModule } from "@nestjs/event-emitter";
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
import { io as createClient, type Socket } from "socket.io-client";

import { JwtAuthGuard } from "../../src/auth/jwt-auth.guard";
import { JwtMainStrategy } from "../../src/auth/jwt.strategy";
import { type AppConfig, APP_CONFIG } from "../../src/config/app-config.schema";
import {
  EMAIL_SENDER,
  type EmailSender,
  type InvitationMail,
} from "../../src/email/email-sender";
import { AuthController } from "../../src/rest/auth.controller";
import { OrgController } from "../../src/rest/org.controller";
import { ImController } from "../../src/rest/im.controller";
import { HealthGateway } from "../../src/ws/health.gateway";
import { ImGateway } from "../../src/ws/im.gateway";
import {
  createTestDb,
  isPostgresReachable,
  type TestDbContext,
} from "../setup/test-db";

const I18N_PATH = path.join(__dirname, "..", "..", "i18n");

const TEST_APP_CONFIG = {
  jwt: { secret: "im-e2e-secret", expires: "1h" },
} as AppConfig;

/** 捕获邀请邮件 token。 */
class CaptureEmailSender implements EmailSender {
  last: { to: string; mail: InvitationMail } | null = null;
  async sendInvitation(to: string, mail: InvitationMail): Promise<void> {
    this.last = { to, mail };
  }
}

const captureSender = new CaptureEmailSender();

@Module({
  providers: [{ provide: EMAIL_SENDER, useValue: captureSender }],
  exports: [EMAIL_SENDER],
})
class TestEmailModule {}

/**
 * 等待 socket 收一条事件；超时 fail。
 */
function waitForEvent<T = unknown>(
  socket: Socket,
  event: string,
  timeoutMs = 4_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event);
      reject(
        new Error(`[im-e2e] event "${event}" timeout after ${timeoutMs}ms`),
      );
    }, timeoutMs);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

describe("server-main IM e2e", () => {
  let app: INestApplication;
  let port: number;
  let dbCtx: TestDbContext | null = null;
  let skipReason: string | null = null;

  beforeAll(async () => {
    if (!(await isPostgresReachable())) {
      skipReason = "Postgres unreachable; run `pnpm dev:db:up`";
      console.warn(`[im-flow] ${skipReason}`);
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
          secret: "im-e2e-secret",
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
        MainModule.forRoot({ expiresDays: 7 }),
      ],
      controllers: [AuthController, OrgController, ImController],
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
      throw new Error("无法解析 IM e2e 端口");
    }
    port = addr.port;
  }, 30_000);

  afterAll(async () => {
    if (app) await app.close();
    if (dbCtx) await dbCtx.cleanup();
  });

  function maybeSkip(): boolean {
    if (skipReason) {
      console.warn(`[im-flow] skipping: ${skipReason}`);
      return true;
    }
    return false;
  }

  /** 注册用户并返回 JWT token。 */
  async function registerAndToken(email: string, suffix = ""): Promise<string> {
    const res = await request(app.getHttpServer())
      .post("/api/auth/register")
      .send({
        email,
        password: "password1",
        displayName: email.split("@")[0] + suffix,
      });
    return res.body.data.token as string;
  }

  /**
   * 从 JWT token 中提取 userId（base64 decode middle segment）。
   */
  function parseUserId(token: string): string {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1], "base64").toString(),
    ) as { userId: string };
    return payload.userId;
  }

  /**
   * 建立组织 + 邀请 B + B 接受，返回 { orgId, tokenA, tokenB, userIdA, userIdB }。
   * token 均已含 orgId（通过 switch-org 刷新），供 requireOrg 使用。
   */
  async function setupOrgWithTwoMembers(
    emailA: string,
    emailB: string,
    orgName: string,
  ): Promise<{
    orgId: string;
    tokenA: string;
    tokenB: string;
    userIdA: string;
    userIdB: string;
  }> {
    const tokenA0 = await registerAndToken(emailA);
    const userIdA = parseUserId(tokenA0);

    const orgRes = await request(app.getHttpServer())
      .post("/api/orgs")
      .set("Authorization", `Bearer ${tokenA0}`)
      .send({ name: orgName });
    const orgId = orgRes.body.data.id as string;

    // 建组织后刷新 A 的 token，使其含 orgId
    const switchA = await request(app.getHttpServer())
      .post("/api/auth/switch-org")
      .set("Authorization", `Bearer ${tokenA0}`)
      .send({ orgId });
    const tokenA = switchA.body.data.token as string;

    const inviteRes = await request(app.getHttpServer())
      .post(`/api/orgs/${orgId}/invitations`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ email: emailB });
    const code = inviteRes.body.data.token as string;

    const tokenB0 = await registerAndToken(emailB);
    const userIdB = parseUserId(tokenB0);

    await request(app.getHttpServer())
      .post("/api/orgs/invitations/accept")
      .set("Authorization", `Bearer ${tokenB0}`)
      .send({ token: code });

    // 接受邀请后刷新 B 的 token，使其含 orgId
    const switchB = await request(app.getHttpServer())
      .post("/api/auth/switch-org")
      .set("Authorization", `Bearer ${tokenB0}`)
      .send({ orgId });
    const tokenB = switchB.body.data.token as string;

    return { orgId, tokenA, tokenB, userIdA, userIdB };
  }

  /** 建立 socket.io 连接到 ws/im namespace。 */
  function connectIm(token: string): Socket {
    return createClient(`http://localhost:${port}/${IM_WS_NAMESPACE}`, {
      auth: { token },
      transports: ["websocket"],
      reconnection: false,
      forceNew: true,
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 场景 1：建频道 → 双端 GET /conversations 均可见
  // ──────────────────────────────────────────────────────────────────────────
  it("A 创建频道 → A 和 B 的 GET /conversations 均包含该频道", async () => {
    if (maybeSkip()) return;

    const { tokenA, tokenB } = await setupOrgWithTwoMembers(
      "im-a1@test.io",
      "im-b1@test.io",
      "IMOrg1",
    );

    const chanRes = await request(app.getHttpServer())
      .post("/api/channels")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ name: "general" });
    expect(chanRes.status).toBe(201);
    expect(chanRes.body.success).toBe(true);
    const channelId = chanRes.body.data.id as string;
    expect(channelId).toBeTruthy();
    expect(chanRes.body.data.type).toBe("channel");

    const listA = await request(app.getHttpServer())
      .get("/api/conversations")
      .set("Authorization", `Bearer ${tokenA}`);
    expect(listA.body.success).toBe(true);
    const idListA = (listA.body.data as ConversationSummary[]).map((c) => c.id);
    expect(idListA).toContain(channelId);

    const listB = await request(app.getHttpServer())
      .get("/api/conversations")
      .set("Authorization", `Bearer ${tokenB}`);
    expect(listB.body.success).toBe(true);
    const idListB = (listB.body.data as ConversationSummary[]).map((c) => c.id);
    expect(idListB).toContain(channelId);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 场景 2：WebSocket 消息投递 —— A 发消息 B 收到
  // ──────────────────────────────────────────────────────────────────────────
  it("A 和 B WS 连接 → A emit im.send → B 收到 im.message", async () => {
    if (maybeSkip()) return;

    const { tokenA, tokenB } = await setupOrgWithTwoMembers(
      "im-a2@test.io",
      "im-b2@test.io",
      "IMOrg2",
    );

    // 建频道
    const chanRes = await request(app.getHttpServer())
      .post("/api/channels")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ name: "random" });
    const conversationId = chanRes.body.data.id as string;

    // 连接 WS
    const sockA = connectIm(tokenA);
    const sockB = connectIm(tokenB);

    try {
      // 等双端连接建立
      await Promise.all([
        waitForEvent(sockA, "connect"),
        waitForEvent(sockB, "connect"),
      ]);

      // B 等待收到消息（先注册监听，再由 A 发送）
      const messagePromise = waitForEvent<{
        conversationId: string;
        content: string;
        senderId: string;
      }>(sockB, IM_WS_EVENTS.message);

      // A 发消息
      sockA.emit(IM_WS_EVENTS.send, {
        conversationId,
        content: "hello from A",
      });

      const received = await messagePromise;
      expect(received.content).toBe("hello from A");
      expect(received.conversationId).toBe(conversationId);
    } finally {
      sockA.disconnect();
      sockB.disconnect();
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 场景 3：POST /dms 幂等 —— 调用两次返回相同 conversationId
  // ──────────────────────────────────────────────────────────────────────────
  it("POST /dms 两次 → 返回相同 conversationId（幂等）", async () => {
    if (maybeSkip()) return;

    const { tokenA, userIdB } = await setupOrgWithTwoMembers(
      "im-a3@test.io",
      "im-b3@test.io",
      "IMOrg3",
    );

    const dm1 = await request(app.getHttpServer())
      .post("/api/dms")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ userId: userIdB });
    expect(dm1.body.success).toBe(true);
    const dmId1 = dm1.body.data.id as string;
    expect(dmId1).toBeTruthy();

    const dm2 = await request(app.getHttpServer())
      .post("/api/dms")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ userId: userIdB });
    expect(dm2.body.success).toBe(true);
    const dmId2 = dm2.body.data.id as string;

    expect(dmId1).toBe(dmId2);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 场景 4：可见性 —— 第三用户 C（不同 org）访问频道消息 → CONVERSATION_FORBIDDEN/NOT_FOUND
  // ──────────────────────────────────────────────────────────────────────────
  it("不同 org 用户 C 访问频道消息 → CONVERSATION_FORBIDDEN 或 NOT_FOUND", async () => {
    if (maybeSkip()) return;

    const { tokenA } = await setupOrgWithTwoMembers(
      "im-a4@test.io",
      "im-b4@test.io",
      "IMOrg4",
    );

    // 建频道
    const chanRes = await request(app.getHttpServer())
      .post("/api/channels")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ name: "private-chan" });
    const channelId = chanRes.body.data.id as string;

    // 第三用户 C 在另一个 org（注册后建独立 org，activeOrg = C 自己的 org）
    const tokenC0 = await registerAndToken("im-c4@test.io");
    const orgCRes = await request(app.getHttpServer())
      .post("/api/orgs")
      .set("Authorization", `Bearer ${tokenC0}`)
      .send({ name: "COrg4" });
    const orgCId = orgCRes.body.data.id as string;
    // 刷新 C 的 token 使其含自己的 orgId（否则 requireOrg 抛 2003 而非 2007/2008）
    const switchC = await request(app.getHttpServer())
      .post("/api/auth/switch-org")
      .set("Authorization", `Bearer ${tokenC0}`)
      .send({ orgId: orgCId });
    const tokenC = switchC.body.data.token as string;

    // C 访问 A's 频道消息
    const res = await request(app.getHttpServer())
      .get(`/api/conversations/${channelId}/messages`)
      .set("Authorization", `Bearer ${tokenC}`);

    // 错误码 2007 = CONVERSATION_NOT_FOUND, 2008 = CONVERSATION_FORBIDDEN
    expect(res.body.success).toBe(false);
    expect([2007, 2008]).toContain(res.body.code);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 场景 5：Presence —— A 连接时 B 收到上线通知；A 断开时 B 收到下线通知
  // ──────────────────────────────────────────────────────────────────────────
  it("A WS 连接 → B 收到 im.presence {userId:A, online:true}；A 断开 → B 收到 {online:false}", async () => {
    if (maybeSkip()) return;

    const { tokenA, tokenB, userIdA } = await setupOrgWithTwoMembers(
      "im-a5@test.io",
      "im-b5@test.io",
      "IMOrg5",
    );

    // B 先连接（需要先在 org 房间内才能收到 A 的 presence 广播）
    const sockB = connectIm(tokenB);
    await waitForEvent(sockB, "connect");

    // 等一个短暂时间确保 B 已完成 onAuthedConnect（入 org 房间）
    await new Promise((r) => setTimeout(r, 200));

    try {
      // 注册 B 的 presence 监听，在 A 连接前注册
      const onlinePromise = new Promise<PresenceState>((resolve) => {
        sockB.on(IM_WS_EVENTS.presence, (p: PresenceState) => {
          if (p.userId === userIdA && p.online) {
            resolve(p);
          }
        });
      });
      const onlineTimeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("presence online timeout")), 4_000),
      );

      // A 连接
      const sockA = connectIm(tokenA);
      await waitForEvent(sockA, "connect");
      // presence 上线已改为事件驱动：生产中 server-agent 连上即 emit im.presence_set，
      // gateway 据此 setOnline 并向 org 房间广播。测试显式补发一次，触发对 B 的上线广播。
      sockA.emit(IM_WS_EVENTS.presenceSet, { online: true });

      try {
        // B 收到 A 上线通知
        const onlineEvent = await Promise.race([onlinePromise, onlineTimeout]);
        expect(onlineEvent.userId).toBe(userIdA);
        expect(onlineEvent.online).toBe(true);

        // 注册 A 下线监听
        const offlinePromise = new Promise<PresenceState>((resolve) => {
          sockB.on(IM_WS_EVENTS.presence, (p: PresenceState) => {
            if (p.userId === userIdA && !p.online) {
              resolve(p);
            }
          });
        });
        const offlineTimeout = new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("presence offline timeout")),
            4_000,
          ),
        );

        // A 断开
        sockA.disconnect();

        // B 收到 A 下线通知
        const offlineEvent = await Promise.race([
          offlinePromise,
          offlineTimeout,
        ]);
        expect(offlineEvent.userId).toBe(userIdA);
        expect(offlineEvent.online).toBe(false);
      } finally {
        if (sockA.connected) sockA.disconnect();
      }
    } finally {
      sockB.disconnect();
    }
  });
});
