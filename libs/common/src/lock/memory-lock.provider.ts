import { Injectable } from "@nestjs/common";
import { E_TIMEOUT, Mutex, withTimeout } from "async-mutex";

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
