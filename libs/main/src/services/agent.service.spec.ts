import { Repository } from "typeorm";
import type { AgentSyncInput } from "@meshbot/types-main";
import { Agent } from "../entities/agent.entity";
import { AgentService } from "./agent.service";

// ─────────────────────────── helpers ───────────────────────────────────────

let _idCounter = 1;
/** 生成测试用伪雪花 id（模拟 @BeforeInsert 云端另发 id，不等于 localAgentId）。 */
function nextId(): string {
  return `cloud-${_idCounter++}`;
}

/** 构造 AgentSyncInput 测试小工具。 */
function ita(localAgentId: string, name: string): AgentSyncInput {
  return {
    localAgentId,
    name,
    avatar: "",
    description: null,
    visibility: "private",
  };
}

// ─── fake DataSource（供 @Transactional() root 路径使用）──────────────────

function makeFakeDataSource() {
  return {
    createQueryRunner: () => ({
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
    }),
  };
}

/** 内存 rows 数组 + 最小 Repository 实现（instanceof Repository 需成立）。 */
function makeRepo(rows: Agent[]): Repository<Agent> {
  return Object.assign(Object.create(Repository.prototype), {
    find: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
      if (where.deviceId !== undefined) {
        return rows.filter((r) => r.deviceId === where.deviceId);
      }
      // listForUser: { userId, deletedAt: IsNull() } —— FindOperator 用 instanceof 判断
      return rows
        .filter((r) => r.userId === where.userId && r.deletedAt === null)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    }),
    create: jest.fn(
      (v: Partial<Agent>) =>
        ({
          avatar: "",
          description: null,
          visibility: "private",
          orgId: null,
          lastSyncedAt: null,
          deletedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...v,
        }) as Agent,
    ),
    save: jest.fn(async (v: Agent | Agent[]) => {
      const list = Array.isArray(v) ? v : [v];
      for (const row of list) {
        if (!row.id) row.id = nextId();
        if (!rows.includes(row)) rows.push(row);
      }
      return v;
    }),
    findOne: jest.fn(
      async ({ where }: { where: Record<string, unknown> }) =>
        rows.find((r) =>
          Object.entries(where).every(
            ([k, val]) => (r as unknown as Record<string, unknown>)[k] === val,
          ),
        ) ?? null,
    ),
    manager: { connection: makeFakeDataSource() },
  }) as unknown as Repository<Agent>;
}

describe("AgentService.syncForDeviceInTx", () => {
  beforeEach(() => {
    _idCounter = 1;
  });

  it("首次同步：全量 insert，云端另发 id（不等于 localAgentId）", async () => {
    const rows: Agent[] = [];
    const svc = new AgentService(makeRepo(rows));
    await svc.syncForDeviceInTx("dev1", "u1", null, [
      {
        localAgentId: "la1",
        name: "研发",
        avatar: "🛠|#000",
        description: null,
        visibility: "private",
      },
    ]);
    const listed = await svc.listForUser("u1");
    expect(listed).toHaveLength(1);
    expect(listed[0].id).not.toBe("la1");
    expect(listed[0].localAgentId).toBe("la1");
  });

  it("再次同步：改名 upsert（id 不变，稳定寻址）", async () => {
    const rows: Agent[] = [];
    const svc = new AgentService(makeRepo(rows));
    await svc.syncForDeviceInTx("dev1", "u1", null, [ita("la1", "旧名")]);
    const before = (await svc.listForUser("u1"))[0];
    await svc.syncForDeviceInTx("dev1", "u1", null, [ita("la1", "新名")]);
    const after = (await svc.listForUser("u1"))[0];
    expect(after.id).toBe(before.id); // id 稳定
    expect(after.name).toBe("新名");
  });

  it("列表里消失的一律软删（deleted_at）", async () => {
    const rows: Agent[] = [];
    const svc = new AgentService(makeRepo(rows));
    await svc.syncForDeviceInTx("dev1", "u1", null, [
      ita("la1", "A"),
      ita("la2", "B"),
    ]);
    await svc.syncForDeviceInTx("dev1", "u1", null, [ita("la1", "A")]); // la2 消失
    const listed = await svc.listForUser("u1");
    expect(listed.map((r) => r.localAgentId)).toEqual(["la1"]); // listForUser 只返未软删
    // 底层行仍在（软删而非硬删），id 未漂移
    expect(rows).toHaveLength(2);
    expect(
      rows.find((r) => r.localAgentId === "la2")?.deletedAt,
    ).not.toBeNull();
  });

  it("软删后又出现：复活（同一 localAgentId 不新建重复行）", async () => {
    const rows: Agent[] = [];
    const svc = new AgentService(makeRepo(rows));
    await svc.syncForDeviceInTx("dev1", "u1", null, [ita("la1", "A")]);
    const original = (await svc.listForUser("u1"))[0];
    await svc.syncForDeviceInTx("dev1", "u1", null, []); // 软删 la1
    await svc.syncForDeviceInTx("dev1", "u1", null, [ita("la1", "A2")]); // 回来
    const listed = await svc.listForUser("u1");
    expect(listed).toHaveLength(1);
    expect(listed[0].deletedAt).toBeNull();
    expect(listed[0].id).toBe(original.id); // 复活复用同一行，id 不漂移
    expect(rows).toHaveLength(1); // 未新建重复行
  });
});
