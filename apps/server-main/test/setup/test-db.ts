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
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DataSource, type DataSourceOptions } from "typeorm";
import { SnakeNamingStrategy } from "typeorm-naming-strategies";

import { AppUser } from "../../../../libs/main/src/entities/app-user.entity";
import { Conversation } from "../../../../libs/main/src/entities/conversation.entity";
import { ConversationMember } from "../../../../libs/main/src/entities/conversation-member.entity";
import { Device } from "../../../../libs/main/src/entities/device.entity";
import { DeviceAuthRequest } from "../../../../libs/main/src/entities/device-auth-request.entity";
import { EmailVerification } from "../../../../libs/main/src/entities/email-verification.entity";
import { Invitation } from "../../../../libs/main/src/entities/invitation.entity";
import { Membership } from "../../../../libs/main/src/entities/membership.entity";
import { Message } from "../../../../libs/main/src/entities/message.entity";
import { Organization } from "../../../../libs/main/src/entities/organization.entity";
import { OrgModelConfig } from "../../../../libs/main/src/entities/org-model-config.entity";
import { SkillPackage } from "../../../../libs/main/src/entities/skill-package.entity";
import { SkillVersion } from "../../../../libs/main/src/entities/skill-version.entity";

/** 云端 schema 的真相源：apps/server-main/migrations/*.sql（DDL 由 DBA 手动执行）。 */
const MIGRATIONS_DIR = path.join(__dirname, "..", "..", "migrations");

/**
 * 跨并行 suite 串行化 DDL 的 advisory lock 键（任意固定 64 位整数）。
 * CREATE EXTENSION 是库级全局对象：多个 jest worker 同时 applyDdl 时，
 * `IF NOT EXISTS` 防不住 pg_extension 唯一索引的并发插入竞态
 * （duplicate key "pg_extension_name_index"）。
 */
const DDL_ADVISORY_LOCK_KEY = 881_234_017;

/**
 * 按文件名顺序把全部 DDL 执行到当前连接（测试 schema 由 search_path 圈定）。
 * 整段包在 session 级 advisory lock 内串行化并行 suite 的 DDL——lock/unlock
 * 必须落在同一条连接上，故用独占 queryRunner 而非走池的 ds.query。
 */
async function applyDdl(ds: DataSource): Promise<void> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const runner = ds.createQueryRunner();
  await runner.connect();
  try {
    await runner.query(`SELECT pg_advisory_lock(${DDL_ADVISORY_LOCK_KEY})`);
    try {
      for (const file of files) {
        const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
        await runner.query(sql);
      }
    } finally {
      await runner.query(`SELECT pg_advisory_unlock(${DDL_ADVISORY_LOCK_KEY})`);
    }
  } finally {
    await runner.release();
  }
}

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
    entities: [
      AppUser,
      Organization,
      Membership,
      Invitation,
      Conversation,
      ConversationMember,
      Message,
      SkillPackage,
      SkillVersion,
      Device,
      DeviceAuthRequest,
      EmailVerification,
      OrgModelConfig,
    ],
    namingStrategy: new SnakeNamingStrategy(),
    synchronize: false,
    logging: false,
  };

  const ds = new DataSource(dataSourceOptions);
  await ds.initialize();
  await applyDdl(ds);

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
