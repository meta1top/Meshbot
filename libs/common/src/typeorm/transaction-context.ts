import { AsyncLocalStorage } from "node:async_hooks";
import type { QueryRunner } from "typeorm";

export interface TransactionStore {
  queryRunner: QueryRunner;
}

export const txStorage = new AsyncLocalStorage<TransactionStore>();

/**
 * 获取当前异步上下文中的事务 QueryRunner（若存在）。
 *
 * 适用于非装饰器场景下需要手动参与当前事务的情况。
 */
export const TransactionContext = {
  getQueryRunner: (): QueryRunner | undefined =>
    txStorage.getStore()?.queryRunner,
};
