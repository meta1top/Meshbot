# meshbot Phase 1 地基 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 meshbot 建立工程地基：装饰器（@Transactional / @WithLock / @Cacheable）+ TxTypeOrmModule + LockProvider/CacheProvider 抽象（本地内存实现）+ 4 个静态围栏 + libs/types-main 骨架 + Entity-Schema 分离规约 + 纪律规约（CLAUDE.md）+ Jest 配置 + Turbo 任务扩展 + pnpm 收口 + server-agent 合规扫描修补。

**Architecture:** 借鉴 platform 的 service-layer 基础设施，把"分布式锁/缓存"抽象成 Provider 接口，本地轨注入内存实现（async-mutex + lru-cache），云端轨（Phase 3）注入 Redis 实现。装饰器、TxTypeOrmModule、围栏脚本基本原样从  拷贝，做最小适配。规约通过 CLAUDE.md 注入 Claude Code 会话。

**Tech Stack:** NestJS 11, TypeORM 0.3, better-sqlite3, Zod 3, async-mutex, lru-cache, Jest 29, ts-jest, tsx, ts-morph（围栏脚本静态分析），Turborepo 2, pnpm 10, Biome 2。

**Spec:** [docs/superpowers/specs/2026-05-13-meshbot-borrow--design.md](../specs/2026-05-13-meshbot-borrow--design.md)

---

## File Structure

新增/修改的文件（按 task 分组）：

```
libs/common/                                    [NEW]
  package.json
  tsconfig.json
  src/
    index.ts
    common.module.ts
    decorators/
      index.ts
      transactional.decorator.ts                ← 从  拷贝
      with-lock.decorator.ts                    ← 改造：依赖 LockProvider 接口
      cacheable.decorator.ts                    ← 改造：依赖 CacheProvider 接口
    typeorm/
      index.ts
      transaction-context.ts                    ← 从  拷贝
      tx-typeorm.module.ts                      ← 从  拷贝
    lock/
      index.ts
      lock.provider.ts                          [NEW]
      memory-lock.provider.ts                   [NEW]
    cache/
      index.ts
      cache.provider.ts                         [NEW]
      memory-cache.provider.ts                  [NEW]
    dto/
      index.ts
      create-zod-dto.ts                         [NEW] (无 i18n 简化版)
    utils/
      index.ts
      generate-key.ts                           ← 从  拷贝（@WithLock / @Cacheable 共用）

libs/types-main/                                [NEW]
  package.json
  tsconfig.json
  src/
    index.ts
    sample/
      register-agent.schema.ts                  [NEW] (sample schema 不落表)

scripts/                                        [NEW]
  README.md
  check-transactional.ts                        ← 从  拷贝 + 适配
  check-method-naming.ts                        ← 从  拷贝 + 适配
  check-lock-tx.ts                              ← 从  拷贝 + 适配
  check-repo-access.ts                          ← 从  拷贝 + 适配

.claude/CLAUDE.md                               [NEW]

jest.config.ts                                  [NEW]
jest.preset.ts                                  [NEW]

apps/server-agent/src/app.module.ts             [MODIFY] (TxTypeOrmModule 替换 + WAL pragma)
apps/server-agent/src/services/auth.service.ts  [MODIFY] (挂 @Transactional)
apps/server-agent/src/services/setting.service.ts          [MODIFY] (挂 @Transactional)
apps/server-agent/src/services/model-config.service.ts     [MODIFY] (挂 @Transactional)

turbo.json                                      [MODIFY] (扩展 test/typecheck/check/check:*)
pnpm-workspace.yaml                             [MODIFY] (peerDependencyRules)
package.json                                    [MODIFY] (scripts: check:*, test, root check)

libs/common/test/                               [NEW]
  transactional.decorator.spec.ts
  tx-typeorm.module.spec.ts
  memory-lock.provider.spec.ts
  memory-cache.provider.spec.ts
  with-lock.decorator.spec.ts
  cacheable.decorator.spec.ts
```

---

## 全局前提：依赖安装

执行任何 Task 前，先执行：

```bash
cd /Users/grant/Meta1/meshbot
pnpm add -w -D tsx ts-morph @types/jest ts-jest jest
pnpm add -w async-mutex lru-cache
```

注：`-w` 表示装到 workspace root；运行时依赖装在 root 由 NestJS 11 内部隐式继承（也可逐 package 装，本次为简化）。

---

## Task 1: libs/common 骨架 + @Transactional + TxTypeOrmModule

**Files:**
- Create: `libs/common/package.json`
- Create: `libs/common/tsconfig.json`
- Create: `libs/common/src/index.ts`
- Create: `libs/common/src/common.module.ts`
- Create: `libs/common/src/typeorm/transaction-context.ts`
- Create: `libs/common/src/typeorm/tx-typeorm.module.ts`
- Create: `libs/common/src/typeorm/index.ts`
- Create: `libs/common/src/decorators/transactional.decorator.ts`
- Create: `libs/common/src/decorators/index.ts`
- Test: `libs/common/test/transactional.decorator.spec.ts`
- Test: `libs/common/test/tx-typeorm.module.spec.ts`

### Step 1.1: 创建 package 骨架

- [ ] 创建 `libs/common/package.json`：

```json
{
  "name": "@meshbot/common",
  "version": "0.0.1",
  "private": true,
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc --project tsconfig.json",
    "dev": "tsc --project tsconfig.json --watch",
    "clean": "rm -rf dist",
    "typecheck": "tsc --project tsconfig.json --noEmit",
    "test": "jest --config ../../jest.config.ts --roots libs/common"
  },
  "dependencies": {
    "@meshbot/types": "workspace:*",
    "async-mutex": "^0.5.0",
    "lru-cache": "^11.0.0"
  },
  "peerDependencies": {
    "@nestjs/common": "^11",
    "@nestjs/core": "^11",
    "@nestjs/typeorm": "^11",
    "reflect-metadata": "*",
    "typeorm": "^0.3"
  }
}
```

- [ ] 创建 `libs/common/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "composite": false,
    "declaration": true,
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  },
  "include": ["src/**/*"]
}
```

### Step 1.2: 创建事务上下文（直接从  拷贝）

- [ ] 创建 `libs/common/src/typeorm/transaction-context.ts`：

```typescript
import { AsyncLocalStorage } from "node:async_hooks";
import type { QueryRunner } from "typeorm";

export interface TransactionStore {
  queryRunner: QueryRunner;
}

export const txStorage = new AsyncLocalStorage<TransactionStore>();

/**
 * 获取当前异步上下文中的事务 QueryRunner（若存在）。
 *
 * 适用于非装饰器场景下需要手动参与当前事务的情况。
 */
export const TransactionContext = {
  getQueryRunner: (): QueryRunner | undefined => txStorage.getStore()?.queryRunner,
};
```

### Step 1.3: 创建 TxTypeOrmModule

- [ ] 创建 `libs/common/src/typeorm/tx-typeorm.module.ts`：

```typescript
import { type DynamicModule, Module } from "@nestjs/common";
import { getDataSourceToken, getRepositoryToken, TypeOrmModule } from "@nestjs/typeorm";
import { DataSource, type EntitySchema, type EntityTarget, type ObjectLiteral, Repository } from "typeorm";

import { txStorage } from "./transaction-context";

// biome-ignore lint/complexity/noBannedTypes: matches @nestjs/typeorm's EntityClassOrSchema definition
type EntityClassOrSchema = Function | EntitySchema;

/**
 * 为 Repository 创建事务感知代理。
 *
 * 当 AsyncLocalStorage 中存在活跃的 QueryRunner 时，
 * 所有属性/方法访问自动委托到事务作用域的 Repository；
 * 否则使用原始 Repository。
 */
function createTxAwareProxy<T extends ObjectLiteral>(repo: Repository<T>): Repository<T> {
  return new Proxy(repo, {
    get(target, prop, _receiver) {
      const ctx = txStorage.getStore();
      const effective: Repository<T> = ctx
        ? ctx.queryRunner.manager.getRepository(target.target as EntityTarget<T>)
        : target;

      const value = Reflect.get(effective, prop, effective);
      if (typeof value === "function") {
        // biome-ignore lint/complexity/noBannedTypes: binding dynamic method from repository
        return (value as Function).bind(effective);
      }
      return value;
    },
  });
}

/**
 * 事务感知的 TypeORM Module —— 替代 `TypeOrmModule.forFeature()`。
 *
 * 提供的 Repository 与 `@InjectRepository(Entity)` 完全兼容，
 * 区别在于：当调用链上存在 `@Transactional()` 开启的事务时，
 * Repository 的所有操作自动在该事务内执行，无需子方法添加任何装饰器。
 */
@Module({})
export class TxTypeOrmModule {
  static forFeature(entities: EntityClassOrSchema[], dataSourceName?: string): DynamicModule {
    const providers = entities.map((entity) => ({
      provide: getRepositoryToken(entity, dataSourceName),
      inject: [getDataSourceToken(dataSourceName)],
      useFactory: (ds: DataSource) => {
        const baseRepo = ds.getRepository(entity);
        return createTxAwareProxy(baseRepo);
      },
    }));

    return {
      module: TxTypeOrmModule,
      imports: [TypeOrmModule.forFeature(entities, dataSourceName)],
      providers,
      exports: providers.map((p) => p.provide),
    };
  }
}
```

- [ ] 创建 `libs/common/src/typeorm/index.ts`：

```typescript
export { TransactionContext, txStorage, type TransactionStore } from "./transaction-context";
export { TxTypeOrmModule } from "./tx-typeorm.module";
```

### Step 1.4: 创建 @Transactional 装饰器

- [ ] 创建 `libs/common/src/decorators/transactional.decorator.ts`：

