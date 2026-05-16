import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import type Redis from "ioredis";

import type { LockProvider, LockRelease } from "./lock.provider";

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

const POLL_INTERVAL_MS = 50;

/**
 * 基于单点 Redis 的 LockProvider —— Redlock 单点变体。
 *
 * - `SET NX PX` 原子申请；token 防止释放别人的锁
 * - 释放走 Lua 原子脚本（GET + DEL 同一事务）
 * - `waitMs` 内拿不到锁抛 `LOCK_ACQUIRE_FAILED: <key>`，对齐 MemoryLockProvider 行为
 *
 * **Phase 4 不做 TTL 续期（watchdog）**：业务方法应保持短；
 * 若运行超 `ttlMs` 仍未完成，锁自动释放、后续请求竞争，由调用方接受可能的并发。
 *
 * **生产 HA**：本实现是单点 Redis，单点故障时锁失效。
 * Phase 5 切 Redis Sentinel / Cluster 时换实现即可（接口不变）。
 */
@Injectable()
export class RedisLockProvider implements LockProvider {
  constructor(private readonly redis: Redis) {}

  async acquire(
    key: string,
    ttlMs: number,
    waitMs: number,
  ): Promise<LockRelease> {
    const token = randomUUID();
    const deadline = Date.now() + Math.max(0, waitMs);

    while (true) {
      const ok = await this.redis.set(key, token, "PX", ttlMs, "NX");
      if (ok === "OK") return this.makeRelease(key, token);

      if (Date.now() >= deadline) {
        throw new Error(`LOCK_ACQUIRE_FAILED: ${key}`);
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }

  /**
   * 包一层"已释放"标志，让 release 幂等：第二次调用直接返回，不再访问 Redis。
   */
  private makeRelease(key: string, token: string): LockRelease {
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      await this.redis.eval(RELEASE_SCRIPT, 1, key, token);
    };
  }
}
