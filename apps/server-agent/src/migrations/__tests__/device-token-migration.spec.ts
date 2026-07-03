import { DataSource } from "typeorm";
import { DeviceTokenAndModelSource1780800000000 } from "../1780800000000-DeviceTokenAndModelSource";

describe("DeviceTokenAndModelSource 迁移", () => {
  let ds: DataSource;

  beforeEach(async () => {
    ds = new DataSource({ type: "better-sqlite3", database: ":memory:" });
    await ds.initialize();
    // 创建 cloud_identity 表
    await ds.query(`
      CREATE TABLE "cloud_identity" (
        "id" TEXT PRIMARY KEY NOT NULL,
        "cloud_user_id" TEXT NOT NULL UNIQUE,
        "email" TEXT NOT NULL,
        "display_name" TEXT NOT NULL,
        "org_id" TEXT,
        "org_name" TEXT,
        "role" TEXT,
        "cloud_token" TEXT NOT NULL,
        "cloud_token_expires_at" TEXT,
        "logged_in" BOOLEAN NOT NULL DEFAULT 0,
        "created_at" DATETIME NOT NULL,
        "updated_at" DATETIME NOT NULL
      )
    `);
    // 创建 model_configs 表
    await ds.query(`
      CREATE TABLE "model_configs" (
        "id" TEXT PRIMARY KEY NOT NULL,
        "cloud_user_id" TEXT NOT NULL,
        "provider_type" TEXT NOT NULL,
        "name" TEXT NOT NULL,
        "model" TEXT NOT NULL,
        "api_key" TEXT NOT NULL,
        "base_url" TEXT NOT NULL DEFAULT '',
        "enabled" BOOLEAN NOT NULL DEFAULT 1,
        "context_window" INTEGER NOT NULL DEFAULT 128000,
        "created_at" DATETIME NOT NULL,
        "updated_at" DATETIME NOT NULL
      )
    `);
    // 插入测试数据
    await ds.query(
      `INSERT INTO "model_configs" ("id", "cloud_user_id", "provider_type", "name", "model", "api_key", "created_at", "updated_at") VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "cfg1",
        "user1",
        "openai",
        "gpt4",
        "gpt-4",
        "key123",
        new Date().toISOString(),
        new Date().toISOString(),
      ],
    );
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it("up：cloud_identity 表添加 device_token 列（可空）", async () => {
    const qr = ds.createQueryRunner();
    await new DeviceTokenAndModelSource1780800000000().up(qr);
    await qr.release();

    const cols = (
      (await ds.query(`PRAGMA table_info("cloud_identity")`)) as {
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
      }[]
    ).map((r) => r.name);
    expect(cols).toContain("device_token");

    // 验证 device_token 是可空的
    const deviceTokenCol = (await ds.query(
      `PRAGMA table_info("cloud_identity")`,
    )) as { name: string; notnull: number }[];
    const deviceTokenInfo = deviceTokenCol.find(
      (c) => c.name === "device_token",
    );
    expect(deviceTokenInfo?.notnull).toBe(0); // 0 表示可空
  });

  it("up：model_configs 表添加 source 列（默认 'local'）", async () => {
    const qr = ds.createQueryRunner();
    await new DeviceTokenAndModelSource1780800000000().up(qr);
    await qr.release();

    const cols = (
      (await ds.query(`PRAGMA table_info("model_configs")`)) as {
        name: string;
        type: string;
        dflt_value: string | null;
      }[]
    ).map((r) => r.name);
    expect(cols).toContain("source");

    // 验证 source 列的默认值为 'local'
    const sourceCol = (await ds.query(
      `PRAGMA table_info("model_configs")`,
    )) as { name: string; dflt_value: string | null }[];
    const sourceInfo = sourceCol.find((c) => c.name === "source");
    expect(sourceInfo?.dflt_value).toBe("'local'"); // SQLite 中默认值会带引号

    // 验证已有行的 source 值应该回填为 'local'
    const rows = await ds.query(`SELECT id, source FROM "model_configs"`);
    expect(rows).toEqual([{ id: "cfg1", source: "local" }]);
  });
});
