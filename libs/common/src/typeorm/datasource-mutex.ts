import type { DataSource } from "typeorm";

/**
 * 按 DataSource 的 FIFO 互斥锁（Promise 链实现，无新依赖）。
 *
 * 背景：better-sqlite3 / sqlite 驱动下，同一 DataSource 创建的所有
 * QueryRunner 实际共享同一条底层连接（sqlite 是单连接语义，不像 Postgres
 * 走连接池）。若两个 root 事务并发 `BEGIN`，第二个 `BEGIN` 会直接命中
 * `SqliteError: cannot start a transaction within a transaction`——
 * 这与业务逻辑无关，是驱动层单连接决定的硬限制。
 *
 * 解法：对 sqlite 系驱动的 root 事务按 DataSource 排队串行化，保证任意
 * 时刻至多一个 root 事务在跑。用 `WeakMap<DataSource, Promise<...>>`
 * 维护每个 DataSource 的"当前排队尾部"，`runExclusive` 把新任务接到尾部
 * 后返回，天然 FIFO；不同 DataSource 各自独立，互不阻塞。
 */
const chains = new WeakMap<DataSource, Promise<unknown>>();

/**
 * 在指定 DataSource 的互斥队列上排队执行 `fn`，同一 DataSource 上的调用
 * 严格串行（先进先出）；不同 DataSource 之间完全并发、互不影响。
 *
 * 注意：`fn` 内部抛出的异常不会中断队列——下一个排队者仍会正常执行，
 * 异常只会通过返回的 Promise 传给调用方。
 */
export function runExclusive<T>(
  dataSource: DataSource,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = chains.get(dataSource) ?? Promise.resolve();
  // 无论前一个任务成功/失败都要继续排队（catch 吞掉，避免链路因一次失败被截断）。
  const settled = previous.then(
    () => undefined,
    () => undefined,
  );
  const result = settled.then(fn);
  // 挂到链上的 tail 只用于排队定序，自身的 rejection 不应变成未处理拒绝。
  chains.set(
    dataSource,
    result.then(
      () => undefined,
      () => undefined,
    ),
  );
  return result;
}