```typescript
import { Logger } from "@nestjs/common";
import { type DataSource, Repository } from "typeorm";

import { txStorage } from "../typeorm/transaction-context";

export { TransactionContext } from "../typeorm/transaction-context";

// biome-ignore lint/suspicious/noExplicitAny: 装饰器需要使用动态类型
type ServiceWithRepository = Record<string, any>;

const logger = new Logger("Transactional");

function findDataSource(service: ServiceWithRepository): DataSource | undefined {
  for (const key of Object.keys(service)) {
    // biome-ignore lint/suspicious/noExplicitAny: 需要访问动态属性
    const value = (service as any)[key];
    if (value instanceof Repository) {
      return value?.manager?.connection as DataSource;
    }
  }
  return undefined;
}

/**
 * 事务装饰器 —— 自动为方法添加数据库事务支持，支持跨 Service 传播。
 *
 * 传播语义（REQUIRED）：
 * - 若当前异步上下文已存在事务，则直接执行（join），不额外创建事务
 * - 若不存在事务，则创建新事务（root），负责 commit / rollback / release
 *
 * 配合 TxTypeOrmModule.forFeature() 使用时，子 Service 无需添加 @Transactional()，
 * 其 Repository 会自动感知事务上下文。
 *
 * 注意：root 路径要求 service 中至少注入一个 Repository（用于获取 DataSource）。
 */
export function Transactional() {
  return (_target: unknown, _propertyKey: string, descriptor: PropertyDescriptor) => {
    const originalMethod = descriptor.value as (
      // biome-ignore lint/suspicious/noExplicitAny: 装饰器参数类型未知
      ...args: any[]
    ) => Promise<unknown>;

    // biome-ignore lint/suspicious/noExplicitAny: 装饰器实现需要动态 this 上下文
    descriptor.value = async function (this: ServiceWithRepository, ...args: any[]) {
      const existingCtx = txStorage.getStore();

      if (existingCtx) {
        return originalMethod.apply(this, args);
      }

      const dataSource = findDataSource(this);
      if (!dataSource) {
        throw new Error(
          "@Transactional() 装饰器要求 service 中必须注入 Repository。\n" +
            "请确保在 service 中使用 @InjectRepository() 注入了 Repository。",
        );
      }

      const queryRunner = dataSource.createQueryRunner();
      await queryRunner.connect();
      await queryRunner.startTransaction();

      try {
        const result = await txStorage.run({ queryRunner }, () => {
          return originalMethod.apply(this, args);
        });
        await queryRunner.commitTransaction();
        return result;
      } catch (error) {
        try {
          await queryRunner.rollbackTransaction();
        } catch (rollbackError) {
          logger.error("事务回滚失败:", rollbackError);
        }
        throw error;
      } finally {
        try {
          await queryRunner.release();
        } catch (releaseError) {
          logger.error("释放 QueryRunner 失败:", releaseError);
        }
      }
    };

    return descriptor;
  };
}
```

- [ ] 创建 `libs/common/src/decorators/index.ts`：

```typescript
export { Transactional, TransactionContext } from "./transactional.decorator";
```

- [ ] 创建 `libs/common/src/common.module.ts`（占位，Step 2/3 会补 Provider）：

```typescript
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
```

- [ ] 创建 `libs/common/src/index.ts`：

```typescript
export * from "./decorators";
export * from "./typeorm";
export { CommonModule } from "./common.module";
```

### Step 1.5: 验证构建

- [ ] 运行 `pnpm --filter @meshbot/common build`，预期：编译通过，产出 `libs/common/dist/`。
- [ ] 运行 `pnpm --filter @meshbot/common typecheck`，预期：无错误。

### Step 1.6: 写单元测试（先写失败）

- [ ] 创建 `libs/common/test/transactional.decorator.spec.ts`：

```typescript
import "reflect-metadata";
import { DataSource } from "typeorm";
import { Transactional } from "../src/decorators";
import { TxTypeOrmModule } from "../src/typeorm";
import { Test } from "@nestjs/testing";
import { Column, Entity, PrimaryGeneratedColumn } from "typeorm";
import { InjectRepository, TypeOrmModule } from "@nestjs/typeorm";
import { Injectable } from "@nestjs/common";
import { Repository } from "typeorm";

@Entity()
class Foo {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column()
  name!: string;
}

@Injectable()
class FooService {
  constructor(
    @InjectRepository(Foo)
    private readonly repo: Repository<Foo>,
  ) {}

  @Transactional()
  async createAndFailInTx(name: string): Promise<void> {
    await this.repo.save({ name });
    throw new Error("rollback me");
  }

  @Transactional()
  async createAndSucceedInTx(name: string): Promise<Foo> {
    return this.repo.save({ name });
  }

  async findAll(): Promise<Foo[]> {
    return this.repo.find();
  }
}

describe("@Transactional", () => {
  let service: FooService;
  let dataSource: DataSource;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: "better-sqlite3",
          database: ":memory:",
          entities: [Foo],
          synchronize: true,
        }),
        TxTypeOrmModule.forFeature([Foo]),
      ],
      providers: [FooService],
    }).compile();

    service = moduleRef.get(FooService);
    dataSource = moduleRef.get(DataSource);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  it("失败时事务回滚，不应留下数据", async () => {
    await expect(service.createAndFailInTx("alpha")).rejects.toThrow("rollback me");
    const all = await service.findAll();
    expect(all.find((f) => f.name === "alpha")).toBeUndefined();
  });

  it("成功时事务提交，数据落库", async () => {
    const saved = await service.createAndSucceedInTx("beta");
    expect(saved.id).toBeDefined();
    const all = await service.findAll();
    expect(all.find((f) => f.name === "beta")).toBeDefined();
  });
});
```

- [ ] 运行 `pnpm jest libs/common/test/transactional.decorator.spec.ts -t "@Transactional" -v` —— 此时 Jest 尚未配好，预期：报错 "jest config not found"。该报错即为"红"测试。

- [ ] 暂停本 task，等 **Task 8（Jest 配置）** 完成后再回来跑这个测试，确认变绿。
  - 回归方式：在 Task 8 完成后回到本文件，跑 `pnpm test libs/common/test/transactional.decorator.spec.ts`，预期：2 个 it 全 PASS。

### Step 1.7: 提交

- [ ] 提交：

```bash
git add libs/common pnpm-lock.yaml
git commit -m "feat(common): add libs/common skeleton with @Transactional and TxTypeOrmModule

从 platform 拷贝事务装饰器和事务感知 Repository 代理。
配套测试在 Jest 配置完成后跑通。"
```

---

## Task 2: LockProvider 接口 + MemoryLockProvider + 简化版 @WithLock

**Files:**
- Create: `libs/common/src/lock/lock.provider.ts`
- Create: `libs/common/src/lock/memory-lock.provider.ts`
- Create: `libs/common/src/lock/index.ts`
- Create: `libs/common/src/utils/generate-key.ts`
- Create: `libs/common/src/utils/index.ts`
- Create: `libs/common/src/decorators/with-lock.decorator.ts`
- Modify: `libs/common/src/decorators/index.ts` (export WithLock)
- Modify: `libs/common/src/common.module.ts` (provide MemoryLockProvider)
- Modify: `libs/common/src/index.ts` (re-export lock module)
- Test: `libs/common/test/memory-lock.provider.spec.ts`
- Test: `libs/common/test/with-lock.decorator.spec.ts`

### Step 2.1: 写测试先（红）

- [ ] 创建 `libs/common/test/memory-lock.provider.spec.ts`：

```typescript
import { MemoryLockProvider } from "../src/lock/memory-lock.provider";

describe("MemoryLockProvider", () => {
  let provider: MemoryLockProvider;

  beforeEach(() => {
    provider = new MemoryLockProvider();
  });

  it("同一 key 串行执行：第二个等第一个释放", async () => {
    const order: string[] = [];
    await Promise.all([
      (async () => {
        const release = await provider.acquire("k", 5000, 5000);
        order.push("a-acq");
        await new Promise((r) => setTimeout(r, 50));
        order.push("a-rel");
        await release();
      })(),
      (async () => {
        await new Promise((r) => setTimeout(r, 10));
        const release = await provider.acquire("k", 5000, 5000);
        order.push("b-acq");
        await release();
      })(),
    ]);
    expect(order).toEqual(["a-acq", "a-rel", "b-acq"]);
  });

  it("不同 key 互不阻塞", async () => {
    const r1 = await provider.acquire("k1", 5000, 100);
    const r2 = await provider.acquire("k2", 5000, 100);
    await r1();
    await r2();
  });

  it("waitTimeout=0 立即失败时抛 LockAcquireFailed", async () => {
    const r1 = await provider.acquire("k", 5000, 5000);
    await expect(provider.acquire("k", 5000, 0)).rejects.toThrow(/LOCK_ACQUIRE_FAILED/);
    await r1();
  });
});
```

- [ ] 运行 `pnpm jest libs/common/test/memory-lock.provider.spec.ts -v`（Jest 还没配，先记着；测试待 Task 8 后跑绿）

### Step 2.2: 创建 LockProvider 接口

- [ ] 创建 `libs/common/src/lock/lock.provider.ts`：

```typescript
/**
 * 锁释放回调。
 * 第二次调用应是幂等的（不抛错）。
 */
export type LockRelease = () => Promise<void>;

/**
 * 锁提供者抽象。
 * 本地实现：MemoryLockProvider（async-mutex，单进程互斥）。
 * 云端实现：RedisLockProvider（Phase 3 引入）。
 */
export interface LockProvider {
  /**
   * 申请一个锁。
   *
   * @param key      锁键（已带前缀，例如 "lock:order:123"）
   * @param ttlMs    锁 TTL（毫秒）。Memory 实现忽略 TTL；Redis 实现用于防死锁。
   * @param waitMs   等待超时（毫秒）。0 表示立即失败。
   * @returns        释放回调
   * @throws         "LOCK_ACQUIRE_FAILED" 当 waitMs 内未拿到锁
   */
  acquire(key: string, ttlMs: number, waitMs: number): Promise<LockRelease>;
}

export const LOCK_PROVIDER = Symbol("LOCK_PROVIDER");
```

