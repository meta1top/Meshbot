import { type DynamicModule, Module } from "@nestjs/common";
import { DiscoveryModule } from "@nestjs/core";

import { CacheInitializer } from "./cache/cache.initializer";
import { CACHE_PROVIDER, type CacheProvider } from "./cache/cache.provider";
import { MemoryCacheProvider } from "./cache/memory-cache.provider";
import { LockInitializer } from "./lock/lock.initializer";
import { LOCK_PROVIDER, type LockProvider } from "./lock/lock.provider";
import { MemoryLockProvider } from "./lock/memory-lock.provider";

export interface CommonModuleOptions {
  /** 锁提供者：默认 "memory"（进程内互斥） */
  lock?: "memory" | LockProvider;
  /** 缓存提供者：默认 "memory"（lru-cache） */
  cache?: "memory" | CacheProvider;
}

@Module({})
export class CommonModule {
  static forRoot(options: CommonModuleOptions = {}): DynamicModule {
    const lockChoice = options.lock ?? "memory";
    const cacheChoice = options.cache ?? "memory";

    // 注：当 choice === "memory" 时，使用 useExisting 别名 PROVIDER token
    // 指向同一个 Memory*Provider 实例，避免直接按类注入与按 token 注入
    // 拿到不同实例（不同内部状态）导致互斥/缓存语义失效。
    // biome-ignore lint/suspicious/noExplicitAny: Nest Provider 联合类型在内联组合时较冗长，统一用 any 简化
    const providers: any[] = [LockInitializer, CacheInitializer];

    if (lockChoice === "memory") {
      providers.push(MemoryLockProvider, {
        provide: LOCK_PROVIDER,
        useExisting: MemoryLockProvider,
      });
    } else {
      providers.push({ provide: LOCK_PROVIDER, useValue: lockChoice });
    }

    if (cacheChoice === "memory") {
      providers.push(MemoryCacheProvider, {
        provide: CACHE_PROVIDER,
        useExisting: MemoryCacheProvider,
      });
    } else {
      providers.push({ provide: CACHE_PROVIDER, useValue: cacheChoice });
    }

    return {
      module: CommonModule,
      imports: [DiscoveryModule],
      providers,
      exports: [LOCK_PROVIDER, CACHE_PROVIDER],
      global: true,
    };
  }
}
