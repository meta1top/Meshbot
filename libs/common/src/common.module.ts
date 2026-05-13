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
    const lockProvider =
      lockChoice === "memory"
        ? { provide: LOCK_PROVIDER, useClass: MemoryLockProvider }
        : { provide: LOCK_PROVIDER, useValue: lockChoice };

    return {
      module: CommonModule,
      imports: [DiscoveryModule],
      providers: [lockProvider, LockInitializer, MemoryLockProvider],
      exports: [LOCK_PROVIDER],
      global: true,
    };
  }
}
