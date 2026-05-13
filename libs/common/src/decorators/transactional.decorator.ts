import { Logger } from "@nestjs/common";
import { type DataSource, Repository } from "typeorm";

import { txStorage } from "../typeorm/transaction-context";

export { TransactionContext } from "../typeorm/transaction-context";

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

    return descriptor;
  };
}
