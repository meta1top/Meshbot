import "reflect-metadata";
import { DataSource } from "typeorm";
import { Transactional } from "../src/decorators";
import { TxTypeOrmModule } from "../src/typeorm";
import { Test } from "@nestjs/testing";
import { Column, Entity, PrimaryGeneratedColumn } from "typeorm";
import { InjectRepository, TypeOrmModule } from "@nestjs/typeorm";
import { Injectable } from "@nestjs/common";
import { Repository } from "typeorm";

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
    await expect(service.createAndFailInTx("alpha")).rejects.toThrow("rollback me");
    const all = await service.findAll();
    expect(all.find((f) => f.name === "alpha")).toBeUndefined();
  });

  it("成功时事务提交，数据落库", async () => {
    const saved = await service.createAndSucceedInTx("beta");
    expect(saved.id).toBeDefined();
    const all = await service.findAll();
    expect(all.find((f) => f.name === "beta")).toBeDefined();
  });
});
