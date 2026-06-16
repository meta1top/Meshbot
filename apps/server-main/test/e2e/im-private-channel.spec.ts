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
import { MainModule, REDIS_CLIENT } from "@meshbot/main";
import type { ChannelMember, ConversationSummary } from "@meshbot/types";
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
  jwt: { secret: "im-private-e2e-secret", expires: "1h" },
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

describe("server-main 私有频道 e2e", () => {
  let app: INestApplication;
  let dbCtx: TestDbContext | null = null;
  let skipReason: string | null = null;

  beforeAll(async () => {
    if (!(await isPostgresReachable())) {
      skipReason = "Postgres unreachable; run `pnpm dev:db:up`";
      console.warn(`[im-private-channel] ${skipReason}`);
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
          secret: "im-private-e2e-secret",
          signOptions: { expiresIn: "1h" },
        }),
        TestEmailModule,
        EventEmitterModule.forRoot(),
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
  }, 30_000);

  afterAll(async () => {
    if (app) await app.close();
    if (dbCtx) await dbCtx.cleanup();
  });

  function maybeSkip(): boolean {
    if (skipReason) {
      console.warn(`[im-private-channel] skipping: ${skipReason}`);
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

  /** 从 JWT token 中提取 userId（base64 decode middle segment）。 */
  function parseUserId(token: string): string {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1], "base64").toString(),
    ) as { sub: string };
    return payload.sub;
  }

  /**
   * 建立组织，A 邀请 B 和 C，B 和 C 接受邀请。
   * 返回三人的 token 和 userId，以及 orgId。
   */
  async function setupOrgWithThreeMembers(
    emailA: string,
    emailB: string,
    emailC: string,
    orgName: string,
  ): Promise<{
    orgId: string;
    tokenA: string;
    tokenB: string;
    tokenC: string;
    userIdA: string;
    userIdB: string;
    userIdC: string;
  }> {
    const tokenA = await registerAndToken(emailA);
    const userIdA = parseUserId(tokenA);

    const orgRes = await request(app.getHttpServer())
      .post("/api/orgs")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ name: orgName });
    const orgId = orgRes.body.data.id as string;

    // 邀请 B
    const inviteResB = await request(app.getHttpServer())
      .post(`/api/orgs/${orgId}/invitations`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ email: emailB });
    const codeB = inviteResB.body.data.token as string;

    const tokenB = await registerAndToken(emailB);
    const userIdB = parseUserId(tokenB);

    await request(app.getHttpServer())
      .post("/api/orgs/invitations/accept")
      .set("Authorization", `Bearer ${tokenB}`)
      .send({ token: codeB });

    // 邀请 C
    const inviteResC = await request(app.getHttpServer())
      .post(`/api/orgs/${orgId}/invitations`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ email: emailC });
    const codeC = inviteResC.body.data.token as string;

    const tokenC = await registerAndToken(emailC);
    const userIdC = parseUserId(tokenC);

    await request(app.getHttpServer())
      .post("/api/orgs/invitations/accept")
      .set("Authorization", `Bearer ${tokenC}`)
      .send({ token: codeC });

    return { orgId, tokenA, tokenB, tokenC, userIdA, userIdB, userIdC };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 场景 1：A 创建私有频道，指定初始成员 B，返回 visibility === "private"
  // ──────────────────────────────────────────────────────────────────────────
  it("A 创建私有频道 → 200，visibility === 'private'", async () => {
    if (maybeSkip()) return;

    const { tokenA, userIdB } = await setupOrgWithThreeMembers(
      "pch-a1@test.io",
      "pch-b1@test.io",
      "pch-c1@test.io",
      "PChOrg1",
    );

    const chanRes = await request(app.getHttpServer())
      .post("/api/channels")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ name: "私有频道", visibility: "private", memberIds: [userIdB] });

    expect(chanRes.status).toBe(201);
    expect(chanRes.body.success).toBe(true);
    expect(chanRes.body.data.visibility).toBe("private");
    expect(chanRes.body.data.type).toBe("channel");
    expect(chanRes.body.data.id).toBeTruthy();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 场景 2：A 和 B 可见该私有频道；C 不可见
  // ──────────────────────────────────────────────────────────────────────────
  it("A 和 B GET /conversations 包含私有频道；C 不包含", async () => {
    if (maybeSkip()) return;

    const { tokenA, tokenB, tokenC, userIdB } = await setupOrgWithThreeMembers(
      "pch-a2@test.io",
      "pch-b2@test.io",
      "pch-c2@test.io",
      "PChOrg2",
    );

    const chanRes = await request(app.getHttpServer())
      .post("/api/channels")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ name: "私有频道2", visibility: "private", memberIds: [userIdB] });
    const channelId = chanRes.body.data.id as string;

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

    const listC = await request(app.getHttpServer())
      .get("/api/conversations")
      .set("Authorization", `Bearer ${tokenC}`);
    expect(listC.body.success).toBe(true);
    const idListC = (listC.body.data as ConversationSummary[]).map((c) => c.id);
    expect(idListC).not.toContain(channelId);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 场景 3：C（非成员）访问私有频道消息 → CONVERSATION_FORBIDDEN (2008)
  // ──────────────────────────────────────────────────────────────────────────
  it("C 访问私有频道消息 → business error code 2008 (CONVERSATION_FORBIDDEN)", async () => {
    if (maybeSkip()) return;

    const { tokenA, tokenC, userIdB } = await setupOrgWithThreeMembers(
      "pch-a3@test.io",
      "pch-b3@test.io",
      "pch-c3@test.io",
      "PChOrg3",
    );

    const chanRes = await request(app.getHttpServer())
      .post("/api/channels")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ name: "私有频道3", visibility: "private", memberIds: [userIdB] });
    const channelId = chanRes.body.data.id as string;

    const res = await request(app.getHttpServer())
      .get(`/api/conversations/${channelId}/messages`)
      .set("Authorization", `Bearer ${tokenC}`);

    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe(2008);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 场景 4：负向测试
  //   4a. C（非成员）尝试拉人 → 2008
  //   4b. A 拉入一个不属于本 org 的随机 UUID → 2011
  // ──────────────────────────────────────────────────────────────────────────
  it("C（非成员）拉人 → 2008；A 拉不存在的 org 用户 → 2011", async () => {
    if (maybeSkip()) return;

    const { tokenA, tokenC, userIdB } = await setupOrgWithThreeMembers(
      "pch-a4@test.io",
      "pch-b4@test.io",
      "pch-c4@test.io",
      "PChOrg4",
    );

    const chanRes = await request(app.getHttpServer())
      .post("/api/channels")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ name: "私有频道4", visibility: "private", memberIds: [userIdB] });
    const channelId = chanRes.body.data.id as string;

    // 4a: C（非成员）拉人 → 2008
    const resC = await request(app.getHttpServer())
      .post(`/api/channels/${channelId}/members`)
      .set("Authorization", `Bearer ${tokenC}`)
      .send({ userId: userIdB });
    expect(resC.body.success).toBe(false);
    expect(resC.body.code).toBe(2008);

    // 4b: A 拉入不在 org 内的随机 UUID → 2011
    const randomUuid = "00000000-0000-4000-a000-000000000001";
    const resInvalid = await request(app.getHttpServer())
      .post(`/api/channels/${channelId}/members`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ userId: randomUuid });
    expect(resInvalid.body.success).toBe(false);
    expect(resInvalid.body.code).toBe(2011);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 场景 5：A 拉入 C → C 可见频道；GET /channels/:id/members 包含 A、B、C
  // ──────────────────────────────────────────────────────────────────────────
  it("A 拉 C 入私有频道 → C GET /conversations 包含；members 列表含 A、B、C", async () => {
    if (maybeSkip()) return;

    const { tokenA, tokenC, userIdA, userIdB, userIdC } =
      await setupOrgWithThreeMembers(
        "pch-a5@test.io",
        "pch-b5@test.io",
        "pch-c5@test.io",
        "PChOrg5",
      );

    const chanRes = await request(app.getHttpServer())
      .post("/api/channels")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ name: "私有频道5", visibility: "private", memberIds: [userIdB] });
    const channelId = chanRes.body.data.id as string;

    // A 拉入 C
    const addRes = await request(app.getHttpServer())
      .post(`/api/channels/${channelId}/members`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ userId: userIdC });
    expect(addRes.status).toBe(201);
    expect(addRes.body.success).toBe(true);

    // C 现在可见
    const listC = await request(app.getHttpServer())
      .get("/api/conversations")
      .set("Authorization", `Bearer ${tokenC}`);
    expect(listC.body.success).toBe(true);
    const idListC = (listC.body.data as ConversationSummary[]).map((c) => c.id);
    expect(idListC).toContain(channelId);

    // members 列表包含 A、B、C
    const membersRes = await request(app.getHttpServer())
      .get(`/api/channels/${channelId}/members`)
      .set("Authorization", `Bearer ${tokenA}`);
    expect(membersRes.status).toBe(200);
    expect(membersRes.body.success).toBe(true);
    const memberIds = (membersRes.body.data as ChannelMember[]).map(
      (m) => m.userId,
    );
    expect(memberIds).toContain(userIdA);
    expect(memberIds).toContain(userIdB);
    expect(memberIds).toContain(userIdC);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 场景 6：C 退出私有频道 → C GET /conversations 不再包含
  // ──────────────────────────────────────────────────────────────────────────
  it("C 退出私有频道 → C GET /conversations 不再包含", async () => {
    if (maybeSkip()) return;

    const { tokenA, tokenC, userIdB, userIdC } = await setupOrgWithThreeMembers(
      "pch-a6@test.io",
      "pch-b6@test.io",
      "pch-c6@test.io",
      "PChOrg6",
    );

    const chanRes = await request(app.getHttpServer())
      .post("/api/channels")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({
        name: "私有频道6",
        visibility: "private",
        memberIds: [userIdB, userIdC],
      });
    const channelId = chanRes.body.data.id as string;

    // 确认 C 已在频道内
    const listBefore = await request(app.getHttpServer())
      .get("/api/conversations")
      .set("Authorization", `Bearer ${tokenC}`);
    const idListBefore = (listBefore.body.data as ConversationSummary[]).map(
      (c) => c.id,
    );
    expect(idListBefore).toContain(channelId);

    // C 退出
    const leaveRes = await request(app.getHttpServer())
      .delete(`/api/channels/${channelId}/members/me`)
      .set("Authorization", `Bearer ${tokenC}`);
    expect(leaveRes.status).toBe(200);
    expect(leaveRes.body.success).toBe(true);

    // C 不再可见
    const listAfter = await request(app.getHttpServer())
      .get("/api/conversations")
      .set("Authorization", `Bearer ${tokenC}`);
    expect(listAfter.body.success).toBe(true);
    const idListAfter = (listAfter.body.data as ConversationSummary[]).map(
      (c) => c.id,
    );
    expect(idListAfter).not.toContain(channelId);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 场景 7：公开频道对 C 可见（sanity）
  // ──────────────────────────────────────────────────────────────────────────
  it("A 创建公开频道 → C GET /conversations 包含（公开可见）", async () => {
    if (maybeSkip()) return;

    const { tokenA, tokenC } = await setupOrgWithThreeMembers(
      "pch-a7@test.io",
      "pch-b7@test.io",
      "pch-c7@test.io",
      "PChOrg7",
    );

    const chanRes = await request(app.getHttpServer())
      .post("/api/channels")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ name: "公开频道7", visibility: "public" });
    expect(chanRes.status).toBe(201);
    expect(chanRes.body.success).toBe(true);
    const channelId = chanRes.body.data.id as string;

    const listC = await request(app.getHttpServer())
      .get("/api/conversations")
      .set("Authorization", `Bearer ${tokenC}`);
    expect(listC.body.success).toBe(true);
    const idListC = (listC.body.data as ConversationSummary[]).map((c) => c.id);
    expect(idListC).toContain(channelId);
  });
});
