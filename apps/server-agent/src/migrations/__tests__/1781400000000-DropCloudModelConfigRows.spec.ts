import { DataSource } from "typeorm";
import { ModelConfig } from "../../entities/model-config.entity";
import { DropCloudModelConfigRows1781400000000 } from "../1781400000000-DropCloudModelConfigRows";

describe("DropCloudModelConfigRows1781400000000", () => {
  let ds: DataSource;

  beforeEach(async () => {
    ds = new DataSource({
      type: "better-sqlite3",
      database: ":memory:",
      entities: [ModelConfig],
      synchronize: true,
    });
    await ds.initialize();
  });

  afterEach(async () => {
    await ds.destroy();
  });

  async function seed(source: "cloud" | "local", name: string) {
    const repo = ds.getRepository(ModelConfig);
    await repo.save(
      repo.create({
        cloudUserId: "u1",
        providerType: "openai",
        name,
        model: "gpt-4o",
        apiKey: "k",
        baseUrl: "",
        enabled: true,
        contextWindow: 128_000,
        source,
      }),
    );
  }

  it("up 删除全部 source='cloud' 行，保留 source='local' 行", async () => {
    await seed("cloud", "Cloud A");
    await seed("cloud", "Cloud B");
    await seed("local", "Local A");

    const runner = ds.createQueryRunner();
    await new DropCloudModelConfigRows1781400000000().up(runner);
    await runner.release();

    const rows = await ds.getRepository(ModelConfig).find();
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Local A");
  });

  it("up 幂等：无 cloud 行时再跑不报错", async () => {
    await seed("local", "Local Only");
    const runner = ds.createQueryRunner();
    const migration = new DropCloudModelConfigRows1781400000000();
    await migration.up(runner);
    await migration.up(runner);
    await runner.release();

    const rows = await ds.getRepository(ModelConfig).find();
    expect(rows).toHaveLength(1);
  });
});
