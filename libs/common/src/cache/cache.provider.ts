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
