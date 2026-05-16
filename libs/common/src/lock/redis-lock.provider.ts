import { randomUUID } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import type Redis from "ioredis";

import type {
  AcquireOptions,
  LockProvider,
  LockRelease,
} from "./lock.provider";

/**
 * 释放锁的 Lua 脚本：原子地"读 token + 匹配 + 删除"，
 * 防止释放他人持有的锁（TOCTOU 竞态）。
 */
const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

/**
 * Phase 6 B2：续期 Lua 脚本。token 不匹配返回 0，由调用方判断停止 watchdog。
 */
const RENEW_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
else
  return 0
end
`;

const POLL_INTERVAL_MS = 50;

/**
 * 基于单点 Redis 的 LockProvider —— Redlock 单点变体。
 *
 * - `SET NX PX` 原子申请；token 防止释放别人的锁
 * - 释放走 Lua 原子脚本（GET + DEL 同一事务）
 * - `waitMs` 内拿不到锁抛 `LOCK_ACQUIRE_FAILED: <key>`，对齐 MemoryLockProvider 行为
 * - Phase 6 B2：可选 watchdog 自动续期（`acquire` 传 `{ watchdog: true }`）
 *
 * **生产 HA**：本实现是单点 Redis，单点故障时锁失效。
 * 未来切 Redis Sentinel / Cluster 时换实现即可（接口不变）。
 */
@Injectable()
export class RedisLockProvider implements LockProvider {
  private readonly logger = new Logger(RedisLockProvider.name);

  constructor(private readonly redis: Redis) {}

  async acquire(
    key: string,
    ttlMs: number,
    waitMs: number,
    options?: AcquireOptions,
  ): Promise<LockRelease> {
    const token = randomUUID();
    const deadline = Date.now() + Math.max(0, waitMs);

    while (true) {
      const ok = await this.redis.set(key, token, "PX", ttlMs, "NX");
      if (ok === "OK") return this.makeRelease(key, token, ttlMs, options);

      if (Date.now() >= deadline) {
        throw new Error(`LOCK_ACQUIRE_FAILED: ${key}`);
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }

  /**
   * 包一层"已释放"标志，让 release 幂等：第二次调用直接返回，不再访问 Redis。
   *
   * Phase 6 B2：若 options.watchdog 为 true，启动定时器周期续期；release 时清理。
   */
  private makeRelease(
    key: string,
    token: string,
    ttlMs: number,
    options?: AcquireOptions,
  ): LockRelease {
    let released = false;
    let timer: NodeJS.Timeout | null = null;

    if (options?.watchdog) {
      const renewMs =
        options.renewIntervalMs && options.renewIntervalMs > 0
          ? options.renewIntervalMs
          : Math.max(100, Math.floor(ttlMs / 3));
      timer = setInterval(() => {
        // setInterval callback 不可 await；用 IIFE 处理异步
        (async () => {
          try {
            const result = (await this.redis.eval(
              RENEW_SCRIPT,
              1,
              key,
              token,
              String(ttlMs),
            )) as number;
            if (result === 0) {
              // 锁已不属于我们（TTL 过期被他人抢占 / 主动释放后又重入）
              // 静默停止 watchdog，不抛错避免破坏业务方法
              if (timer) {
                clearInterval(timer);
                timer = null;
              }
              this.logger.warn(
                `[watchdog] lock ${key} no longer held; stopping renew`,
              );
            }
          } catch (err) {
            // Redis 短暂故障：下一轮 tick 自动重试，不影响业务
            this.logger.warn(`[watchdog] renew error on ${key}: ${err}`);
          }
        })();
      }, renewMs);
      // 不阻塞 process.exit
      timer.unref?.();
    }

    return async () => {
      if (released) return;
      released = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      await this.redis.eval(RELEASE_SCRIPT, 1, key, token);
    };
  }
}
