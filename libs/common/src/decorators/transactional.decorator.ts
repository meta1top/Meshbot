import { Logger } from "@nestjs/common";
import { type DataSource, Repository } from "typeorm";

import { runExclusive } from "../typeorm/datasource-mutex";
import { txStorage } from "../typeorm/transaction-context";

export { TransactionContext } from "../typeorm/transaction-context";

/** sqlite 系驱动的 type 取值——这些驱动的所有 QueryRunner 共享单条底层连接。 */
const SQLITE_DRIVER_TYPES = new Set(["better-sqlite3", "sqlite"]);

/**
 * 判断 DataSource 是否为 sqlite 系驱动（root 事务需按 DataSource 串行化）。
 * 导出仅供单测直接验证串行化的驱动判定逻辑，非常规业务用途。
 */
export function isSqliteFamily(dataSource: DataSource): boolean {
  // 部分单测用最小桩替代 DataSource（无 .options），按非 sqlite 处理即可
  // ——不进入串行化分支，行为与改动前一致，不影响既有测试。
  const type = dataSource.options?.type;
  return type !== undefined && SQLITE_DRIVER_TYPES.has(type);
}

// biome-ignore lint/suspicious/noExplicitAny: 装饰器需要使用动态类型
type ServiceWithRepository = Record<string, any>;

const logger = new Logger("Transactional");

function findDataSource(
  service: ServiceWithRepository,
): DataSource | undefined {
  for (const key of Object.keys(service)) {
    // biome-ignore lint/suspicious/noExplicitAny: 需要访问动态属性
    const value = (service as any)[key];
    if (value instanceof Repository) {
      return value?.manager?.connection as DataSource;
    }
  }
  return undefined;
}

/**
 * 事务装饰器 —— 自动为方法添加数据库事务支持，支持跨 Service 传播。
 *
 * 传播语义（REQUIRED）：
 * - 若当前异步上下文已存在事务，则直接执行（join），不额外创建事务
 * - 若不存在事务，则创建新事务（root），负责 commit / rollback / release
 *
 * 配合 TxTypeOrmModule.forFeature() 使用时，子 Service 无需添加 @Transactional()，
 * 其 Repository 会自动感知事务上下文。
 *
 * 注意：root 路径要求 service 中至少注入一个 Repository（用于获取 DataSource）。
 */
export function Transactional() {
  return (
    _target: unknown,
    _propertyKey: string,
    descriptor: PropertyDescriptor,
  ) => {
    const originalMethod = descriptor.value as (
      // biome-ignore lint/suspicious/noExplicitAny: 装饰器参数类型未知
      ...args: any[]
    ) => Promise<unknown>;

    // biome-ignore lint/suspicious/noExplicitAny: 装饰器实现需要动态 this 上下文
    descriptor.value = async function (
      this: ServiceWithRepository,
      ...args: any[]
    ) {
      const existingCtx = txStorage.getStore();

      if (existingCtx) {
        return originalMethod.apply(this, args);
      }

      const dataSource = findDataSource(this);
      if (!dataSource) {
        throw new Error(
          "@Transactional() 装饰器要求 service 中必须注入 Repository。\n" +
            "请确保在 service 中使用 @InjectRepository() 注入了 Repository。",
        );
      }

      const runRootTransaction = async (): Promise<unknown> => {
        const queryRunner = dataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();

        try {
          const result = await txStorage.run({ queryRunner }, () => {
            return originalMethod.apply(this, args);
          });
          await queryRunner.commitTransaction();
          return result;
        } catch (error) {
          try {
            await queryRunner.rollbackTransaction();
          } catch (rollbackError) {
            logger.error("事务回滚失败:", rollbackError);
          }
          throw error;
        } finally {
          try {
            await queryRunner.release();
          } catch (releaseError) {
            logger.error("释放 QueryRunner 失败:", releaseError);
          }
        }
      };

      // sqlite 系驱动下，同一 DataSource 的所有 QueryRunner 共享单条底层
      // 连接：两个 root 事务并发 BEGIN 会直接炸（cannot start a transaction
      // within a transaction）。按 DataSource 串行化 root 事务规避此问题；
      // join 路径（existingCtx 分支，见上）已提前 return，不会走到这里，
      // 不受串行化影响，嵌套调用不会因排队产生死锁。Postgres 等池化连接的
      // 驱动天然支持多个物理连接并发开事务，串行化只会白白拖慢吞吐，故
      // 仅对 sqlite 系生效。
      if (isSqliteFamily(dataSource)) {
        return runExclusive(dataSource, runRootTransaction);
      }
      return runRootTransaction();
    };

    return descriptor;
  };
}
