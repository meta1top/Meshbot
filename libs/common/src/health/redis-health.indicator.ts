import { Inject, Injectable } from "@nestjs/common";
import {
  HealthCheckError,
  HealthIndicator,
  type HealthIndicatorResult,
} from "@nestjs/terminus";

import { LOCK_PROVIDER, type LockProvider } from "../lock/lock.provider";

/**
 * Redis 健康检查 —— Phase 5 Track C1。
 *
 * 走 LockProvider 而不是直接拿 ioredis：
 * - 复用现有抽象（CommonModule.forRoot 配置过 LockProvider 一份）
 * - memory 模式（无 Redis）也能通过同一接口报 `up`（适用于 server-agent 单机）
 * - 实际探活方式：申请 + 立即释放一个一次性短锁，验证存储链路通畅
 *
 * 用法（HealthController）：
 * ```ts
 * @Get() @HealthCheck()
 * check() {
 *   return this.health.check([() => this.redis.isHealthy("redis")]);
 * }
 * ```
 */
@Injectable()
export class RedisHealthIndicator extends HealthIndicator {
  constructor(@Inject(LOCK_PROVIDER) private readonly lock: LockProvider) {
    super();
  }

  async isHealthy(key = "redis"): Promise<HealthIndicatorResult> {
    const probeKey = `lock:health:${Date.now()}-${Math.random()}`;
    try {
      const release = await this.lock.acquire(probeKey, 1000, 0);
      await release();
      return this.getStatus(key, true);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new HealthCheckError(
        `${key} indicator failed`,
        this.getStatus(key, false, { message }),
      );
    }
  }
}
