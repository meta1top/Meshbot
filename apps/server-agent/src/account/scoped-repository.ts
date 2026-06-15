import { AccountContextService } from "@meshbot/agent";
import { AppError } from "@meshbot/common";
import type {
  DeepPartial,
  FindManyOptions,
  FindOneOptions,
  FindOptionsWhere,
  ObjectLiteral,
  Repository,
  SelectQueryBuilder,
} from "typeorm";
import { AgentErrorCode } from "../errors/agent.error-codes";

type Where<T> = FindOptionsWhere<T> | FindOptionsWhere<T>[];

/**
 * 账号作用域仓库（v3 请求级隔离的中央护栏）。
 *
 * 包裹裸 `Repository<T>`，把「当前账号」（`AccountContextService` 从 ALS 读取的
 * `cloudUserId`）自动注入每一次读条件与写入：
 * - 读（find / findOne / count …）：在 where 里合并 `{ cloudUserId: 当前账号 }`，
 *   他账号同条件行不可见。
 * - 写（save）：拒绝跨账号写——实体已带他账号 `cloudUserId` 时抛
 *   `CROSS_ACCOUNT_WRITE`；否则强制盖上当前账号再落库。
 * - update / delete：where 合并当前账号，绝不误改/误删他账号同条件行。
 *
 * 唯一被认可的逃逸口是 {@link unscoped}（系统级读全量，如「这个会话归属哪个账号」）。
 *
 * 注意：where / QueryBuilder 必须用 TypeORM **属性名 `cloudUserId`**（由
 * `@Column({ name: "cloud_user_id" })` 映射到列名），不能用列名。
 */
export class ScopedRepository<T extends ObjectLiteral> {
  constructor(
    private readonly repo: Repository<T>,
    private readonly ctx: AccountContextService,
  ) {}

  /** 当前账号；无上下文抛错（内部不变量）。 */
  private acct(): string {
    return this.ctx.getOrThrow();
  }

  /** 把 `{ cloudUserId: 当前账号 }` 合并进 where（支持单对象与对象数组两种形态）。 */
  private mergeWhere(where?: Where<T>): Where<T> {
    const acct = this.acct();
    const inject = { cloudUserId: acct } as unknown as Partial<
      FindOptionsWhere<T>
    >;
    if (Array.isArray(where)) {
      return where.map((w) => ({ ...w, ...inject })) as FindOptionsWhere<T>[];
    }
    return { ...(where ?? {}), ...inject } as FindOptionsWhere<T>;
  }

  /** 列表查询，自动按当前账号过滤。 */
  async find(options?: FindManyOptions<T>): Promise<T[]> {
    return this.repo.find({
      ...options,
      where: this.mergeWhere(options?.where),
    });
  }

  /** 单行查询（FindOneOptions），自动按当前账号过滤。 */
  async findOne(options: FindOneOptions<T>): Promise<T | null> {
    return this.repo.findOne({
      ...options,
      where: this.mergeWhere(options.where),
    });
  }

  /** 按 where 查单行，自动合并当前账号过滤。 */
  async findOneBy(where: Where<T>): Promise<T | null> {
    return this.repo.findOneBy(this.mergeWhere(where) as FindOptionsWhere<T>);
  }

  /** 按 where 查列表，自动合并当前账号过滤。 */
  async findBy(where: Where<T>): Promise<T[]> {
    return this.repo.findBy(this.mergeWhere(where) as FindOptionsWhere<T>);
  }

  /** 计数，自动按当前账号过滤。 */
  async count(options?: FindManyOptions<T>): Promise<number> {
    return this.repo.count({
      ...options,
      where: this.mergeWhere(options?.where),
    });
  }

  /**
   * 保存实体并拒绝跨账号写。
   *
   * 单实体或实体数组均支持：
   * - 实体已带 `cloudUserId` 且不等于当前账号 → 抛 `CROSS_ACCOUNT_WRITE`；
   * - 否则强制盖上当前账号后落库。
   * - 数组中任意元素触发跨账号校验即抛错，整批写入不会发生。
   */
  async save<E extends DeepPartial<T>>(entity: E): Promise<E>;
  async save<E extends DeepPartial<T>>(entities: E[]): Promise<E[]>;
  async save<E extends DeepPartial<T>>(entity: E | E[]): Promise<E | E[]> {
    const acct = this.acct();
    const stampOne = (e: E): E => {
      const existing = (e as Record<string, unknown>).cloudUserId;
      if (existing != null && existing !== acct) {
        throw new AppError(AgentErrorCode.CROSS_ACCOUNT_WRITE);
      }
      return { ...e, cloudUserId: acct } as E;
    };
    const stamped = Array.isArray(entity)
      ? entity.map(stampOne)
      : stampOne(entity);
    return this.repo.save(stamped as DeepPartial<T>) as Promise<E | E[]>;
  }

  /** 按 where 局部更新，where 合并当前账号（不误改他账号同条件行）。 */
  async update(
    where: Where<T>,
    partial: Parameters<Repository<T>["update"]>[1],
  ): Promise<Awaited<ReturnType<Repository<T>["update"]>>> {
    return this.repo.update(
      this.mergeWhere(where) as FindOptionsWhere<T>,
      partial,
    );
  }

  /** 按 where 删除，where 合并当前账号（不误删他账号同条件行）。 */
  async delete(
    where: Where<T>,
  ): Promise<Awaited<ReturnType<Repository<T>["delete"]>>> {
    return this.repo.delete(this.mergeWhere(where) as FindOptionsWhere<T>);
  }

  /**
   * 逃逸口：返回未包裹的裸 `Repository<T>`，绕过账号过滤。
   *
   * 仅用于系统级读（如「这个会话归属哪个账号」这类必须跨账号的查询）。
   * 业务路径禁止使用（Task 2.11 静态围栏会限制）。
   */
  unscoped(): Repository<T> {
    return this.repo;
  }

  /** 预注入当前账号过滤条件的 QueryBuilder（用属性名 cloudUserId，TypeORM 自动映射列）。 */
  scopedQueryBuilder(alias: string): SelectQueryBuilder<T> {
    return this.repo
      .createQueryBuilder(alias)
      .where(`${alias}.cloudUserId = :__acct`, { __acct: this.acct() });
  }
}
