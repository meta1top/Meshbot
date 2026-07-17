import "reflect-metadata";
import { CommonModule } from "@meshbot/common";
import { AssetsModule } from "@meshbot/assets";
import { MainModule } from "@meshbot/main";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { TypeOrmModule } from "@nestjs/typeorm";

import { CloudAgentService } from "../../../../libs/main/src/services/cloud-agent.service";
import {
  createTestDb,
  isPostgresReachable,
  type TestDbContext,
} from "../setup/test-db";

/**
 * CloudAgentService 真实 DI + Postgres 读写往返 e2e 冒烟。
 * 覆盖：从 MainModule 完整 DI 图解析 CloudAgentService（撞名改名后无 DI 崩）
 * + syncForDevice 对账写入 + listForUser 读回，走真实 `agent` 表（非 mock repo）。
 * Postgres 不可达时 skip（与其余 e2e 套件一致）。
 */
describe("CloudAgentService e2e", () => {
  let app: INestApplication | undefined;
  let dbCtx: TestDbContext | null = null;

  afterAll(async () => {
    if (app) await app.close();
    if (dbCtx) await dbCtx.cleanup();
  });

  it("从 MainModule 解析 CloudAgentService 并对真实 Postgres 完成一次对账读写往返", async () => {
    const reachable = await isPostgresReachable();
    if (!reachable) {
      console.warn("Postgres 不可达，skip");
      return;
    }
    dbCtx = await createTestDb();

    const moduleRef = await Test.createTestingModule({
      imports: [
        CommonModule.forRoot({}),
        TypeOrmModule.forRoot(dbCtx.dataSourceOptions),
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
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    const svc = app.get(CloudAgentService);
    expect(svc).toBeInstanceOf(CloudAgentService);

    await svc.syncForDevice("dev-e2e-check", "user-e2e-check", null, [
      {
        localAgentId: "la1",
        name: "n",
        avatar: "",
        description: null,
        visibility: "private",
      },
    ]);
    const listed = await svc.listForUser("user-e2e-check");
    expect(listed).toHaveLength(1);
    expect(listed[0].localAgentId).toBe("la1");
  }, 30_000);
});
