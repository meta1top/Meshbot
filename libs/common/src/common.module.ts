import { Module } from "@nestjs/common";

/**
 * meshbot 通用模块。
 * 提供：装饰器（Transactional / WithLock / Cacheable）+ TxTypeOrmModule。
 *
 * Phase 1 默认本地实现（内存锁 + 内存缓存）；
 * Phase 3 云端轨可通过 forRoot 切换为 Redis 实现。
 */
@Module({})
export class CommonModule {}
