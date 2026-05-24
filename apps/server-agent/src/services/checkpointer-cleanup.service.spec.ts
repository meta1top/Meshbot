import { DataSource } from "typeorm";
import { CheckpointerCleanupService } from "./checkpointer-cleanup.service";

describe("CheckpointerCleanupService", () => {
  let ds: DataSource;
  let service: CheckpointerCleanupService;

  beforeEach(async () => {
    ds = new DataSource({
      type: "better-sqlite3",
      database: ":memory:",
      synchronize: false,
    });
    await ds.initialize();
    await ds.query(`
      CREATE TABLE checkpoints (
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL DEFAULT '',
        checkpoint_id TEXT NOT NULL,
        parent_checkpoint_id TEXT,
        type TEXT,
        checkpoint BLOB,
        metadata BLOB,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
      )
    `);
    await ds.query(`
      CREATE TABLE writes (
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL DEFAULT '',
        checkpoint_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        channel TEXT NOT NULL,
        type TEXT,
        value BLOB,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
      )
    `);
    await ds.query(
      `INSERT INTO checkpoints (thread_id, checkpoint_ns, checkpoint_id) VALUES ('t1', '', 'c1'), ('t2', '', 'c2')`,
    );
    await ds.query(
      `INSERT INTO writes (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel) VALUES ('t1', '', 'c1', 'tk1', 0, 'ch'), ('t2', '', 'c2', 'tk2', 0, 'ch')`,
    );
    service = new CheckpointerCleanupService(ds);
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it("deleteThread 删 checkpoints + writes 中对应 thread_id 的行", async () => {
    await service.deleteThread("t1");
    const cp = await ds.query(`SELECT thread_id FROM checkpoints`);
    const wr = await ds.query(`SELECT thread_id FROM writes`);
    expect(cp.map((r: { thread_id: string }) => r.thread_id)).toEqual(["t2"]);
    expect(wr.map((r: { thread_id: string }) => r.thread_id)).toEqual(["t2"]);
  });

  it("deleteThread 对不存在的 thread_id 不报错", async () => {
    await expect(service.deleteThread("nope")).resolves.toBeUndefined();
  });
});