### Step 2.3: 创建 MemoryLockProvider

- [ ] 创建 `libs/common/src/lock/memory-lock.provider.ts`：

```typescript
import { Injectable } from "@nestjs/common";
import { Mutex } from "async-mutex";

import type { LockProvider, LockRelease } from "./lock.provider";

/**
 * 进程内互斥锁实现。
 *
 * 适用于本地轨（server-agent / cli-agent / desktop fork 出的子进程）。
 * 严格说不是"分布式锁"，只是同一 Node 进程内对同 key 的串行化。
 *
 * 当上层切到云端轨（多节点）时，应替换为 RedisLockProvider。
 */
@Injectable()
export class MemoryLockProvider implements LockProvider {
  private readonly mutexes = new Map<string, Mutex>();

  async acquire(key: string, _ttlMs: number, waitMs: number): Promise<LockRelease> {
    let mutex = this.mutexes.get(key);
    if (!mutex) {
      mutex = new Mutex();
      this.mutexes.set(key, mutex);
    }

    if (waitMs === 0 && mutex.isLocked()) {
      throw new Error(`LOCK_ACQUIRE_FAILED: ${key}`);
    }

    if (waitMs > 0 && mutex.isLocked()) {
      const acquired = await Promise.race([
        mutex.acquire().then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), waitMs)),
      ]);
      if (!acquired) {
        throw new Error(`LOCK_ACQUIRE_FAILED: ${key}`);
      }
      const release = mutex.release.bind(mutex);
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        release();
      };
    }

    const release = await mutex.acquire();
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      release();
    };
  }
}
```

> **注意（实现细节修正）**：上面 Step 2.3 的 race 写法不正确（一旦超时分支胜出，pending 的 acquire 仍会拿到锁后无人释放）。改用 `withTimeout` 包裹的形式更安全。如果遇到该测试不稳定，请把代码替换为下面的版本：

```typescript
import { Mutex, withTimeout, E_TIMEOUT } from "async-mutex";

@Injectable()
export class MemoryLockProvider implements LockProvider {
  private readonly mutexes = new Map<string, Mutex>();

  async acquire(key: string, _ttlMs: number, waitMs: number): Promise<LockRelease> {
    let mutex = this.mutexes.get(key);
    if (!mutex) {
      mutex = new Mutex();
      this.mutexes.set(key, mutex);
    }

    if (waitMs === 0) {
      if (mutex.isLocked()) {
        throw new Error(`LOCK_ACQUIRE_FAILED: ${key}`);
      }
      const release = await mutex.acquire();
      return makeIdempotentRelease(release);
    }

    try {
      const release = await withTimeout(mutex, waitMs).acquire();
      return makeIdempotentRelease(release);
    } catch (e) {
      if (e === E_TIMEOUT) {
        throw new Error(`LOCK_ACQUIRE_FAILED: ${key}`);
      }
      throw e;
    }
  }
}

function makeIdempotentRelease(release: () => void): LockRelease {
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    release();
  };
}
```

- [ ] 用第二版（`withTimeout` 包裹）写入。

### Step 2.4: generateKey 工具

- [ ] 创建 `libs/common/src/utils/generate-key.ts`（从  拷贝；如果  没有同名导出，自己实现）：

```typescript
/**
 * 把模板字符串里的占位符按参数索引/路径替换。
 *
 * 占位符语法：
 * - #{0}            → args[0]
 * - #{1.book.title} → args[1].book.title
 * - #{user.id}      → args[0].user.id（0 可省略）
 */
export function generateKey(template: string, args: unknown[]): string {
  return template.replace(/#\{([^}]+)\}/g, (_, expr: string) => {
    const path = expr.trim();
    const parts = path.split(".");
    const first = parts[0];
    const isIndex = /^\d+$/.test(first);

    const root: unknown = isIndex ? args[Number(first)] : args[0];
    const restParts = isIndex ? parts.slice(1) : parts;

    let cur: unknown = root;
    for (const p of restParts) {
      if (cur === null || cur === undefined) return "";
      // biome-ignore lint/suspicious/noExplicitAny: 动态路径访问
      cur = (cur as any)[p];
    }
    return cur === undefined || cur === null ? "" : String(cur);
  });
}
```

- [ ] 创建 `libs/common/src/utils/index.ts`：

```typescript
export { generateKey } from "./generate-key";
```

### Step 2.5: 改造版 @WithLock 装饰器

简化版：不再硬编码 Redis，改为依赖注入 `LockProvider`。

- [ ] 创建 `libs/common/src/decorators/with-lock.decorator.ts`：

```typescript
import { Logger } from "@nestjs/common";

import type { LockProvider } from "../lock/lock.provider";
import { generateKey } from "../utils/generate-key";

const LOCK_PROVIDER_KEY = Symbol("LOCK_PROVIDER_INSTANCE");
export const WITH_LOCK_MARKER = Symbol("WITH_LOCK_MARKER");

export interface WithLockOptions {
  /**
   * 锁键，支持占位符（见 generateKey 文档）。
   * 自动添加 `lock:` 前缀（若未带）。
   */
  key: string;
  /** 锁 TTL（毫秒），默认 30000 */
  ttl?: number;
  /** 等待锁超时（毫秒），默认 5000；0 表示立即失败 */
  waitTimeout?: number;
  /** 获取锁失败时的错误消息 */
  errorMessage?: string;
}

/**
 * 锁装饰器。
 *
 * 本地轨：注入 MemoryLockProvider，等同于进程内互斥。
 * 云端轨：注入 RedisLockProvider（Phase 3）。
 *
 * 关键约束：禁止在 `@Transactional()` 内部嵌套 `@WithLock()`，
 * 否则锁会先于事务提交释放，造成幂等性漏洞（事务-锁倒置）。
 * `pnpm check:lock-tx` 静态围栏会拦截违例。
 */
export function WithLock(options: WithLockOptions): MethodDecorator {
  return (target, propertyKey, descriptor: PropertyDescriptor) => {
    const originalMethod = descriptor.value;
    const className = (target.constructor as { name: string }).name;
    const logger = new Logger(`${className}:${String(propertyKey)}`);

    Reflect.defineMetadata(WITH_LOCK_MARKER, true, target.constructor);

    // biome-ignore lint/suspicious/noExplicitAny: 方法参数动态
    descriptor.value = async function (this: any, ...args: any[]) {
      const provider: LockProvider | undefined = this[LOCK_PROVIDER_KEY];
      if (!provider) {
        throw new Error(
          "@WithLock 装饰器要求 service 所在模块导入 CommonModule（提供 LockProvider）。",
        );
      }

      const generated = generateKey(options.key, args);
      const lockKey = generated.startsWith("lock:") ? generated : `lock:${generated}`;
      const ttl = options.ttl ?? 30000;
      const waitTimeout = options.waitTimeout ?? 5000;

      logger.debug(`Acquiring lock: ${lockKey}`);
      const release = await provider.acquire(lockKey, ttl, waitTimeout).catch((err) => {
        logger.warn(`Failed to acquire lock: ${lockKey}`);
        throw new Error(options.errorMessage ?? `操作正在处理中，请稍后重试 (${lockKey})`);
      });

      try {
        return await originalMethod.apply(this, args);
      } finally {
        await release().catch((e) => logger.error(`Release lock error: ${e}`));
      }
    };

    return descriptor;
  };
}

/**
 * 由 LockInitializer 调用，把 LockProvider 注入到带 @WithLock 的 service 实例。
 */
// biome-ignore lint/suspicious/noExplicitAny: service instance
export function injectLockProvider(instance: any, provider: LockProvider) {
  instance[LOCK_PROVIDER_KEY] = provider;
}
```

### Step 2.6: LockInitializer（自动注入 Provider 到 service 实例）

- [ ] 创建 `libs/common/src/lock/lock.initializer.ts`：

```typescript
import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { DiscoveryService } from "@nestjs/core";

import { injectLockProvider, WITH_LOCK_MARKER } from "../decorators/with-lock.decorator";
import { LOCK_PROVIDER, type LockProvider } from "./lock.provider";

@Injectable()
export class LockInitializer implements OnModuleInit {
  private readonly logger = new Logger(LockInitializer.name);

  constructor(
    @Inject(LOCK_PROVIDER) private readonly provider: LockProvider,
    private readonly discoveryService: DiscoveryService,
  ) {}

  onModuleInit() {
    const providers = this.discoveryService.getProviders();
    let count = 0;

    providers.forEach((wrapper) => {
      const { instance } = wrapper;
      if (!instance || typeof instance !== "object") return;

      const hasLock = Reflect.getMetadata(WITH_LOCK_MARKER, instance.constructor);
      if (hasLock) {
        injectLockProvider(instance, this.provider);
        count++;
      }
    });

    if (count > 0) {
      this.logger.log(`Initialized lock provider for ${count} services`);
    }
  }
}
```

### Step 2.7: 导出 + 接入 CommonModule

- [ ] 创建 `libs/common/src/lock/index.ts`：

```typescript
export { LOCK_PROVIDER, type LockProvider, type LockRelease } from "./lock.provider";
export { MemoryLockProvider } from "./memory-lock.provider";
export { LockInitializer } from "./lock.initializer";
```

- [ ] 修改 `libs/common/src/decorators/index.ts`：

```typescript
export { Transactional, TransactionContext } from "./transactional.decorator";
export { WithLock, type WithLockOptions, WITH_LOCK_MARKER } from "./with-lock.decorator";
```

- [ ] 修改 `libs/common/src/common.module.ts`：

```typescript
import { DiscoveryModule } from "@nestjs/core";
import { type DynamicModule, Module } from "@nestjs/common";

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
```

- [ ] 修改 `libs/common/src/index.ts`，追加：

```typescript
export * from "./lock";
export * from "./utils";
```

### Step 2.8: with-lock 单测

