import { CommonModule, TxTypeOrmModule } from "@meshbot/common";
import { Module } from "@nestjs/common";

import { AppUser } from "./entities/app-user.entity";
import { UserService } from "./services/user.service";

/**
 * server-main 业务模块（Phase 3 框架基线）。
 *
 * 当前仅含 AppUser + UserService（注册 / 登录）作为云端轨示范。真实业务等
 * meshbot 自己迭代后接到这里，但要保持：
 * - Entity → Service 一对一归属（`check:repo` 围栏）
 * - 跨表写动作走 `@Transactional()`，跨 Service 写动作通过被调 Service 的方法（不注 Repository）
 * - `@WithLock` 包 `@Transactional`（`check:lock-tx` 围栏）
 * - 私有事务方法命名 `*InTx` / `*InDb` / `*InTransaction` / `persist*`（`check:naming` 围栏）
 *
 * `TxTypeOrmModule.forFeature` 替代原生 `TypeOrmModule.forFeature`，
 * Repository 会自动感知 `@Transactional()` 上下文。
 *
 * `CommonModule.forRoot()` 提供 LockProvider / CacheProvider —— `@WithLock` 装饰器依赖之。
 * 本地轨 / Phase 3 用 MemoryProvider；Phase 4 切 Redis。
 */
@Module({
  imports: [CommonModule.forRoot(), TxTypeOrmModule.forFeature([AppUser])],
  providers: [UserService],
  exports: [UserService],
})
export class MainModule {}
