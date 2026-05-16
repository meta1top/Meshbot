/**
 * 锁释放回调。
 * 第二次调用应是幂等的（不抛错）。
 */
export type LockRelease = () => Promise<void>;

/**
 * Phase 6 B1：acquire 时的可选行为参数。
 */
export interface AcquireOptions {
  /**
   * 启用 watchdog 自动续期。
   * - `RedisLockProvider`：以 `renewIntervalMs` 间隔执行 Lua（GET == token → PEXPIRE）
   *   续期；token 不匹配时静默停止
   * - `MemoryLockProvider`：忽略（单进程无 TTL 概念）
   *
   * 默认 false。
   */
  watchdog?: boolean;

  /**
   * watchdog 续期间隔（毫秒）。默认 `Math.floor(ttlMs / 3)`，给三次重试机会。
   */
  renewIntervalMs?: number;
}

/**
 * 锁提供者抽象。
 * 本地实现：MemoryLockProvider（async-mutex，单进程互斥）。
 * 云端实现：RedisLockProvider（Phase 3 引入；Phase 6 加 watchdog）。
 */
export interface LockProvider {
  /**
   * 申请一个锁。
   *
   * @param key      锁键（已带前缀，例如 "lock:order:123"）
   * @param ttlMs    锁 TTL（毫秒）。Memory 实现忽略 TTL；Redis 实现用于防死锁。
   * @param waitMs   等待超时（毫秒）。0 表示立即失败。
   * @param options  Phase 6 B1：可选 watchdog 续期等
   * @returns        释放回调
   * @throws         "LOCK_ACQUIRE_FAILED" 当 waitMs 内未拿到锁
   */
  acquire(
    key: string,
    ttlMs: number,
    waitMs: number,
    options?: AcquireOptions,
  ): Promise<LockRelease>;
}

export const LOCK_PROVIDER = Symbol("LOCK_PROVIDER");