- [ ] 创建 `libs/common/test/with-lock.decorator.spec.ts`：

```typescript
import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { Injectable } from "@nestjs/common";

import { CommonModule } from "../src/common.module";
import { WithLock } from "../src/decorators";

@Injectable()
class CounterService {
  public log: string[] = [];

  @WithLock({ key: "counter:#{0}", waitTimeout: 1000 })
  async run(id: string, label: string): Promise<void> {
    this.log.push(`${label}-start`);
    await new Promise((r) => setTimeout(r, 30));
    this.log.push(`${label}-end`);
  }
}

describe("@WithLock with MemoryLockProvider", () => {
  let svc: CounterService;

  beforeEach(async () => {
    const ref = await Test.createTestingModule({
      imports: [CommonModule.forRoot()],
      providers: [CounterService],
    }).compile();
    await ref.init();
    svc = ref.get(CounterService);
  });

  it("同一 key 串行化", async () => {
    await Promise.all([svc.run("X", "a"), svc.run("X", "b")]);
    expect(svc.log).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });

  it("不同 key 并发", async () => {
    await Promise.all([svc.run("X", "a"), svc.run("Y", "b")]);
    // 两个 key 不同，交错执行
    expect(svc.log.slice().sort()).toEqual(["a-end", "a-start", "b-end", "b-start"]);
  });
});
```

### Step 2.9: 验证构建 + 提交

- [ ] 运行 `pnpm --filter @meshbot/common build` → 通过
- [ ] 提交：

```bash
git add libs/common
git commit -m "feat(common): add LockProvider abstraction with MemoryLockProvider and @WithLock

抽象出 LockProvider 接口；Phase 1 提供进程内 async-mutex 实现，
云端轨 Phase 3 可注入 Redis 实现。@WithLock 装饰器与  行为对齐
（key 占位符、TTL、waitTimeout、自动 lock: 前缀），但底座可替换。"
```

---

## Task 3: CacheProvider 接口 + MemoryCacheProvider + @Cacheable / @CacheEvict

**Files:**
- Create: `libs/common/src/cache/cache.provider.ts`
- Create: `libs/common/src/cache/memory-cache.provider.ts`
- Create: `libs/common/src/cache/cache.initializer.ts`
- Create: `libs/common/src/cache/index.ts`
- Create: `libs/common/src/decorators/cacheable.decorator.ts`
- Modify: `libs/common/src/decorators/index.ts`
- Modify: `libs/common/src/common.module.ts` (cache provider 接入)
- Modify: `libs/common/src/index.ts`
- Test: `libs/common/test/memory-cache.provider.spec.ts`
- Test: `libs/common/test/cacheable.decorator.spec.ts`

### Step 3.1: CacheProvider 接口

- [ ] 创建 `libs/common/src/cache/cache.provider.ts`：

```typescript
export interface CacheProvider {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void>;
  del(key: string): Promise<void>;
  /**
   * 按前缀批量删除。MemoryCacheProvider 用 startsWith；
   * RedisCacheProvider 用 SCAN + DEL。
   */
  delByPrefix(prefix: string): Promise<void>;
}

export const CACHE_PROVIDER = Symbol("CACHE_PROVIDER");
```

### Step 3.2: MemoryCacheProvider

- [ ] 创建 `libs/common/src/cache/memory-cache.provider.ts`：

```typescript
import { Injectable } from "@nestjs/common";
import { LRUCache } from "lru-cache";

import type { CacheProvider } from "./cache.provider";

const DEFAULT_TTL_MS = 5 * 60 * 1000;

@Injectable()
export class MemoryCacheProvider implements CacheProvider {
  private readonly lru = new LRUCache<string, unknown>({
    max: 5000,
    ttl: DEFAULT_TTL_MS,
  });

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.lru.get(key) as T | undefined;
  }

  async set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void> {
    this.lru.set(key, value, ttlMs ? { ttl: ttlMs } : undefined);
  }

  async del(key: string): Promise<void> {
    this.lru.delete(key);
  }

  async delByPrefix(prefix: string): Promise<void> {
    for (const k of this.lru.keys()) {
      if (k.startsWith(prefix)) this.lru.delete(k);
    }
  }
}
```

### Step 3.3: @Cacheable / @CacheEvict 装饰器

- [ ] 创建 `libs/common/src/decorators/cacheable.decorator.ts`：

```typescript
import { Logger } from "@nestjs/common";

import type { CacheProvider } from "../cache/cache.provider";
import { generateKey } from "../utils/generate-key";

const CACHE_PROVIDER_KEY = Symbol("CACHE_PROVIDER_INSTANCE");
export const CACHEABLE_MARKER = Symbol("CACHEABLE_MARKER");

export interface CacheableOptions {
  /** 缓存键模板，支持占位符（见 generateKey） */
  key: string;
  /** TTL（毫秒），默认 5 分钟 */
  ttl?: number;
}

export interface CacheEvictOptions {
  /** 待清除的键模板。若以 `*` 结尾，则按前缀清除 */
  key: string;
}

/**
 * 读取缓存的装饰器。命中则直接返回缓存；未命中则执行方法并写入缓存。
 *
 * 约定：每个 @Cacheable 必须配对至少一个 @CacheEvict（在变更入口）。
 */
export function Cacheable(options: CacheableOptions): MethodDecorator {
  return (target, propertyKey, descriptor: PropertyDescriptor) => {
    const original = descriptor.value;
    const className = (target.constructor as { name: string }).name;
    const logger = new Logger(`${className}:${String(propertyKey)}`);
    Reflect.defineMetadata(CACHEABLE_MARKER, true, target.constructor);

    // biome-ignore lint/suspicious/noExplicitAny: 方法参数动态
    descriptor.value = async function (this: any, ...args: any[]) {
      const cache: CacheProvider | undefined = this[CACHE_PROVIDER_KEY];
      if (!cache) {
        return original.apply(this, args);
      }
      const key = generateKey(options.key, args);
      const cached = await cache.get(key);
      if (cached !== undefined) {
        logger.debug(`cache hit: ${key}`);
        return cached;
      }
      const result = await original.apply(this, args);
      await cache.set(key, result, options.ttl);
      return result;
    };
    return descriptor;
  };
}

/**
 * 清除缓存的装饰器。在方法成功返回后清除指定键。
 */
export function CacheEvict(options: CacheEvictOptions): MethodDecorator {
  return (target, propertyKey, descriptor: PropertyDescriptor) => {
    const original = descriptor.value;
    const className = (target.constructor as { name: string }).name;
    const logger = new Logger(`${className}:${String(propertyKey)}`);
    Reflect.defineMetadata(CACHEABLE_MARKER, true, target.constructor);

    // biome-ignore lint/suspicious/noExplicitAny: 方法参数动态
    descriptor.value = async function (this: any, ...args: any[]) {
      const cache: CacheProvider | undefined = this[CACHE_PROVIDER_KEY];
      const result = await original.apply(this, args);
      if (cache) {
        const raw = generateKey(options.key, args);
        if (raw.endsWith("*")) {
          await cache.delByPrefix(raw.slice(0, -1));
        } else {
          await cache.del(raw);
        }
        logger.debug(`cache evicted: ${raw}`);
      }
      return result;
    };
    return descriptor;
  };
}

// biome-ignore lint/suspicious/noExplicitAny: service instance
export function injectCacheProvider(instance: any, cache: CacheProvider) {
  instance[CACHE_PROVIDER_KEY] = cache;
}
```

### Step 3.4: CacheInitializer

- [ ] 创建 `libs/common/src/cache/cache.initializer.ts`：

```typescript
import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { DiscoveryService } from "@nestjs/core";

import { CACHEABLE_MARKER, injectCacheProvider } from "../decorators/cacheable.decorator";
import { CACHE_PROVIDER, type CacheProvider } from "./cache.provider";

@Injectable()
export class CacheInitializer implements OnModuleInit {
  private readonly logger = new Logger(CacheInitializer.name);

  constructor(
    @Inject(CACHE_PROVIDER) private readonly cache: CacheProvider,
    private readonly discoveryService: DiscoveryService,
  ) {}

  onModuleInit() {
    const providers = this.discoveryService.getProviders();
    let count = 0;
    providers.forEach((wrapper) => {
      const instance = wrapper.instance;
      if (!instance || typeof instance !== "object") return;
      if (Reflect.getMetadata(CACHEABLE_MARKER, instance.constructor)) {
        injectCacheProvider(instance, this.cache);
        count++;
      }
    });
    if (count > 0) this.logger.log(`Initialized cache provider for ${count} services`);
  }
}
```

### Step 3.5: 导出 + 接入 CommonModule

- [ ] 创建 `libs/common/src/cache/index.ts`：

```typescript
export { CACHE_PROVIDER, type CacheProvider } from "./cache.provider";
export { MemoryCacheProvider } from "./memory-cache.provider";
export { CacheInitializer } from "./cache.initializer";
```

- [ ] 修改 `libs/common/src/decorators/index.ts`：

```typescript
export { Transactional, TransactionContext } from "./transactional.decorator";
export { WithLock, type WithLockOptions, WITH_LOCK_MARKER } from "./with-lock.decorator";
export { Cacheable, CacheEvict, type CacheableOptions, type CacheEvictOptions, CACHEABLE_MARKER } from "./cacheable.decorator";
```

- [ ] 修改 `libs/common/src/common.module.ts`（追加 cache）：

