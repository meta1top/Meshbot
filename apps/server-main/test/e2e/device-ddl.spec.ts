import {
  createTestDb,
  isPostgresReachable,
  type TestDbContext,
} from "../setup/test-db";
import { DataSource } from "typeorm";

describe("device/auth DDL", () => {
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

  it("新表与新列存在", async () => {
    if (!ds) return;
    const tables = await ds.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()`,
    );
    const names = tables.map((t: { table_name: string }) => t.table_name);
    expect(names).toEqual(
      expect.arrayContaining([
        "device",
        "device_auth_request",
        "email_verification",
        "org_model_config",
      ]),
    );
    const col = await ds.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'app_user' AND column_name = 'email_verified_at'`,
    );
    expect(col).toHaveLength(1);
  });
});
