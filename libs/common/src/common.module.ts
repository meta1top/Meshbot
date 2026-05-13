import { type DynamicModule, Module } from "@nestjs/common";
import { DiscoveryModule } from "@nestjs/core";

import { LockInitializer } from "./lock/lock.initializer";
import { LOCK_PROVIDER, type LockProvider } from "./lock/lock.provider";
import { MemoryLockProvider } from "./lock/memory-lock.provider";

export interface CommonModuleOptions {
  /** 锁提供者：默认 "memory"（进程内互斥） */
  lock?: "memory" | LockProvider;
}

@Module({})
export class CommonModule {
  static forRoot(options: CommonModuleOptions = {}): DynamicModule {
    const lockChoice = options.lock ?? "memory";

    // 注：当 lockChoice === "memory" 时，使用 useExisting 别名 LOCK_PROVIDER
    // 指向同一个 MemoryLockProvider 实例，避免直接按类注入与按 token 注入
    // 拿到不同实例（不同 mutexes Map）导致锁串行化失效。
    if (lockChoice === "memory") {
      return {
        module: CommonModule,
        imports: [DiscoveryModule],
        providers: [
          MemoryLockProvider,
          { provide: LOCK_PROVIDER, useExisting: MemoryLockProvider },
          LockInitializer,
        ],
        exports: [LOCK_PROVIDER],
        global: true,
      };
    }

    return {
      module: CommonModule,
      imports: [DiscoveryModule],
      providers: [{ provide: LOCK_PROVIDER, useValue: lockChoice }, LockInitializer],
      exports: [LOCK_PROVIDER],
      global: true,
    };
  }
}