```typescript
import { DiscoveryModule } from "@nestjs/core";
import { type DynamicModule, Module } from "@nestjs/common";

import { CacheInitializer } from "./cache/cache.initializer";
import { CACHE_PROVIDER, type CacheProvider } from "./cache/cache.provider";
import { MemoryCacheProvider } from "./cache/memory-cache.provider";
import { LockInitializer } from "./lock/lock.initializer";
import { LOCK_PROVIDER, type LockProvider } from "./lock/lock.provider";
import { MemoryLockProvider } from "./lock/memory-lock.provider";

export interface CommonModuleOptions {
  lock?: "memory" | LockProvider;
  cache?: "memory" | CacheProvider;
}

@Module({})
export class CommonModule {
  static forRoot(options: CommonModuleOptions = {}): DynamicModule {
    const lockChoice = options.lock ?? "memory";
    const cacheChoice = options.cache ?? "memory";

    const lockProvider =
      lockChoice === "memory"
        ? { provide: LOCK_PROVIDER, useClass: MemoryLockProvider }
        : { provide: LOCK_PROVIDER, useValue: lockChoice };
    const cacheProvider =
      cacheChoice === "memory"
        ? { provide: CACHE_PROVIDER, useClass: MemoryCacheProvider }
        : { provide: CACHE_PROVIDER, useValue: cacheChoice };

    return {
      module: CommonModule,
      imports: [DiscoveryModule],
      providers: [
        lockProvider,
        cacheProvider,
        LockInitializer,
        CacheInitializer,
        MemoryLockProvider,
        MemoryCacheProvider,
      ],
      exports: [LOCK_PROVIDER, CACHE_PROVIDER],
      global: true,
    };
  }
}
```

- [ ] 修改 `libs/common/src/index.ts`，追加：

```typescript
export * from "./cache";
```

### Step 3.6: cache 单测

- [ ] 创建 `libs/common/test/memory-cache.provider.spec.ts`：

```typescript
import { MemoryCacheProvider } from "../src/cache/memory-cache.provider";

describe("MemoryCacheProvider", () => {
  let cache: MemoryCacheProvider;
  beforeEach(() => {
    cache = new MemoryCacheProvider();
  });

  it("set / get / del", async () => {
    await cache.set("k", "v");
    expect(await cache.get("k")).toBe("v");
    await cache.del("k");
    expect(await cache.get("k")).toBeUndefined();
  });

  it("delByPrefix 清掉所有前缀匹配的键", async () => {
    await cache.set("user:1:profile", "p1");
    await cache.set("user:1:posts", "p2");
    await cache.set("user:2:profile", "p3");
    await cache.delByPrefix("user:1:");
    expect(await cache.get("user:1:profile")).toBeUndefined();
    expect(await cache.get("user:1:posts")).toBeUndefined();
    expect(await cache.get("user:2:profile")).toBe("p3");
  });
});
```

- [ ] 创建 `libs/common/test/cacheable.decorator.spec.ts`：

```typescript
import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { Injectable } from "@nestjs/common";

import { CommonModule } from "../src/common.module";
import { Cacheable, CacheEvict } from "../src/decorators";

@Injectable()
class ProfileService {
  public hits = 0;

  @Cacheable({ key: "profile:#{0}", ttl: 60_000 })
  async getProfile(userId: string): Promise<{ id: string }> {
    this.hits++;
    return { id: userId };
  }

  @CacheEvict({ key: "profile:#{0}" })
  async updateProfile(userId: string, _data: object): Promise<void> {}
}

describe("@Cacheable / @CacheEvict", () => {
  let svc: ProfileService;
  beforeEach(async () => {
    const ref = await Test.createTestingModule({
      imports: [CommonModule.forRoot()],
      providers: [ProfileService],
    }).compile();
    await ref.init();
    svc = ref.get(ProfileService);
  });

  it("第一次未命中，第二次命中", async () => {
    await svc.getProfile("u1");
    await svc.getProfile("u1");
    expect(svc.hits).toBe(1);
  });

  it("CacheEvict 后再次访问需要重算", async () => {
    await svc.getProfile("u1");
    await svc.updateProfile("u1", {});
    await svc.getProfile("u1");
    expect(svc.hits).toBe(2);
  });
});
```

### Step 3.7: 验证 + 提交

- [ ] `pnpm --filter @meshbot/common build` → 通过
- [ ] 提交：

```bash
git add libs/common
git commit -m "feat(common): add CacheProvider abstraction with MemoryCacheProvider, @Cacheable, @CacheEvict

Memory 实现基于 lru-cache。@Cacheable 必须配对 @CacheEvict
（约定写入 CLAUDE.md，Phase 2 由 skill 强制）。"
```

---

## Task 4: server-agent 接入 TxTypeOrmModule + CommonModule + @Transactional

**Files:**
- Modify: `apps/server-agent/src/app.module.ts`
- Modify: `apps/server-agent/src/services/auth.service.ts`
- Modify: `apps/server-agent/src/services/setting.service.ts`
- Modify: `apps/server-agent/src/services/model-config.service.ts`
- Modify: `apps/server-agent/package.json` (添加 @meshbot/common 依赖)

### Step 4.1: 加 dependency

- [ ] 修改 `apps/server-agent/package.json`，在 `dependencies` 内追加：

```json
"@meshbot/common": "workspace:*",
```

- [ ] 运行 `pnpm install`。

### Step 4.2: app.module.ts 接入 TxTypeOrmModule + CommonModule + WAL pragma

- [ ] 替换 `apps/server-agent/src/app.module.ts` 内容：

```typescript
import path from "node:path";
import { AgentModule } from "@meshbot/agent";
import { CommonModule, TxTypeOrmModule } from "@meshbot/common";
import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { TypeOrmModule } from "@nestjs/typeorm";
import { LocalAuthModule } from "./auth/local-auth.module";
import { AuthModule } from "./auth.module";
import { ModelConfigController } from "./controllers/model-config.controller";
import { SettingController } from "./controllers/setting.controller";
import { SetupController } from "./controllers/setup.controller";
import { ModelConfig } from "./entities/model-config.entity";
import { Setting } from "./entities/setting.entity";
import { User } from "./entities/user.entity";
import { JwtAuthGuard } from "./guards/jwt-auth.guard";
import { ModelConfigService } from "./services/model-config.service";
import { SettingService } from "./services/setting.service";
import { StaticModule } from "./static.module";
import { resolveMeshbotDir } from "./utils/meshbot-dir";

const meshbotDir = resolveMeshbotDir();

@Module({
  imports: [
    CommonModule.forRoot(),
    TypeOrmModule.forRoot({
      type: "better-sqlite3",
      database: path.join(meshbotDir, "agent.db"),
      entities: [ModelConfig, Setting, User],
      synchronize: true,
      // SQLite 并发优化：WAL 模式 + 5s 锁等待
      // 详见 spec 第 5.1 节风险 R1
      extra: {
        pragma: {
          journal_mode: "WAL",
          busy_timeout: 5000,
        },
      },
    }),
    TxTypeOrmModule.forFeature([ModelConfig, Setting]),
    AgentModule,
    AuthModule,
    LocalAuthModule,
    StaticModule,
  ],
  controllers: [ModelConfigController, SettingController, SetupController],
  providers: [
    ModelConfigService,
    SettingService,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule {}
```

### Step 4.3: AuthModule 中的 User 也走 TxTypeOrmModule

- [ ] 找到 `apps/server-agent/src/auth.module.ts`：

```bash
cat apps/server-agent/src/auth.module.ts
```

- [ ] 把里面 `TypeOrmModule.forFeature([User])` 替换为 `TxTypeOrmModule.forFeature([User])`（保留所有其他配置）。

### Step 4.4: 给 auth.service 的 register 加 @Transactional

`register` 涉及"判断是否首个用户 + 创建用户"两步，未来若加 user_profile 等扩展会变成多表写入；现在就挂上装饰器为未来留位。

- [ ] 修改 `apps/server-agent/src/services/auth.service.ts`：

```typescript
import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Transactional } from "@meshbot/common";
import { JwtService } from "@nestjs/jwt";
import { InjectRepository } from "@nestjs/typeorm";
import * as bcrypt from "bcrypt";
import { Repository } from "typeorm";
import { User } from "../entities/user.entity";

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly jwtService: JwtService,
  ) {}

  @Transactional()
  async register(
    username: string,
    password: string,
  ): Promise<{ access_token: string }> {
    const existingUser = await this.userRepo.count();
    if (existingUser > 0) {
      throw new ConflictException("已存在注册用户，不允许重复注册");
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = this.userRepo.create({ username, passwordHash });
    await this.userRepo.save(user);

    return this.signToken(user);
  }

  async login(
    username: string,
    password: string,
  ): Promise<{ access_token: string }> {
    const user = await this.userRepo.findOneBy({ username });
    if (!user) {
      throw new UnauthorizedException("用户名或密码错误");
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedException("用户名或密码错误");
    }

    return this.signToken(user);
  }

  async getStatus(): Promise<{ initialized: boolean; needsSetup: boolean }> {
    const userCount = await this.userRepo.count();
    return {
      initialized: userCount > 0,
      needsSetup: userCount === 0,
    };
  }

  async validateUser(userId: string): Promise<User | null> {
    return this.userRepo.findOneBy({ id: userId });
  }

  private signToken(user: User): { access_token: string } {
    const payload = { sub: user.id, username: user.username };
    return { access_token: this.jwtService.sign(payload) };
  }
}
```

### Step 4.5: setting.service / model-config.service 评估

`SettingService.set` 是单表 upsert，不需要 `@Transactional`。
`ModelConfigService.update` / `remove` 是单表，也不需要。
**本步无代码改动**，只在 CLAUDE.md（Task 7）写明判断原则。

- [ ] 跳过修改，但在 Task 7 的 CLAUDE.md 中写入"单表写入不挂 @Transactional"。

### Step 4.6: 冒烟启动

- [ ] 运行 `pnpm dev:server-agent`，确认能正常启动到监听端口（无 ALS / Repository 注入相关报错）。
- [ ] `Ctrl+C` 退出。

### Step 4.7: 提交

```bash
git add apps/server-agent
git commit -m "feat(server-agent): wire TxTypeOrmModule + CommonModule, add @Transactional to register

启用 SQLite WAL pragma 缓解 SQLITE_BUSY（spec R1）。
register 挂 @Transactional 为后续扩展留位。"
```

