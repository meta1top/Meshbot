/**
 * 锁释放回调。
 * 第二次调用应是幂等的（不抛错）。
 */
export type LockRelease = () => Promise<void>;

/**
 * 锁提供者抽象。
 * 本地实现：MemoryLockProvider（async-mutex，单进程互斥）。
 * 云端实现：RedisLockProvider（Phase 3 引入）。
 */
export interface LockProvider {
  /**
   * 申请一个锁。
   *
   * @param key      锁键（已带前缀，例如 "lock:order:123"）
   * @param ttlMs    锁 TTL（毫秒）。Memory 实现忽略 TTL；Redis 实现用于防死锁。
   * @param waitMs   等待超时（毫秒）。0 表示立即失败。
   * @returns        释放回调
   * @throws         "LOCK_ACQUIRE_FAILED" 当 waitMs 内未拿到锁
   */
  acquire(key: string, ttlMs: number, waitMs: number): Promise<LockRelease>;
}

export const LOCK_PROVIDER = Symbol("LOCK_PROVIDER");
