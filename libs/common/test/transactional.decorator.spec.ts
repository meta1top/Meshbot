import "reflect-metadata";
import { Injectable } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { InjectRepository, TypeOrmModule } from "@nestjs/typeorm";
import {
  Column,
  DataSource,
  Entity,
  PrimaryGeneratedColumn,
  type Repository,
} from "typeorm";
import { Transactional } from "../src/decorators";
import { isSqliteFamily } from "../src/decorators/transactional.decorator";
import { TxTypeOrmModule } from "../src/typeorm";

@Entity()
class Foo {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column()
  name!: string;
}

@Injectable()
class FooService {
  constructor(
    @InjectRepository(Foo)
    private readonly repo: Repository<Foo>,
  ) {}

  @Transactional()
  async createAndFailInTx(name: string): Promise<void> {
    await this.repo.save({ name });
    throw new Error("rollback me");
  }

  @Transactional()
  async createAndSucceedInTx(name: string): Promise<Foo> {
    return this.repo.save({ name });
  }

  /** root 事务体内人为延时，制造可观测的时间窗口，用于断言并发串行化。 */
  @Transactional()
  async slowRootTx(
    name: string,
    delayMs: number,
  ): Promise<{ start: number; end: number }> {
    const start = Date.now();
    await this.repo.save({ name });
    await new Promise((r) => setTimeout(r, delayMs));
    const end = Date.now();
    return { start, end };
  }

  /**
   * root 事务体内调用同 service 另一个 @Transactional() 方法：命中 join 分支
   * （existingCtx 已存在，直接执行不再 acquire 互斥锁），用于验证嵌套调用
   * 不会因外层持有互斥锁而卡死。
   */
  @Transactional()
  async outerCallsInnerTx(nameA: string, nameB: string): Promise<void> {
    await this.createAndSucceedInTx(nameA);
    await this.createAndSucceedInTx(nameB);
  }

  async findAll(): Promise<Foo[]> {
    return this.repo.find();
  }
}

describe("@Transactional", () => {
  let service: FooService;
  let dataSource: DataSource;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: "better-sqlite3",
          database: ":memory:",
          entities: [Foo],
          synchronize: true,
        }),
        TxTypeOrmModule.forFeature([Foo]),
      ],
      providers: [FooService],
    }).compile();

    service = moduleRef.get(FooService);
    dataSource = moduleRef.get(DataSource);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  it("失败时事务回滚，不应留下数据", async () => {
    await expect(service.createAndFailInTx("alpha")).rejects.toThrow(
      "rollback me",
    );
    const all = await service.findAll();
    expect(all.find((f) => f.name === "alpha")).toBeUndefined();
  });

  it("成功时事务提交，数据落库", async () => {
    const saved = await service.createAndSucceedInTx("beta");
    expect(saved.id).toBeDefined();
    const all = await service.findAll();
    expect(all.find((f) => f.name === "beta")).toBeDefined();
  });

  it("sqlite 驱动下并发 root 事务全部成功且互不重叠（按 DataSource 串行化）", async () => {
    const results = await Promise.all([
      service.slowRootTx("s1", 30),
      service.slowRootTx("s2", 30),
      service.slowRootTx("s3", 30),
    ]);
    // 按 start 排序后，任意相邻两个区间不应重叠：前一个的 end 必须 <= 后一个的 start。
    const sorted = [...results].sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i].start).toBeGreaterThanOrEqual(sorted[i - 1].end);
    }
    const all = await service.findAll();
    expect(["s1", "s2", "s3"].every((n) => all.some((f) => f.name === n))).toBe(
      true,
    );
  });

  it("join 路径不受互斥锁影响：root 事务体内嵌套调用同 service 的 @Transactional 方法不会卡死", async () => {
    // 与一个真实并发的 root 事务同时跑：outerCallsInnerTx 内部两次嵌套调用走 join
    // 分支（不重新 acquire 互斥锁），不应因外部还有一个 root 事务在排队而卡住。
    await expect(
      Promise.all([
        service.outerCallsInnerTx("nested-a", "nested-b"),
        service.createAndSucceedInTx("concurrent-root"),
      ]),
    ).resolves.toBeDefined();
    const all = await service.findAll();
    expect(all.some((f) => f.name === "nested-a")).toBe(true);
    expect(all.some((f) => f.name === "nested-b")).toBe(true);
    expect(all.some((f) => f.name === "concurrent-root")).toBe(true);
  });
});

describe("isSqliteFamily（root 事务串行化的驱动判定）", () => {
  it("better-sqlite3 / sqlite 判定为 sqlite 系，需要串行化", () => {
    expect(
      isSqliteFamily({ options: { type: "better-sqlite3" } } as DataSource),
    ).toBe(true);
    expect(isSqliteFamily({ options: { type: "sqlite" } } as DataSource)).toBe(
      true,
    );
  });

  it("非 sqlite 驱动（如 postgres）不串行化——池化连接支持真正并发事务", () => {
    expect(
      isSqliteFamily({ options: { type: "postgres" } } as DataSource),
    ).toBe(false);
  });
});