---

## Task 5: libs/types-main 骨架 + createZodDto

**Files:**
- Create: `libs/types-main/package.json`
- Create: `libs/types-main/tsconfig.json`
- Create: `libs/types-main/src/index.ts`
- Create: `libs/types-main/src/sample/register-agent.schema.ts`
- Create: `libs/common/src/dto/create-zod-dto.ts`
- Create: `libs/common/src/dto/index.ts`
- Modify: `libs/common/src/index.ts`

### Step 5.1: 创建 libs/types-main

- [ ] 创建 `libs/types-main/package.json`：

```json
{
  "name": "@meshbot/types-main",
  "version": "0.0.1",
  "private": true,
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc --project tsconfig.json",
    "dev": "tsc --project tsconfig.json --watch",
    "clean": "rm -rf dist",
    "typecheck": "tsc --project tsconfig.json --noEmit"
  },
  "dependencies": {
    "@meshbot/types": "workspace:*",
    "zod": "^3"
  }
}
```

- [ ] 创建 `libs/types-main/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "declaration": true
  },
  "include": ["src/**/*"]
}
```

### Step 5.2: 写 sample schema（不落表）

- [ ] 创建 `libs/types-main/src/sample/register-agent.schema.ts`：

```typescript
import { z } from "zod";

/**
 * Sample schema —— 验证 Zod 分层 + createZodDto 工作流。
 * Phase 3 server-main 起步时由真实 Agent 注册 schema 替换。
 */
export const RegisterAgentSchema = z.object({
  agentId: z.string().uuid(),
  deviceName: z.string().min(1).max(64),
  capabilities: z.array(z.string()).default([]),
});

export type RegisterAgentInput = z.infer<typeof RegisterAgentSchema>;
```

- [ ] 创建 `libs/types-main/src/index.ts`：

```typescript
export { RegisterAgentSchema, type RegisterAgentInput } from "./sample/register-agent.schema";
```

### Step 5.3: createZodDto（无 i18n 版）

- [ ] 创建 `libs/common/src/dto/create-zod-dto.ts`：

```typescript
import { BadRequestException, type PipeTransform } from "@nestjs/common";
import type { ZodTypeAny, infer as ZInfer } from "zod";

/**
 * 把 Zod schema 转成一个可以在 NestJS controller 用的 DTO 类。
 *
 * 返回类型既是构造函数（NestJS 用于 reflect/Swagger）也带有静态校验 pipe。
 *
 * 用法：
 * ```ts
 * import { RegisterAgentSchema } from "@meshbot/types-main";
 * import { createZodDto } from "@meshbot/common";
 *
 * export class RegisterAgentDto extends createZodDto(RegisterAgentSchema) {}
 *
 * @Post("register")
 * register(@Body() dto: RegisterAgentDto) { ... }
 * ```
 *
 * 注：Phase 1 是无 i18n 简化版。Phase 2 若决定上 i18n，
 * 升级为 createI18nZodDto，从 nestjs-i18n 注入翻译。
 */
export function createZodDto<TSchema extends ZodTypeAny>(schema: TSchema) {
  class ZodDto {
    static schema = schema;

    static validate(value: unknown): ZInfer<TSchema> {
      const parsed = schema.safeParse(value);
      if (!parsed.success) {
        throw new BadRequestException({
          message: "Validation failed",
          errors: parsed.error.flatten(),
        });
      }
      return parsed.data;
    }

    static pipe(): PipeTransform {
      return {
        transform: (value: unknown) => ZodDto.validate(value),
      };
    }
  }
  return ZodDto as unknown as new () => ZInfer<TSchema>;
}
```

- [ ] 创建 `libs/common/src/dto/index.ts`：

```typescript
export { createZodDto } from "./create-zod-dto";
```

- [ ] 修改 `libs/common/src/index.ts`，追加：

```typescript
export * from "./dto";
```

### Step 5.4: 验证构建

- [ ] 运行 `pnpm --filter @meshbot/types-main build` → 通过
- [ ] 运行 `pnpm --filter @meshbot/common build` → 通过

### Step 5.5: 提交

```bash
git add libs/types-main libs/common
git commit -m "feat(types-main): add libs/types-main skeleton with createZodDto

createZodDto 是无 i18n 的简化版；Phase 2 视决策升级为 createI18nZodDto。
sample schema 仅用于验证工作流，不落表。"
```

---

## Task 6: 4 个静态围栏脚本搬运

**Files:**
- Create: `scripts/README.md`
- Create: `scripts/check-transactional.ts` (从  拷贝)
- Create: `scripts/check-method-naming.ts` (从  拷贝)
- Create: `scripts/check-lock-tx.ts` (从  拷贝)
- Create: `scripts/check-repo-access.ts` (从  拷贝)
- Modify: `package.json` (scripts: check:*)

**前置：** 假设你有 `/Users/grant//platform` 检出。如果没有，先 `git clone` 一份到本机参考。

### Step 6.1: 拷贝并适配 check-transactional.ts

- [ ] 拷贝：

```bash
cp /Users/grant//platform/scripts/check-transactional.ts \
   /Users/grant/Meta1/meshbot/scripts/check-transactional.ts
```

- [ ] 用 Read 工具打开 `scripts/check-transactional.ts`，找到 glob 配置和 ignore 列表，确认/修改：
  - 扫描 glob：`libs/*/src/**/*.service.ts` + `apps/server-*/src/**/*.service.ts`（应该已对齐 meshbot 结构，无需改）
  - **关键改造**：在 ignore 列表里加上 meshbot 特有的路径：
    - `libs/agent/**`（agent 域用 vitest，不挂 NestJS DI 给 Service 装饰器）
    - `apps/cli-agent/**`（cli 工具，非 NestJS 服务）
    - `packages/**`（前端包）
  - 移除  专属路径：搜索 `libs/rag` / `libs/memory` / `libs/agent-tools` / `server-app` / `server-rag` / `server-memory`，删除相关分支
  - 把  中可能写死的 ai-platform 字样改成 meshbot

具体编辑：
- 找到类似 `const SCAN_GLOBS = [...]` 的常量，确认包含 meshbot 的 `apps/server-agent/src` + `libs/common/src`，不包含  的多 server 路径
- 找到 ignore 配置（可能在 SCAN_GLOBS 也可能在 micromatch 调用），追加上面三条
- 如果脚本里硬编码了"libs/<domain>"白名单，确认 meshbot 当前有效域为 `common` / `types` / `types-agent` / `types-main` / `shared` / `agent`

### Step 6.2: 拷贝并适配 check-method-naming.ts

- [ ] 拷贝：

```bash
cp /Users/grant//platform/scripts/check-method-naming.ts \
   /Users/grant/Meta1/meshbot/scripts/check-method-naming.ts
```

- [ ] 同 Step 6.1 一样的 glob/ignore 适配。

### Step 6.3: 拷贝并适配 check-lock-tx.ts

- [ ] 拷贝：

```bash
cp /Users/grant//platform/scripts/check-lock-tx.ts \
   /Users/grant/Meta1/meshbot/scripts/check-lock-tx.ts
```

- [ ] 同 Step 6.1。

### Step 6.4: 拷贝并适配 check-repo-access.ts

- [ ] 拷贝：

```bash
cp /Users/grant//platform/scripts/check-repo-access.ts \
   /Users/grant/Meta1/meshbot/scripts/check-repo-access.ts
```

- [ ] 同 Step 6.1。
- [ ] 额外检查：这个脚本依赖"每个 Entity 唯一归属一个 Service"。meshbot 现状 server-agent 已合规（3 entity → 3 service），适配后应直接通过。

### Step 6.5: 创建 scripts/README.md

- [ ] 创建 `scripts/README.md`：

````markdown
# meshbot scripts

所有可执行脚本放在本目录，统一用 `tsx` 运行。

## 命名约定

- 文件名：`<verb>-<noun>.ts`（kebab-case），例如 `check-transactional.ts` / `sync-locales.ts`
- 顶部 JSDoc 用中文写明：脚本目标、使用场景、退出码语义
- 失败退出码：非 0；成功：0

## 当前脚本

| 脚本 | pnpm 命令 | 用途 |
|------|-----------|------|
| `check-transactional.ts` | `pnpm check:tx` | 校验 `@Transactional` 完整性（跨表写入是否挂） |
| `check-method-naming.ts` | `pnpm check:naming` | 校验事务方法命名约定（`*InDb` / `*InTx` / `persist*`） |
| `check-lock-tx.ts` | `pnpm check:lock-tx` | 校验事务-锁倒置漏洞（`@WithLock` 不可在 `@Transactional` 内） |
| `check-repo-access.ts` | `pnpm check:repo` | 校验 Entity 唯一归属 + 跨 libs 注入 Repository 限制 |

一键全跑：`pnpm check`

## 适用范围

围栏只针对 NestJS 服务层代码（`libs/**/src/**` + `apps/server-*/src/**`）。
以下路径被显式排除：
- `libs/agent/**` —— Agent 域内部不挂 NestJS 装饰器（用 vitest）
- `apps/cli-agent/**` —— CLI 工具，非 NestJS 服务
- `packages/**` —— 前端包
````

### Step 6.6: 添加 pnpm scripts

- [ ] 修改根 `package.json`，在 `scripts` 中追加：

```json
"check:tx": "tsx scripts/check-transactional.ts",
"check:naming": "tsx scripts/check-method-naming.ts",
"check:lock-tx": "tsx scripts/check-lock-tx.ts",
"check:repo": "tsx scripts/check-repo-access.ts",
"check": "pnpm check:tx && pnpm check:naming && pnpm check:lock-tx && pnpm check:repo"
```

### Step 6.7: 运行围栏 —— 必须全绿

