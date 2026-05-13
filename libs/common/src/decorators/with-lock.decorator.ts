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
      const lockKey = generated.startsWith("lock:")
        ? generated
        : `lock:${generated}`;
      const ttl = options.ttl ?? 30000;
      const waitTimeout = options.waitTimeout ?? 5000;

      logger.debug(`Acquiring lock: ${lockKey}`);
      const release = await provider
        .acquire(lockKey, ttl, waitTimeout)
        .catch((_err) => {
          logger.warn(`Failed to acquire lock: ${lockKey}`);
          throw new Error(
            options.errorMessage ?? `操作正在处理中，请稍后重试 (${lockKey})`,
          );
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
