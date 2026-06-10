import "reflect-metadata";
import path from "node:path";
import {
  CommonModule,
  ErrorsFilter,
  I18nZodValidationPipe,
  ResponseInterceptor,
  traceIdMiddleware,
} from "@meshbot/common";
import { MainModule } from "@meshbot/main";
import type { INestApplication } from "@nestjs/common";
import { Module } from "@nestjs/common";
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
import {
  createTestDb,
  isPostgresReachable,
  type TestDbContext,
} from "../setup/test-db";

const I18N_PATH = path.join(__dirname, "..", "..", "i18n");

// e2e 只消费 config.jwt，partial cast 即可
const TEST_APP_CONFIG = {
  jwt: { secret: "e2e-test-secret", expires: "1h" },
} as AppConfig;

/** 测试用 EmailSender：捕获最后一次邀请，供断言邀请码。 */
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

describe("server-main org e2e", () => {
  let app: INestApplication;
  let dbCtx: TestDbContext | null = null;
  let skipReason: string | null = null;

  beforeAll(async () => {
    if (!(await isPostgresReachable())) {
      skipReason = "Postgres unreachable; run `pnpm dev:db:up`";
      console.warn(`[org-flow] ${skipReason}`);
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
        MainModule.forRoot({ expiresDays: 7 }),
      ],
      controllers: [AuthController, OrgController],
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
      console.warn(`[org-flow] skipping: ${skipReason}`);
      return true;
    }
    return false;
  }

  async function registerAndToken(email: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post("/api/auth/register")
      .send({ email, password: "password1", displayName: email.split("@")[0] });
    return res.body.data.token as string;
  }

  it("建组织 → 邀请 → 第二用户接受 → 成员列表含两人", async () => {
    if (maybeSkip()) return;
    const aliceToken = await registerAndToken("alice@org.io");

    const orgRes = await request(app.getHttpServer())
      .post("/api/orgs")
      .set("Authorization", `Bearer ${aliceToken}`)
      .send({ name: "Acme" });
    expect(orgRes.body).toMatchObject({ success: true });
    const orgId = orgRes.body.data.id as string;
    expect(orgRes.body.data.role).toBe("owner");

    const profileRes = await request(app.getHttpServer())
      .get("/api/auth/profile")
      .set("Authorization", `Bearer ${aliceToken}`);
    expect(profileRes.body.data.activeOrg.id).toBe(orgId);

    const inviteRes = await request(app.getHttpServer())
      .post(`/api/orgs/${orgId}/invitations`)
      .set("Authorization", `Bearer ${aliceToken}`)
      .send({ email: "bob@org.io" });
    expect(inviteRes.body).toMatchObject({ success: true });
    const code = inviteRes.body.data.token as string;
    expect(code).toMatch(/^[0-9a-f]{48}$/);
    expect(captureSender.last?.to).toBe("bob@org.io");
    expect(captureSender.last?.mail.code).toBe(code);

    const bobToken = await registerAndToken("bob@org.io");
    const acceptRes = await request(app.getHttpServer())
      .post("/api/orgs/invitations/accept")
      .set("Authorization", `Bearer ${bobToken}`)
      .send({ token: code });
    expect(acceptRes.body).toMatchObject({ success: true });
    expect(acceptRes.body.data.orgName).toBe("Acme");

    const membersRes = await request(app.getHttpServer())
      .get(`/api/orgs/${orgId}/members`)
      .set("Authorization", `Bearer ${aliceToken}`);
    const members = membersRes.body.data as Array<{
      userId: string;
      email: string;
      displayName: string;
      role: string;
    }>;
    const emails = members.map((m) => m.email).sort();
    expect(emails).toEqual(["alice@org.io", "bob@org.io"]);
    // 锁定 getRawMany 别名大小写：camelCase 字段必须存在
    for (const m of members) {
      expect(m.userId).toBeTruthy();
      expect(m.displayName).toBeTruthy();
      expect(["owner", "member"]).toContain(m.role);
    }

    // bob 的 profile：活跃组织被设为加入的组织
    const bobProfile = await request(app.getHttpServer())
      .get("/api/auth/profile")
      .set("Authorization", `Bearer ${bobToken}`);
    expect(bobProfile.body.data.activeOrg.id).toBe(orgId);
    expect(bobProfile.body.data.memberships).toHaveLength(1);
  });

  it("非 owner 邀请 → ORG_FORBIDDEN（403 + code 2004）", async () => {
    if (maybeSkip()) return;
    const carolToken = await registerAndToken("carol@org.io");
    const orgRes = await request(app.getHttpServer())
      .post("/api/orgs")
      .set("Authorization", `Bearer ${carolToken}`)
      .send({ name: "CarolOrg" });
    const orgId = orgRes.body.data.id as string;

    const daveToken = await registerAndToken("dave@org.io");
    const res = await request(app.getHttpServer())
      .post(`/api/orgs/${orgId}/invitations`)
      .set("Authorization", `Bearer ${daveToken}`)
      .send({ email: "x@org.io" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ success: false, code: 2004 });
  });

  it("接受不存在的邀请码 → INVITATION_INVALID（code 2005）", async () => {
    if (maybeSkip()) return;
    const eveToken = await registerAndToken("eve@org.io");
    const res = await request(app.getHttpServer())
      .post("/api/orgs/invitations/accept")
      .set("Authorization", `Bearer ${eveToken}`)
      .send({ token: "nonexistent" });
    expect(res.body).toMatchObject({ success: false, code: 2005 });
  });

  it("resend 会刷新过期邀请（新 token + 新有效期）并重发邮件", async () => {
    if (maybeSkip()) return;
    const frankToken = await registerAndToken("frank@org.io");
    const orgRes = await request(app.getHttpServer())
      .post("/api/orgs")
      .set("Authorization", `Bearer ${frankToken}`)
      .send({ name: "FrankOrg" });
    const orgId = orgRes.body.data.id as string;

    const inviteRes = await request(app.getHttpServer())
      .post(`/api/orgs/${orgId}/invitations`)
      .set("Authorization", `Bearer ${frankToken}`)
      .send({ email: "late@org.io" });
    const invitationId = inviteRes.body.data.id as string;
    const oldToken = inviteRes.body.data.token as string;

    // 直接把 DB 里的邀请改成已过期（绕过时钟）
    await dbCtx?.ds.query(
      `UPDATE "invitation" SET "expires_at" = now() - interval '1 day' WHERE "id" = $1`,
      [invitationId],
    );

    const resendRes = await request(app.getHttpServer())
      .post(`/api/orgs/${orgId}/invitations/${invitationId}/resend`)
      .set("Authorization", `Bearer ${frankToken}`);
    expect(resendRes.body).toMatchObject({ success: true });

    // 刷新后：邮件里是新 token，且 DB 行的有效期被刷新
    expect(captureSender.last?.to).toBe("late@org.io");
    const freshCode = captureSender.last?.mail.code as string;
    expect(freshCode).toMatch(/^[0-9a-f]{48}$/);
    expect(freshCode).not.toBe(oldToken);

    // 新 token 可被接受
    const ginaToken = await registerAndToken("gina@org.io");
    const acceptRes = await request(app.getHttpServer())
      .post("/api/orgs/invitations/accept")
      .set("Authorization", `Bearer ${ginaToken}`)
      .send({ token: freshCode });
    expect(acceptRes.body).toMatchObject({ success: true });
  });
});
