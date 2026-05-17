import { Logger } from "@nestjs/common";
import type { ThrottlerStorage } from "@nestjs/throttler";

/**
 * `@nestjs/throttler` 不从包顶层导出 `ThrottlerStorageRecord`（只在未公开的
 * 子路径 `dist/throttler-storage-record.interface`）。从 `increment` 的返回
 * 类型推导，避免依赖深层 dist 路径。
 */
type ThrottlerStorageRecord = Awaited<
  ReturnType<ThrottlerStorage["increment"]>
>;

/**
 * Fail-open ThrottlerStorage 包装器。
 *
 * 背景：Redis 存在时限流走 `ThrottlerStorageRedisService`（多副本计数一致）。
 * 但当 Redis 运行期不可用，`increment` 会 reject，`@nestjs/throttler` guard
 * 不会 fail-open 也不会 fail-closed —— 异常冒泡成 500，使**所有受限流保护
 * 的端点（含 health / auth）在 Redis 抖动期间全部 500**。这与 lock / cache
 * 的"Redis 故障 memory 兜底"哲学不一致，且健康检查端点 500 会掩盖真实状态、
 * 阻碍恢复。
 *
 * 本包装器在底层 storage 抛错时**放行**（返回未触发限流的 record），把
 * "Redis 故障"降级为"限流暂时失效"而非"全站 500"。限流是防滥用的尽力而为
 * 机制，短时失效优于整站不可用。每次降级打 warn 日志便于告警。
 *
 * 用法（server-* `app.module.ts`）：
 * ```ts
 * ThrottlerModule.forRootAsync({
 *   inject: [REDIS_CLIENT],
 *   useFactory: (redis: Redis | null) => ({
 *     throttlers: [...],
 *     ...(redis
 *       ? {
 *           storage: new FailOpenThrottlerStorage(
 *             new ThrottlerStorageRedisService(redis),
 *           ),
 *         }
 *       : {}),
 *   }),
 * });
 * ```
 */
export class FailOpenThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(FailOpenThrottlerStorage.name);

  constructor(private readonly inner: ThrottlerStorage) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    try {
      return await this.inner.increment(
        key,
        ttl,
        limit,
        blockDuration,
        throttlerName,
      );
    } catch (err) {
      this.logger.warn(
        `限流存储不可用，本次放行（fail-open）：throttler=${throttlerName} ` +
          `key=${key} reason=${err instanceof Error ? err.message : String(err)}`,
      );
      // 返回"未触发限流"的 record：计数 0、未阻断
      return {
        totalHits: 0,
        timeToExpire: ttl,
        isBlocked: false,
        timeToBlockExpire: 0,
      };
    }
  }
}
