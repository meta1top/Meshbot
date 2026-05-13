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
