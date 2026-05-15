/**
 * 为每个 test suite 起一个隔离的 Postgres schema。
 *
 * 用法：
 * ```ts
 * const ctx = await createTestDb();
 * // 把 ctx.dataSourceOptions 注入 NestJS Test module
 * afterAll(async () => { await ctx.cleanup(); });
 * ```
 *
 * 当 DATABASE_URL 不可达时通过 `isPostgresReachable()` 探测，整个 suite skip。
 */
import { randomBytes } from "node:crypto";
import { DataSource, type DataSourceOptions } from "typeorm";
import { SnakeNamingStrategy } from "typeorm-naming-strategies";

import { AppUser } from "../../../../libs/main/src/entities/app-user.entity";
import { InitialSchema1778869010469 } from "../../src/migrations/1778869010469-InitialSchema";

const DEFAULT_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://meshbot:meshbot@localhost:5432/meshbot_main";

export interface TestDbContext {
  schema: string;
  dataSourceOptions: DataSourceOptions;
  ds: DataSource;
  cleanup(): Promise<void>;
}

export async function isPostgresReachable(): Promise<boolean> {
  const probe = new DataSource({
    type: "postgres",
    url: DEFAULT_URL,
    entities: [],
    synchronize: false,
  });
  try {
    await probe.initialize();
    await probe.destroy();
    return true;
  } catch {
    return false;
  }
}

export async function createTestDb(): Promise<TestDbContext> {
  const schema = `test_${randomBytes(4).toString("hex")}`;

  const bootstrap = new DataSource({
    type: "postgres",
    url: DEFAULT_URL,
    entities: [],
    synchronize: false,
  });
  await bootstrap.initialize();
  await bootstrap.query(`CREATE SCHEMA "${schema}"`);
  await bootstrap.destroy();

  const dataSourceOptions: DataSourceOptions = {
    type: "postgres",
    url: DEFAULT_URL,
    schema,
    // 让所有连接默认在测试 schema 内创建 / 读对象，避免 unqualified DDL 落 public
    extra: { options: `-c search_path=${schema}` },
    entities: [AppUser],
    migrations: [InitialSchema1778869010469],
    namingStrategy: new SnakeNamingStrategy(),
    synchronize: false,
    logging: false,
  };

  const ds = new DataSource(dataSourceOptions);
  await ds.initialize();
  await ds.runMigrations();

  return {
    schema,
    dataSourceOptions,
    ds,
    async cleanup() {
      if (ds.isInitialized) await ds.destroy();
      const drop = new DataSource({
        type: "postgres",
        url: DEFAULT_URL,
        entities: [],
        synchronize: false,
      });
      await drop.initialize();
      await drop.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await drop.destroy();
    },
  };
}
