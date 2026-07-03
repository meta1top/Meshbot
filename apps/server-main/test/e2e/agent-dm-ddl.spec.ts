import { DataSource } from "typeorm";
import {
  createTestDb,
  isPostgresReachable,
  type TestDbContext,
} from "../setup/test-db";

describe("agent-dm DDL", () => {
  let ctx: TestDbContext;
  let ds: DataSource;
  beforeAll(async () => {
    if (!(await isPostgresReachable())) return;
    ctx = await createTestDb();
    ds = new DataSource(ctx.dataSourceOptions);
    await ds.initialize();
  });
  afterAll(async () => {
    await ds?.destroy();
    await ctx?.cleanup();
  });

  it("conversation.agent_device_id 与 message.sender_type 列存在", async () => {
    if (!ds) return;
    const cols = await ds.query(
      `SELECT table_name, column_name, column_default FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND ((table_name='conversation' AND column_name='agent_device_id')
           OR (table_name='message' AND column_name='sender_type'))`,
    );
    const conv = cols.find(
      (c: { table_name: string }) => c.table_name === "conversation",
    );
    const msg = cols.find(
      (c: { table_name: string }) => c.table_name === "message",
    );
    expect(conv).toBeTruthy();
    expect(msg).toBeTruthy();
    expect(String(msg.column_default)).toContain("user");
  });
});
