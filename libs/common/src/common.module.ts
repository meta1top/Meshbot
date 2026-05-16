import {
  type DynamicModule,
  Module,
  type ModuleMetadata,
} from "@nestjs/common";
import { DiscoveryModule } from "@nestjs/core";

import { CacheInitializer } from "./cache/cache.initializer";
import { CACHE_PROVIDER, type CacheProvider } from "./cache/cache.provider";
import { MemoryCacheProvider } from "./cache/memory-cache.provider";
import { LockInitializer } from "./lock/lock.initializer";
import { LOCK_PROVIDER, type LockProvider } from "./lock/lock.provider";
import { MemoryLockProvider } from "./lock/memory-lock.provider";

const COMMON_MODULE_OPTIONS = Symbol("COMMON_MODULE_OPTIONS");

export interface CommonModuleOptions {
  /** 锁提供者：默认 "memory"（进程内互斥） */
  lock?: "memory" | LockProvider;
  /** 缓存提供者：默认 "memory"（lru-cache） */
  cache?: "memory" | CacheProvider;
}

export interface CommonModuleAsyncOptions {
  imports?: ModuleMetadata["imports"];
  // biome-ignore lint/suspicious/noExplicitAny: inject token list 与 NestJS DI 兼容
  inject?: any[];
  useFactory: (
    // biome-ignore lint/suspicious/noExplicitAny: factory 参数由 inject 决定，运行时类型推断不可知
    ...args: any[]
  ) => CommonModuleOptions | Promise<CommonModuleOptions>;
}

@Module({})
export class CommonModule {
  /**
   * 配置 meshbot 通用基础设施（LockProvider / CacheProvider + Discovery 装配器）。
   *
   * **只能在根模块（AppModule）调一次**。返回的 DynamicModule 标记
   * `global: true`，子模块 / 子 app 无需重复 import。多次调用会创建
   * 多份 LockProvider / CacheProvider 实例，导致不同代码路径取到
   * 不同的内部状态（内存 Map / LRUCache），破坏锁与缓存的全局一致性。
   *
   * 同步配置（最常用，本地轨默认）：
   *
   * ```ts
   * @Module({ imports: [CommonModule.forRoot()] })  // 全 memory 兜底
   * @Module({ imports: [CommonModule.forRoot({ lock: new RedisLockProvider(redis) })] })
   * ```
   *
   * 异步配置（云端轨：根据 ConfigService.REDIS_URL 选 memory / redis）：
   *
   * ```ts
   * CommonModule.forRootAsync({
   *   inject: [ConfigService],
   *   useFactory: (cfg: ConfigService) => {
   *     const url = cfg.get<string>("REDIS_URL");
   *     if (!url) return {};                 // memory 兜底
   *     const redis = new Redis(url);
   *     return {
   *       lock: new RedisLockProvider(redis),
   *       cache: new RedisCacheProvider(redis),
   *     };
   *   },
   * })
   * ```
   */
  static forRoot(options: CommonModuleOptions = {}): DynamicModule {
    return buildModule(
      [
        {
          provide: COMMON_MODULE_OPTIONS,
          useValue: options,
        },
      ],
      [],
    );
  }

  static forRootAsync(options: CommonModuleAsyncOptions): DynamicModule {
    return buildModule(
      [
        {
          provide: COMMON_MODULE_OPTIONS,
          inject: options.inject ?? [],
          useFactory: options.useFactory,
        },
      ],
      options.imports ?? [],
    );
  }
}

function buildModule(
  // biome-ignore lint/suspicious/noExplicitAny: providers 联合类型在内联组合时冗长，统一用 any 简化
  optionsProviders: any[],
  imports: NonNullable<ModuleMetadata["imports"]>,
): DynamicModule {
  // biome-ignore lint/suspicious/noExplicitAny: 同上
  const providers: any[] = [
    ...optionsProviders,
    LockInitializer,
    CacheInitializer,
    MemoryLockProvider,
    MemoryCacheProvider,
    {
      provide: LOCK_PROVIDER,
      inject: [COMMON_MODULE_OPTIONS, MemoryLockProvider],
      useFactory: (
        options: CommonModuleOptions,
        memory: MemoryLockProvider,
      ): LockProvider => {
        const choice = options.lock ?? "memory";
        return choice === "memory" ? memory : choice;
      },
    },
    {
      provide: CACHE_PROVIDER,
      inject: [COMMON_MODULE_OPTIONS, MemoryCacheProvider],
      useFactory: (
        options: CommonModuleOptions,
        memory: MemoryCacheProvider,
      ): CacheProvider => {
        const choice = options.cache ?? "memory";
        return choice === "memory" ? memory : choice;
      },
    },
  ];

  return {
    module: CommonModule,
    imports: [DiscoveryModule, ...imports],
    providers,
    exports: [LOCK_PROVIDER, CACHE_PROVIDER],
    global: true,
  };
}
