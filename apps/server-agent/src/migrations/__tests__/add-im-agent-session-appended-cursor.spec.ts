import { DataSource } from "typeorm";
import { ImAgentSession1780900000000 } from "../1780900000000-ImAgentSession";
import { AddImAgentSessionAppendedCursor1781000000000 } from "../1781000000000-AddImAgentSessionAppendedCursor";

describe("AddImAgentSessionAppendedCursor 迁移", () => {
  let ds: DataSource;

  beforeEach(async () => {
    ds = new DataSource({ type: "better-sqlite3", database: ":memory:" });
    await ds.initialize();
    // 先跑基础表迁移，再跑本迁移（真实迁移链的顺序）
    const qr = ds.createQueryRunner();
    await new ImAgentSession1780900000000().up(qr);
    await qr.release();
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it("up：新增 last_appended_message_id 列，可为空", async () => {
    const qr = ds.createQueryRunner();
    await new AddImAgentSessionAppendedCursor1781000000000().up(qr);
    await qr.release();

    const cols = (await ds.query(`PRAGMA table_info("im_agent_session")`)) as {
      name: string;
      notnull: number;
    }[];
    const col = cols.find((c) => c.name === "last_appended_message_id");
    expect(col).toBeDefined();
    expect(col?.notnull).toBe(0);
  });

  it("up：既有行的新列默认值为 NULL", async () => {
    await ds.query(
      `INSERT INTO "im_agent_session" ("id", "conversation_id", "session_id", "cloud_user_id") VALUES ('id1', 'conv1', 'sess1', 'user1')`,
    );

    const qr = ds.createQueryRunner();
    await new AddImAgentSessionAppendedCursor1781000000000().up(qr);
    await qr.release();

    const rows = (await ds.query(
      `SELECT last_appended_message_id FROM "im_agent_session" WHERE id = 'id1'`,
    )) as { last_appended_message_id: string | null }[];
    expect(rows[0]?.last_appended_message_id).toBeNull();
  });

  it("down：不抛错、不删表（保留列语义）", async () => {
    const qr = ds.createQueryRunner();
    await new AddImAgentSessionAppendedCursor1781000000000().up(qr);
    await new AddImAgentSessionAppendedCursor1781000000000().down(qr);
    await qr.release();

    const tables = (await ds.query(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='im_agent_session'`,
    )) as { name: string }[];
    expect(tables).toHaveLength(1);
  });
});
