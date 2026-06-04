import { DataSource } from "typeorm";

/**
 * 锁定 AddSessionMessagesSeq 迁移的 backfill SQL：旧数据按会话
 * (created_at, id) 升序赋 1-based 连续 seq。SQL 与迁移文件保持一致。
 */
describe("AddSessionMessagesSeq backfill SQL", () => {
  let ds: DataSource;

  beforeEach(async () => {
    ds = new DataSource({ type: "better-sqlite3", database: ":memory:" });
    await ds.initialize();
    await ds.query(`
      CREATE TABLE session_messages (
        id TEXT PRIMARY KEY NOT NULL,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at DATETIME NOT NULL
      )`);
    await ds.query(
      `ALTER TABLE session_messages ADD COLUMN seq INTEGER NOT NULL DEFAULT 0`,
    );
    const ins = (id: string, s: string, t: string) =>
      ds.query(
        `INSERT INTO session_messages (id, session_id, role, content, created_at) VALUES (?,?,?,?,?)`,
        [id, s, "user", id, t],
      );
    await ins("a", "s1", "2026-01-01 00:00:01");
    await ins("b", "s1", "2026-01-01 00:00:02");
    await ins("c", "s2", "2026-01-01 00:00:01");
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it("按会话 (created_at,id) 赋 1-based 连续 seq", async () => {
    await ds.query(`
      UPDATE session_messages SET seq = (
        SELECT COUNT(*) FROM session_messages m2
        WHERE m2.session_id = session_messages.session_id
          AND (m2.created_at < session_messages.created_at
            OR (m2.created_at = session_messages.created_at AND m2.id <= session_messages.id))
      )`);
    const rows = await ds.query(
      `SELECT id, session_id, seq FROM session_messages ORDER BY session_id, seq`,
    );
    expect(rows).toEqual([
      { id: "a", session_id: "s1", seq: 1 },
      { id: "b", session_id: "s1", seq: 2 },
      { id: "c", session_id: "s2", seq: 1 },
    ]);
  });

  it("同会话同秒按 id 二级排序，seq 仍连续不重复", async () => {
    await ds.query(
      `INSERT INTO session_messages (id, session_id, role, content, created_at) VALUES (?,?,?,?,?)`,
      ["a0", "s1", "user", "a0", "2026-01-01 00:00:01"],
    );
    await ds.query(`
      UPDATE session_messages SET seq = (
        SELECT COUNT(*) FROM session_messages m2
        WHERE m2.session_id = session_messages.session_id
          AND (m2.created_at < session_messages.created_at
            OR (m2.created_at = session_messages.created_at AND m2.id <= session_messages.id))
      )`);
    const rows = await ds.query(
      `SELECT id, seq FROM session_messages WHERE session_id = 's1' ORDER BY seq`,
    );
    // 同秒按 id 升序（"a" < "a0" 字典序），seq 连续不重复
    expect(rows).toEqual([
      { id: "a", seq: 1 },
      { id: "a0", seq: 2 },
      { id: "b", seq: 3 },
    ]);
  });
});
