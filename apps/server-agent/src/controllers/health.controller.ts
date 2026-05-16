import { RedisHealthIndicator, SkipResponseEnvelope } from "@meshbot/common";
import { Controller, Get } from "@nestjs/common";
import {
  HealthCheck,
  type HealthCheckResult,
  HealthCheckService,
  TypeOrmHealthIndicator,
} from "@nestjs/terminus";

import { Public } from "../guards/jwt-auth.guard";

/**
 * Phase 5 Track C1：本地 Agent 健康检查。
 *
 * GET /api/health：
 * - `database` ping SQLite
 * - `redis` 用 LockProvider 探活（memory 模式下也返回 up，符合本地单进程语义）
 *
 * 匿名访问，跳过 ResponseInterceptor 包装（Terminus 自有 shape）。
 */
@Controller("api/health")
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: TypeOrmHealthIndicator,
    private readonly redis: RedisHealthIndicator,
  ) {}

  @Public()
  @SkipResponseEnvelope()
  @Get()
  @HealthCheck()
  check(): Promise<HealthCheckResult> {
    return this.health.check([
      () => this.db.pingCheck("database"),
      () => this.redis.isHealthy("redis"),
    ]);
  }
}
