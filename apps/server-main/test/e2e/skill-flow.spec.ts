import "reflect-metadata";
import path from "node:path";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import {
  CommonModule,
  ErrorsFilter,
  I18nZodValidationPipe,
  ResponseInterceptor,
  traceIdMiddleware,
} from "@meshbot/common";
import { MainModule } from "@meshbot/main";
import { AssetService, AssetsModule } from "@meshbot/assets";
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
import { SkillController } from "../../src/rest/skill.controller";
import {
  createTestDb,
  isPostgresReachable,
  type TestDbContext,
} from "../setup/test-db";

const I18N_PATH = path.join(__dirname, "..", "..", "i18n");
const TEST_APP_CONFIG = {
  jwt: { secret: "e2e-test-secret", expires: "1h" },
} as AppConfig;

const DUMMY_MINIO = {
  provider: "minio" as const,
  minio: {
    endPoint: "localhost",
    port: 9000,
    useSSL: false,
    accessKey: "x",
    secretKey: "x",
    bucket: "test",
  },
};

/** 内存假 AssetService：免真实 minio。 */
class FakeAssetService extends AssetService {
  private readonly store = new Map<string, Buffer>();
  async put(key: string, body: Buffer): Promise<void> {
    this.store.set(key, body);
  }
  async get(key: string): Promise<Buffer> {
    const b = this.store.get(key);
    if (!b) throw new Error(`missing ${key}`);
    return b;
  }
  async getStream(key: string): Promise<NodeJS.ReadableStream> {
    return Readable.from(this.store.get(key) ?? Buffer.alloc(0));
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
  async exists(key: string): Promise<boolean> {
    return this.store.has(key);
  }
  async getSignedUrl(key: string): Promise<string> {
    return `mem://${key}`;
  }
  async ensureBucket(): Promise<void> {}
}

describe("server-main skill marketplace e2e", () => {
  let app: INestApplication;
  let dbCtx: TestDbContext | null = null;
  let skipReason: string | null = null;

  beforeAll(async () => {
    if (!(await isPostgresReachable())) {
      skipReason = "Postgres unreachable; run `pnpm dev:db:up`";
      console.warn(`[skill-flow] ${skipReason}`);
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
        AssetsModule.forRoot(DUMMY_MINIO),
        MainModule.forRoot({ expiresDays: 7 }),
      ],
      controllers: [AuthController, SkillController],
      providers: [
        { provide: APP_CONFIG, useValue: TEST_APP_CONFIG },
        JwtMainStrategy,
        { provide: APP_GUARD, useClass: JwtAuthGuard },
      ],
    })
      .overrideProvider(AssetService)
      .useValue(new FakeAssetService())
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
      console.warn(`[skill-flow] skipping: ${skipReason}`);
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

  function publishBody(slug: string, version: string) {
    return {
      slug,
      displayName: `${slug} skill`,
      description: `desc of ${slug}`,
      version,
      changelog: "init",
      readme: `# ${slug}\n\ninstructions`,
      tarballBase64: gzipSync(Buffer.from(`skill:${slug}`)).toString("base64"),
    };
  }

  it("发布 → 列表 → 详情 → 下载 往返；非作者发同 slug 被拒", async () => {
    if (maybeSkip()) return;
    const token = await registerAndToken("author@example.com");

    // 发布
    await request(app.getHttpServer())
      .post("/api/skills")
      .set("Authorization", `Bearer ${token}`)
      .send(publishBody("weather", "1.0.0"))
      .expect(201);

    // 列表含该 slug
    const list = await request(app.getHttpServer())
      .get("/api/skills")
      .expect(200);
    expect(
      (list.body.data as Array<{ slug: string }>).some(
        (s) => s.slug === "weather",
      ),
    ).toBe(true);

    // 详情含 readme + 版本
    const detail = await request(app.getHttpServer())
      .get("/api/skills/weather")
      .expect(200);
    expect(detail.body.data.readme).toContain("# weather");
    expect(detail.body.data.versions).toHaveLength(1);

    // 下载返 200 + gzip
    const dl = await request(app.getHttpServer())
      .get("/api/skills/weather/1.0.0/download")
      .expect(200);
    expect(dl.headers["content-type"]).toContain("gzip");

    // 另一用户发同 slug → 403
    const token2 = await registerAndToken("other@example.com");
    await request(app.getHttpServer())
      .post("/api/skills")
      .set("Authorization", `Bearer ${token2}`)
      .send(publishBody("weather", "2.0.0"))
      .expect(403);
  });
});
