import { Injectable } from "@nestjs/common";
import type Redis from "ioredis";

import type { CacheProvider } from "./cache.provider";

const SCAN_BATCH = 100;

/**
 * 基于 Redis 的 CacheProvider —— 简单 JSON 编解码 + PX TTL。
 *
 * - `get`：raw 命中走 JSON.parse；不存在返回 `undefined`（与 `MemoryCacheProvider` 一致）
 * - `set`：默认无 TTL；传 `ttlMs` 时走 `SET key value PX ttl`
 * - `del`：`DEL key`
 * - `delByPrefix`：`SCAN MATCH prefix* COUNT 100`（流式，避免 `KEYS` 全量阻塞）+ 管道 `DEL` 批量
 *
 * **未做的事**（与 MemoryCacheProvider 对齐）：
 * - 不内置 LRU 上限（Redis 自身 maxmemory 策略控制）
 * - 不做 stampede / single-flight；调用方自行加 `@WithLock` 配套
 */
@Injectable()
export class RedisCacheProvider implements CacheProvider {
  constructor(private readonly redis: Redis) {}

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const raw = await this.redis.get(key);
    if (raw === null) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      // 不是有效 JSON：兜底当成 string
      return raw as unknown as T;
    }
  }

  async set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void> {
    const payload = JSON.stringify(value);
    if (ttlMs && ttlMs > 0) {
      await this.redis.set(key, payload, "PX", ttlMs);
    } else {
      await this.redis.set(key, payload);
    }
  }

  async del(key: string): Promise<void> {
    await this.redis.del(key);
  }

  async delByPrefix(prefix: string): Promise<void> {
    const stream = this.redis.scanStream({
      match: `${prefix}*`,
      count: SCAN_BATCH,
    });
    const pipeline = this.redis.pipeline();
    let hasAny = false;
    for await (const keys of stream as AsyncIterable<string[]>) {
      if (keys.length === 0) continue;
      hasAny = true;
      for (const k of keys) pipeline.del(k);
    }
    if (hasAny) await pipeline.exec();
  }
}