- [ ] 运行 `pnpm check`。
- [ ] **若有 fail**，按违例修复 server-agent 代码（这部分预计微小：register 已加 @Transactional，setting/model-config 不挂，naming 应已合规）。修到全绿。
- [ ] **特殊情形**：若 `check-tx` 提示 `auth.service.ts:register` 跨多表写入但未挂 —— Step 4.4 已挂上了，不应有此告警。

### Step 6.8: 提交

```bash
git add scripts package.json
git commit -m "feat(scripts): port 4 static fences from platform

check:tx / check:naming / check:lock-tx / check:repo —— 全部在
server-agent 现状下跑绿。围栏 ignore 加 libs/agent / cli-agent / packages。"
```

---

## Task 7: .claude/CLAUDE.md 写入纪律规约

**Files:**
- Create: `.claude/CLAUDE.md`

### Step 7.1: 创建 CLAUDE.md

- [ ] 创建 `.claude/CLAUDE.md`（参考  CLAUDE.md，按 meshbot 现状定制）：

````markdown
# CLAUDE.md

本文件指导 Claude Code 在 meshbot 仓库的工作方式。

## 常用命令

### 开发

| 命令 | 说明 |
|------|------|
| `pnpm dev:server-agent` | 本地 Agent 后端（NestJS watch，端口 3100） |
| `pnpm dev:server-main` | 云协同后端（NestJS watch，端口 3200，Phase 3 起有内容） |
| `pnpm dev:web-agent` | 桌面端 UI（Next.js，端口 3001） |
| `pnpm dev:web-main` | 云协同前端（Next.js，端口 3002） |
| `pnpm dev:desktop` | Electron 桌面壳 |
| `pnpm dev:cli-agent` | 命令行 Agent |

### 构建与测试

- `pnpm build` — Turbo 拓扑构建
- `pnpm test` — Jest（root 配置，覆盖 libs/common 与 server-agent）
- `pnpm typecheck` — 全包 TS 类型检查
- `pnpm lint` / `pnpm format` — Biome
- `pnpm clean:imports` — 自动移除未使用 import（Biome）

### 静态围栏（写完代码必跑）

```bash
pnpm check   # 一键跑下面 4 个
pnpm check:tx
pnpm check:naming
pnpm check:lock-tx
pnpm check:repo
```

## 项目架构

meshbot 是 **本地优先 + 云端协同** 的双形态 AI Agent 平台。

```
apps/
├── server-agent/   NestJS 本地 Agent 后端（SQLite + LangGraph）
├── server-main/    NestJS 云协同后端（Postgres，Phase 3 起步）
├── web-agent/      Next.js 桌面端 UI
├── web-main/       Next.js 云协同前端
├── desktop/        Electron 壳（fork server-agent）
└── cli-agent/      命令行 Agent 工具

libs/
├── common/         NestJS 基础设施（装饰器 / TxTypeOrmModule / Lock / Cache / Dto）
├── shared/         （历史空壳，保留）
├── agent/          Agent 域 LangGraph 编排
├── types/          跨域 Zod schema + TS 类型
├── types-agent/    Agent 域 schema
└── types-main/     云协同域 schema

packages/
├── common/         Web 公共逻辑
└── design/         shadcn/Radix UI 组件库
```

**依赖方向**：`apps/server-*` → `libs/<domain>` → `libs/types-<domain>` → `libs/common`。只允许从上到下、从右到左，禁止反向。

**两轨**：
- **本地轨**（server-agent + cli-agent + desktop + web-agent）：单进程 + SQLite + 单用户，跑全部 Agent 业务逻辑
- **云端轨**（server-main + web-main）：Postgres + Redis + 多租户，只跑协同元数据 CRUD，**不跑 Agent 逻辑**

## 关键约定

### Repository 访问规范（check:repo）

- 每个 TypeORM Entity 有且仅有一个归属 Service（唯一持有 `@InjectRepository(X)` 的类）
- Controller / Gateway / Tool 禁止直接注入 Repository，必须通过归属 Service 访问
- 跨 `libs/<domain>/` 边界禁止注入其他模块的 Entity Repository

### 事务、锁、缓存（仅在 Service 层）

- **`@Transactional()`**：**跨表写入时使用**。单表 upsert / 单表 update 不需要。模块用 `TxTypeOrmModule.forFeature()` 注册 Entity（替代 `TypeOrmModule.forFeature()`）。事务上下文通过 AsyncLocalStorage 自动传播到子 Service。
- **`@WithLock`**：并发竞态/幂等保护。**必须在 `@Transactional` 外层**（锁包事务），严禁事务内嵌套锁（事务-锁倒置，`pnpm check:lock-tx` 自动校验）。
- **`@Cacheable` / `@CacheEvict`**：每个 `@Cacheable` 必须配对至少一个 `@CacheEvict`。缓存键格式：`模块:实体:#{参数索引或路径}`。

### 事务方法命名（check:naming）

私有 `@Transactional()` 方法命名必须命中以下约定之一：`*InDb`、`*InTx`、`*InTransaction`、`persist*`。反向也成立：私有方法名命中这些后缀 → 必须挂 `@Transactional()`。

### 数据库规范

- **本地轨**（SQLite）：当前用 `synchronize: true`（Phase 3 切换到迁移文件）；DataSource 启用 `journal_mode=WAL` + `busy_timeout=5000` 缓解 SQLITE_BUSY
- **云端轨**（Postgres，Phase 3 起）：迁移文件 + 幂等 SQL（`IF NOT EXISTS`）+ 索引 `CONCURRENTLY` + 列名 snake_case + 逻辑外键
- 禁止数据库级别外键约束（不使用 `@ManyToOne`/`@OneToMany`/`@JoinColumn`）

### Zod / DTO（共享数据模型）

- 跨域 schema 放 `libs/types`；域内 schema 放 `libs/types-<domain>`
- `libs/types-*` **禁止依赖 NestJS / TypeORM**
- 后端用 `createZodDto(schema)` 把 Zod 转 NestJS DTO 类（Phase 2 视决策升级为 i18n 版）
- Entity 与 Schema 分离：Entity 在 `libs/<domain>/`，Schema 在 `libs/types-<domain>/`

### 前端表单（Phase 2 补全）

Phase 1 暂未引入 Form/FormItem 封装；现阶段写表单允许直接用 shadcn 组件。Phase 2 后必须走 `Form/FormItem` + `useSchema`。

### 测试

- 新代码默认 Jest；`libs/agent` 历史用 vitest，不强行统一
- 装饰器、Provider、围栏脚本必须有单测
- E2E 测试 Phase 3 起引入

### 其他

- 数据库列名 snake_case（项目配置 `SnakeNamingStrategy`，Phase 3 落地）
- 公开方法包含中文 JSDoc
- 禁止在 `if` 前一行放置注释（Biome 格式化会破坏结构）
- 不新建 PRD 文档，设计决策记在对话或 commit 中

## 开发工作流

1. **brainstorm** —— 用 superpowers:brainstorming skill 探讨需求 / 确认范围
2. **writing-plans** —— 出实施 plan
3. **编码** —— TDD 优先（先写失败的单测）
4. **静态围栏** —— commit 前 `pnpm check`
5. **commit** —— 中文提交信息，遵循 conventional commits 风格

## 表归属

| 应用 | 数据库 | Entity 示例 |
|------|--------|-------------|
| server-agent | `agent.db`（SQLite，~/.meshbot/） | `User` / `Setting` / `ModelConfig` |
| server-main | Postgres（Phase 3） | `User` / `Organization` / `AgentRegistration` / `Device` |
````

### Step 7.2: 提交

```bash
git add .claude/CLAUDE.md
git commit -m "docs: add .claude/CLAUDE.md with engineering disciplines

涵盖：Repository 访问、装饰器使用、事务命名、Zod 分层、
SQLite 限制、两轨架构、围栏命令、工作流。"
```

---

## Task 8: Jest 配置 + 跑通所有装饰器单测

**Files:**
- Create: `jest.config.ts`
- Modify: `package.json` (scripts: test, test:cov)
- 回归 Task 1/2/3 的单测（应全部 PASS）

### Step 8.1: 安装依赖（如果 Task 0 没装）

- [ ] 确认根 `package.json` 的 `devDependencies` 包含：

```json
"jest": "^29",
"ts-jest": "^29",
"@types/jest": "^29",
"tsx": "^4"
```

如缺，运行 `pnpm add -w -D jest@^29 ts-jest@^29 @types/jest@^29 tsx@^4`。

### Step 8.2: 创建根 jest.config.ts

- [ ] 创建 `jest.config.ts`：

```typescript
import type { Config } from "jest";

const config: Config = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: ".",
  roots: ["<rootDir>/libs", "<rootDir>/apps", "<rootDir>/scripts"],
  testMatch: ["**/?(*.)+(spec|test).ts"],
  // 排除 libs/agent（用 vitest）和 packages/*（前端，不在 jest 范围）
  testPathIgnorePatterns: [
    "/node_modules/",
    "/dist/",
    "<rootDir>/libs/agent/",
    "<rootDir>/packages/",
  ],
  moduleNameMapper: {
    "^@meshbot/common$": "<rootDir>/libs/common/src",
    "^@meshbot/common/(.*)$": "<rootDir>/libs/common/src/$1",
    "^@meshbot/types$": "<rootDir>/libs/types/src",
    "^@meshbot/types-agent$": "<rootDir>/libs/types-agent/src",
    "^@meshbot/types-main$": "<rootDir>/libs/types-main/src",
    "^@meshbot/shared$": "<rootDir>/libs/shared/src",
  },
  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      {
        tsconfig: "<rootDir>/tsconfig.base.json",
        isolatedModules: true,
      },
    ],
  },
  setupFilesAfterEach: [],
  globalSetup: undefined,
  // 默认 5s 超时；事务测试可能更慢
  testTimeout: 15_000,
};

export default config;
```

### Step 8.3: 添加 pnpm scripts

- [ ] 修改根 `package.json`，在 `scripts` 中追加：

