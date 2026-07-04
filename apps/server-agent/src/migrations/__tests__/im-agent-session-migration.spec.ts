import { DataSource } from "typeorm";
import { ImAgentSession1780900000000 } from "../1780900000000-ImAgentSession";

describe("ImAgentSession 迁移", () => {
  let ds: DataSource;

  beforeEach(async () => {
    ds = new DataSource({ type: "better-sqlite3", database: ":memory:" });
    await ds.initialize();
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it("up：创建 im_agent_session 表", async () => {
    const qr = ds.createQueryRunner();
    await new ImAgentSession1780900000000().up(qr);
    await qr.release();

    // 检查表是否存在
    const tables = (await ds.query(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='im_agent_session'`,
    )) as { name: string }[];
    expect(tables).toHaveLength(1);
    expect(tables[0]?.name).toBe("im_agent_session");
  });

  it("up：验证表包含正确的列", async () => {
    const qr = ds.createQueryRunner();
    await new ImAgentSession1780900000000().up(qr);
    await qr.release();

    const cols = (
      (await ds.query(`PRAGMA table_info("im_agent_session")`)) as {
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
      }[]
    ).map((r) => r.name);

    expect(cols).toContain("id");
    expect(cols).toContain("conversation_id");
    expect(cols).toContain("session_id");
    expect(cols).toContain("cloud_user_id");
    expect(cols).toContain("last_processed_message_id");
    expect(cols).toContain("created_at");
  });

  it("up：conversation_id 列不能为空", async () => {
    const qr = ds.createQueryRunner();
    await new ImAgentSession1780900000000().up(qr);
    await qr.release();

    const cols = (await ds.query(`PRAGMA table_info("im_agent_session")`)) as {
      name: string;
      notnull: number;
    }[];
    const convCol = cols.find((c) => c.name === "conversation_id");
    expect(convCol?.notnull).toBe(1); // 1 表示不能为空
  });

  it("up：last_processed_message_id 列可以为空", async () => {
    const qr = ds.createQueryRunner();
    await new ImAgentSession1780900000000().up(qr);
    await qr.release();

    const cols = (await ds.query(`PRAGMA table_info("im_agent_session")`)) as {
      name: string;
      notnull: number;
    }[];
    const lastMsgCol = cols.find((c) => c.name === "last_processed_message_id");
    expect(lastMsgCol?.notnull).toBe(0); // 0 表示可以为空
  });

  it("up：创建 conversation_id 唯一索引", async () => {
    const qr = ds.createQueryRunner();
    await new ImAgentSession1780900000000().up(qr);
    await qr.release();

    const indices = (await ds.query(
      `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='im_agent_session' AND name LIKE 'uq_%'`,
    )) as { name: string }[];
    expect(indices.some((i) => i.name.includes("conv"))).toBe(true);
  });

  it("up：创建 cloud_user_id 索引", async () => {
    const qr = ds.createQueryRunner();
    await new ImAgentSession1780900000000().up(qr);
    await qr.release();

    const indices = (await ds.query(
      `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='im_agent_session'`,
    )) as { name: string }[];
    expect(indices.some((i) => i.name.includes("cloud_user"))).toBe(true);
  });
});
