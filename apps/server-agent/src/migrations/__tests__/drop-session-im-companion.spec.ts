import { DataSource } from "typeorm";
import { DropSessionImCompanionFields1780600000000 } from "../1780600000000-DropSessionImCompanionFields";

describe("DropSessionImCompanionFields 迁移", () => {
  let ds: DataSource;

  beforeEach(async () => {
    ds = new DataSource({ type: "better-sqlite3", database: ":memory:" });
    await ds.initialize();
    await ds.query(
      `CREATE TABLE "sessions" ("id" TEXT PRIMARY KEY NOT NULL, "cloud_user_id" TEXT, "title" TEXT NOT NULL, "kind" VARCHAR NOT NULL DEFAULT 'user', "im_conversation_id" TEXT, "im_conv_type" VARCHAR, "agent_enabled" BOOLEAN NOT NULL DEFAULT 1)`,
    );
    await ds.query(
      `CREATE UNIQUE INDEX "uq_sessions_im_companion" ON "sessions" ("cloud_user_id", "im_conversation_id") WHERE "kind" = 'im'`,
    );
    await ds.query(
      `CREATE TABLE "session_messages" ("id" TEXT PRIMARY KEY NOT NULL, "session_id" TEXT NOT NULL)`,
    );
    await ds.query(
      `CREATE TABLE "pending_messages" ("id" TEXT PRIMARY KEY NOT NULL, "session_id" TEXT NOT NULL)`,
    );
    await ds.query(
      `CREATE TABLE "llm_calls" ("id" TEXT PRIMARY KEY NOT NULL, "session_id" TEXT NOT NULL)`,
    );
    await ds.query(
      `INSERT INTO "sessions" ("id","cloud_user_id","title","kind","im_conversation_id","im_conv_type") VALUES ('im1','u1','c','im','conv1','dm')`,
    );
    await ds.query(
      `INSERT INTO "sessions" ("id","cloud_user_id","title","kind") VALUES ('u-s','u1','普通','user')`,
    );
    await ds.query(
      `INSERT INTO "session_messages" ("id","session_id") VALUES ('m1','im1')`,
    );
    await ds.query(
      `INSERT INTO "pending_messages" ("id","session_id") VALUES ('p1','im1')`,
    );
    await ds.query(
      `INSERT INTO "llm_calls" ("id","session_id") VALUES ('l1','im1')`,
    );
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it("up：删伴生列+索引，清 kind='im' 会话及关联，普通会话保留", async () => {
    const qr = ds.createQueryRunner();
    await new DropSessionImCompanionFields1780600000000().up(qr);
    await qr.release();

    const cols = (
      (await ds.query(`PRAGMA table_info("sessions")`)) as { name: string }[]
    ).map((r) => r.name);
    expect(cols).not.toContain("im_conversation_id");
    expect(cols).not.toContain("im_conv_type");
    expect(cols).not.toContain("agent_enabled");

    const idx = await ds.query(
      `SELECT name FROM sqlite_master WHERE type='index' AND name='uq_sessions_im_companion'`,
    );
    expect(idx).toEqual([]);

    expect(await ds.query(`SELECT id FROM "sessions" ORDER BY id`)).toEqual([
      { id: "u-s" },
    ]);
    expect(await ds.query(`SELECT id FROM "session_messages"`)).toEqual([]);
    expect(await ds.query(`SELECT id FROM "pending_messages"`)).toEqual([]);
    expect(await ds.query(`SELECT id FROM "llm_calls"`)).toEqual([]);
  });
});
