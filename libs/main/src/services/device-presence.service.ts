import { Inject, Injectable, Optional } from "@nestjs/common";
import { REDIS_CLIENT } from "../tokens";
import type { RedisPresenceClient } from "./presence.service";

const PRESENCE_TTL_SECONDS = 45;

/**
 * DevicePresenceService —— 跟踪每个 org 的设备级在线态。
 *
 * 数据结构（Redis 路径）：Sorted-Set `presence:device:<orgId>`，
 * score = 过期时间戳（ms），member = deviceId。
 * - setOnline / heartbeat：ZADD score=now+TTL member=deviceId
 * - setOffline：ZREM
 * - listOnline：先 ZREMRANGEBYSCORE 清过期，再 ZRANGE 取全部
 *
 * Redis 不可用时退化到进程内 Map<orgId, Map<deviceId, expiresAtMs>>，
 * 语义相同，仅在 listOnline 时惰性清理已过期条目。
 */
@Injectable()
export class DevicePresenceService {
  private readonly memory = new Map<string, Map<string, number>>();

  /**
   * @param redis   ioredis 实例；null → 走内存回退路径
   * @param nowFn   时钟函数；NestJS DI 下无对应 provider，靠 @Optional 注入 undefined
   */
  constructor(
    @Optional()
    @Inject(REDIS_CLIENT)
    private readonly redis: RedisPresenceClient | null,
    @Optional() private readonly nowFn?: () => number,
  ) {}

  private now(): number {
    return this.nowFn ? this.nowFn() : Date.now();
  }

  private key(orgId: string): string {
    return `presence:device:${orgId}`;
  }

  /**
   * 标记设备 Agent 在线(续期)。
   * Redis：ZADD presence:device:<orgId> score=expireAt deviceId
   * 内存：Map 写入 expireAt
   */
  async setOnline(orgId: string, deviceId: string): Promise<void> {
    const expireAt = this.now() + PRESENCE_TTL_SECONDS * 1000;
    if (this.redis) {
      await this.redis.zadd(this.key(orgId), expireAt, deviceId);
      return;
    }
    const m = this.memory.get(orgId) ?? new Map();
    m.set(deviceId, expireAt);
    this.memory.set(orgId, m);
  }

  /**
   * 心跳续期。
   */
  async heartbeat(orgId: string, deviceId: string): Promise<void> {
    return this.setOnline(orgId, deviceId);
  }

  /**
   * 标记离线。
   * Redis：ZREM
   * 内存：Map.delete
   */
  async setOffline(orgId: string, deviceId: string): Promise<void> {
    if (this.redis) {
      await this.redis.zrem(this.key(orgId), deviceId);
      return;
    }
    this.memory.get(orgId)?.delete(deviceId);
  }

  /**
   * 在线设备列表(清过期)。
   * Redis：先 ZREMRANGEBYSCORE 清过期，再 ZRANGE 0 -1
   * 内存：惰性过滤过期条目
   */
  async listOnline(orgId: string): Promise<string[]> {
    const now = this.now();
    if (this.redis) {
      await this.redis.zremrangebyscore(this.key(orgId), 0, now);
      return this.redis.zrange(this.key(orgId), 0, -1);
    }
    const m = this.memory.get(orgId);
    if (!m) return [];
    const out: string[] = [];
    for (const [id, exp] of m) {
      if (exp <= now) m.delete(id);
      else out.push(id);
    }
    return out;
  }

  /**
   * 单设备是否在线。
   */
  async isOnline(orgId: string, deviceId: string): Promise<boolean> {
    return (await this.listOnline(orgId)).includes(deviceId);
  }
}