```json
"test": "jest",
"test:watch": "jest --watch",
"test:cov": "jest --coverage"
```

### Step 8.4: 跑通 Task 1/2/3 写过的测试

- [ ] 运行 `pnpm test libs/common/test/transactional.decorator.spec.ts`，预期 PASS 2 个 it。
- [ ] 运行 `pnpm test libs/common/test/memory-lock.provider.spec.ts`，预期 PASS 3 个 it。
- [ ] 运行 `pnpm test libs/common/test/with-lock.decorator.spec.ts`，预期 PASS 2 个 it。
- [ ] 运行 `pnpm test libs/common/test/memory-cache.provider.spec.ts`，预期 PASS 2 个 it。
- [ ] 运行 `pnpm test libs/common/test/cacheable.decorator.spec.ts`，预期 PASS 2 个 it。
- [ ] 运行 `pnpm test`（全量），预期 0 fail。

### Step 8.5: 补一个 TxTypeOrmModule 覆盖测

- [ ] 创建 `libs/common/test/tx-typeorm.module.spec.ts`（验证嵌套 service 调用时事务自动传播）：

```typescript
import "reflect-metadata";
import { Injectable } from "@nestjs/common";
import { InjectRepository, TypeOrmModule } from "@nestjs/typeorm";
import { Test } from "@nestjs/testing";
import { Column, DataSource, Entity, PrimaryGeneratedColumn, Repository } from "typeorm";

import { Transactional, TxTypeOrmModule } from "../src";

@Entity()
class Item {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column()
  name!: string;
}

@Injectable()
class ChildService {
  constructor(@InjectRepository(Item) private readonly repo: Repository<Item>) {}

  async create(name: string): Promise<Item> {
    return this.repo.save({ name });
  }
}

@Injectable()
class ParentService {
  constructor(
    @InjectRepository(Item) private readonly repo: Repository<Item>,
    private readonly child: ChildService,
  ) {}

  @Transactional()
  async createTwoAndFail(): Promise<void> {
    await this.child.create("a");
    await this.repo.save({ name: "b" });
    throw new Error("boom");
  }

  async findAll(): Promise<Item[]> {
    return this.repo.find();
  }
}

describe("TxTypeOrmModule auto-propagation", () => {
  let parent: ParentService;
  let ds: DataSource;

  beforeAll(async () => {
    const ref = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: "better-sqlite3",
          database: ":memory:",
          entities: [Item],
          synchronize: true,
        }),
        TxTypeOrmModule.forFeature([Item]),
      ],
      providers: [ParentService, ChildService],
    }).compile();

    parent = ref.get(ParentService);
    ds = ref.get(DataSource);
  });

  afterAll(async () => {
    await ds.destroy();
  });

  it("子 service 的写入在父事务回滚时也被回滚", async () => {
    await expect(parent.createTwoAndFail()).rejects.toThrow("boom");
    const all = await parent.findAll();
    expect(all).toHaveLength(0);
  });
});
```

- [ ] 运行 `pnpm test libs/common/test/tx-typeorm.module.spec.ts`，预期 PASS。

### Step 8.6: 提交

```bash
git add jest.config.ts package.json libs/common/test
git commit -m "feat(test): add Jest config and decorator unit tests

ts-jest + node env，moduleNameMapper 接 workspace 包；libs/agent 排除
（保留 vitest）。Transactional / TxTypeOrmModule / Lock / Cache 全套测试通过。"
```

---

## Task 9: Turbo 任务扩展 + pnpm 收口 + 根 scripts

**Files:**
- Modify: `turbo.json`
- Modify: `pnpm-workspace.yaml`
- Modify: `package.json` (root scripts)

### Step 9.1: 扩展 turbo.json

- [ ] 替换 `turbo.json` 内容：

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**", ".next/**"]
    },
    "dev": {
      "cache": false,
      "persistent": true
    },
    "lint": {
      "dependsOn": ["^build"]
    },
    "typecheck": {
      "dependsOn": ["^build"]
    },
    "test": {
      "dependsOn": ["^build"],
      "outputs": ["coverage/**"]
    },
    "clean": {
      "cache": false
    }
  }
}
```

注：`check:*` 是 root-only 脚本（围栏全局扫描），不需要 turbo 编排，root `package.json` 已有。

### Step 9.2: pnpm-workspace.yaml 收口

- [ ] 替换 `pnpm-workspace.yaml`：

```yaml
packages:
  - apps/*
  - libs/*
  - packages/*

onlyBuiltDependencies:
  - '@nestjs/core'
  - '@parcel/watcher'
  - '@swc/core'
  - bcrypt
  - better-sqlite3
  - electron
  - electron-winstaller
  - esbuild
  - sharp

peerDependencyRules:
  ignoreMissing:
    - dotenv
  allowedVersions:
    "@nestjs/core": "11"
    "@nestjs/common": "11"
    "@nestjs/typeorm": "11"
    "reflect-metadata": "*"
```

### Step 9.3: 根 package.json 整理

- [ ] 修改根 `package.json` 的 `scripts`（在已有基础上确保包含）：

```json
{
  "scripts": {
    "build": "turbo run build",
    "dev": "turbo run dev",
    "typecheck": "turbo run typecheck",
    "test": "jest",
    "test:watch": "jest --watch",
    "test:cov": "jest --coverage",
    "lint": "biome lint .",
    "format": "biome format --write .",
    "check:format": "biome check --write .",
    "check:tx": "tsx scripts/check-transactional.ts",
    "check:naming": "tsx scripts/check-method-naming.ts",
    "check:lock-tx": "tsx scripts/check-lock-tx.ts",
    "check:repo": "tsx scripts/check-repo-access.ts",
    "check": "pnpm check:tx && pnpm check:naming && pnpm check:lock-tx && pnpm check:repo",
    "clean": "turbo run clean && rm -rf node_modules"
  }
}
```

（保留已有的 `dev:server-agent` / `pkg:app` 等 app 级别脚本，本次不动。）

### Step 9.4: 一键 smoke

- [ ] 运行：

```bash
pnpm install   # 验证 peerDependencyRules 不报警
pnpm typecheck # 全包通过
pnpm build     # 全包构建通过
pnpm test      # 全部测试通过
pnpm check     # 4 围栏全绿
```

任何一项失败必须修复，不能 skip。

### Step 9.5: 提交

```bash
git add turbo.json pnpm-workspace.yaml package.json
git commit -m "chore(monorepo): expand turbo tasks, lock pnpm peer deps, unify root scripts

turbo 增加 test/typecheck；pnpm peerDependencyRules 收口 NestJS 11；
root scripts 对齐 check:* + test* + build/dev 三组主线。"
```

---

## Task 10: server-agent 合规扫描总收尾

**目标**：完整跑一遍 `pnpm check` / `pnpm test` / `pnpm typecheck` / `pnpm build`，确认 Phase 1 退出标志全部满足。如有未捕获的问题，原地修复。

### Step 10.1: 全量回归

- [ ] 运行：

```bash
pnpm install
pnpm typecheck
pnpm build
pnpm test
pnpm check
```

- [ ] 启动一次 server-agent 冒烟：

```bash
pnpm dev:server-agent
# 等待 "Nest application successfully started"
# 用 curl 触发 register/login（按现有 controller 端点）
curl -X POST http://localhost:3100/auth/setup -d '{"username":"smoke","password":"abc12345"}' -H "Content-Type: application/json"
# Ctrl+C 退出
```

- [ ] 删掉冒烟产生的 `~/.meshbot/agent.db`（避免污染下次启动）：

```bash
rm -f ~/.meshbot/agent.db ~/.meshbot/agent.db-shm ~/.meshbot/agent.db-wal
```

### Step 10.2: 落实 Phase 2 待办列表（仅文档，不实现）

- [ ] 在 `.claude/CLAUDE.md` 末尾追加一段 "Phase 1 已完成 / Phase 2 待办" 标记区，列出：

```markdown
## Phase 进度

### Phase 1（地基）✅ 已完成

- libs/common 装饰器与基础设施
- 4 个静态围栏
- libs/types-main 骨架 + createZodDto（无 i18n 版）
- Jest 配置 + 装饰器单测
- Turbo / pnpm 配置对齐
- server-agent 接入 TxTypeOrmModule + @Transactional

### Phase 2（工程化 harness）待办

- 搬运 .claude/skills（参考 platform）
- check:dead-exports
- packages/design 补 Form/FormItem + useSchema
- husky/lefthook + pre-commit 跑围栏
- post-build.js（Next standalone）
- i18n 决策（是否上 nestjs-i18n + next-intl）

详见 spec 第 5.3 节。
```

### Step 10.3: 最终提交

```bash
git add .claude/CLAUDE.md
git commit -m "docs(claude): mark Phase 1 complete, list Phase 2 backlog

Phase 1 退出标志（check/test/typecheck/build 全绿 + server-agent 冒烟通过）已达成。"
```

### Step 10.4: 创建里程碑 tag（可选）

- [ ] 如需打 tag：

```bash
git tag -a phase-1-foundation -m "Phase 1: foundation (decorators + fences + types-main + CLAUDE.md)"
```

---

## Phase 1 验收清单

- [ ] `pnpm install` 无 peer dep 警告
- [ ] `pnpm typecheck` 全包通过
- [ ] `pnpm build` 全包构建通过
- [ ] `pnpm test` Jest 全部 PASS（装饰器 + Provider + TxTypeOrmModule）
- [ ] `pnpm check` 4 围栏全绿
- [ ] `libs/common` 含装饰器、Provider 接口、内存实现、createZodDto
- [ ] `libs/types-main` 骨架 + sample schema 可被引用
- [ ] `server-agent` 启动正常，register 端点工作，事务行为正确
- [ ] `.claude/CLAUDE.md` 注入新会话生效（Claude 能识别 `pnpm check` 等命令）
- [ ] Phase 2 待办在 CLAUDE.md 中明确列出
