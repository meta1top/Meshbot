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
import { TxTypeOrmModule } from "../src/typeorm";

@Entity()
class Item {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column()
  name!: string;
}

@Injectable()
class ChildService {
  constructor(
    @InjectRepository(Item) private readonly repo: Repository<Item>,
  ) {}

  async create(name: string): Promise<Item> {
    return this.repo.save({ name });
  }
}

@Injectable()
class ParentService {
  constructor(
    @InjectRepository(Item) private readonly repo: Repository<Item>,
    private readonly child: ChildService,
  ) {}

  @Transactional()
  async createTwoAndFail(): Promise<void> {
    await this.child.create("a");
    await this.repo.save({ name: "b" });
    throw new Error("boom");
  }

  async findAll(): Promise<Item[]> {
    return this.repo.find();
  }
}

describe("TxTypeOrmModule auto-propagation", () => {
  let parent: ParentService;
  let ds: DataSource;

  beforeAll(async () => {
    const ref = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: "better-sqlite3",
          database: ":memory:",
          entities: [Item],
          synchronize: true,
        }),
        TxTypeOrmModule.forFeature([Item]),
      ],
      providers: [ParentService, ChildService],
    }).compile();

    parent = ref.get(ParentService);
    ds = ref.get(DataSource);
  });

  afterAll(async () => {
    await ds.destroy();
  });

  it("子 service 的写入在父事务回滚时也被回滚", async () => {
    await expect(parent.createTwoAndFail()).rejects.toThrow("boom");
    const all = await parent.findAll();
    expect(all).toHaveLength(0);
  });
});
