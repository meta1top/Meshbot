import { Injectable } from "@nestjs/common";
import { LRUCache } from "lru-cache";

import type { CacheProvider } from "./cache.provider";

const DEFAULT_TTL_MS = 5 * 60 * 1000;

@Injectable()
export class MemoryCacheProvider implements CacheProvider {
  // biome-ignore lint/complexity/noBannedTypes: LRUCache v11 的 V 泛型约束为 {}（非空），用 {} 兼容任意非 null/undefined 值
  private readonly lru = new LRUCache<string, {}>({
    max: 5000,
    ttl: DEFAULT_TTL_MS,
  });

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.lru.get(key) as T | undefined;
  }

  async set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void> {
    // biome-ignore lint/complexity/noBannedTypes: 对齐 LRUCache v11 的 V 约束
    this.lru.set(key, value as {}, ttlMs ? { ttl: ttlMs } : undefined);
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
