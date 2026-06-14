import { Inject, Injectable, Optional } from "@nestjs/common";
import { REDIS_CLIENT } from "../tokens";

/**
 * 用户在线状态 TTL（秒）。
 * 客户端应在此时间内发 heartbeat，否则视为离线。
 */
const PRESENCE_TTL_SECONDS = 45;

/**
 * PresenceService 用到的 Redis 命令子集。
 * 避免直接 import ioredis（libs/main 未把 ioredis 列为依赖），
 * 同时方便测试时注入手写桩。
 */
interface RedisPresenceClient {
  zadd(key: string, score: number, member: string): Promise<number>;
  zrem(key: string, member: string): Promise<number>;
  zremrangebyscore(
    key: string,
    min: string | number,
    max: string | number,
  ): Promise<number>;
  zrange(key: string, start: number, stop: number): Promise<string[]>;
}

/**
 * PresenceService —— 跟踪每个 org 的在线用户。
 *
 * 数据结构（Redis 路径）：Sorted-Set `presence:<orgId>`，
 * score = 过期时间戳（ms）。
 * - setOnline / heartbeat：ZADD score=now+TTL member=userId
 * - setOffline：ZREM
 * - listOnline：先 ZREMRANGEBYSCORE 清过期，再 ZRANGE 取全部
 *
 * Redis 不可用时退化到进程内 Map<orgId, Map<userId, expiresAtMs>>，
 * 语义相同，仅在 listOnline 时惰性清理已过期条目。
 *
 * 注入的 Redis 实例可为 null（server-main 的 REDIS_CLIENT token 在
 * 未配置 Redis 时为 null），消费方需用 @Optional() 注入。
 */
@Injectable()
export class PresenceService {
  /**
   * 内存回退存储：orgId → (userId → expiresAtMs)。
   * Redis 可用时不使用。
   */
  private readonly memStore = new Map<string, Map<string, number>>();

  /**
   * @param redis   ioredis 实例；null → 走内存回退路径
   * @param nowFn   当前时间（ms），默认 Date.now；可注入以便测试推进虚假时钟
   */
  // B8 必须提供 { provide: REDIS_CLIENT, useValue: <Redis|null> }
  constructor(
    @Optional()
    @Inject(REDIS_CLIENT)
    private readonly redis: RedisPresenceClient | null,
    private readonly nowFn: () => number = Date.now,
  ) {}

  /**
   * 标记用户上线，设置 TTL。
   * Redis：ZADD presence:<orgId> score=expireAt userId
   * 内存：Map 写入 expireAt
   */
  async setOnline(orgId: string, userId: string): Promise<void> {
    const expireAt = this.nowFn() + PRESENCE_TTL_SECONDS * 1000;
    if (this.redis) {
      await this.redis.zadd(this.key(orgId), expireAt, userId);
    } else {
      this.memOrg(orgId).set(userId, expireAt);
    }
  }

  /**
   * 标记用户离线，立即移除。
   * Redis：ZREM
   * 内存：Map.delete
   */
  async setOffline(orgId: string, userId: string): Promise<void> {
    if (this.redis) {
      await this.redis.zrem(this.key(orgId), userId);
    } else {
      this.memOrg(orgId).delete(userId);
    }
  }

  /**
   * 续期 TTL（等同于重新 setOnline）。
   */
  async heartbeat(orgId: string, userId: string): Promise<void> {
    return this.setOnline(orgId, userId);
  }

  /**
   * 返回 orgId 下当前在线的 userId 列表。
   * Redis：先 ZREMRANGEBYSCORE 清过期成员，再 ZRANGE 0 -1
   * 内存：惰性过滤过期条目（不立即 delete，仅过滤读取）
   */
  async listOnline(orgId: string): Promise<string[]> {
    const now = this.nowFn();
    if (this.redis) {
      const k = this.key(orgId);
      // 清除 score（expireAt）<= now 的成员（已过期）
      await this.redis.zremrangebyscore(k, "-inf", now);
      return this.redis.zrange(k, 0, -1);
    }
    const orgMap = this.memStore.get(orgId);
    if (!orgMap) return [];
    // 惰性清理并返回未过期成员
    const online: string[] = [];
    for (const [userId, expireAt] of orgMap) {
      if (expireAt > now) {
        online.push(userId);
      } else {
        orgMap.delete(userId);
      }
    }
    // 清理空 org，避免长期运行多租户场景下外层 Map 无限增长
    if (orgMap.size === 0) {
      this.memStore.delete(orgId);
    }
    return online;
  }

  // ─── 私有辅助 ─────────────────────────────────────────────────────────────

  /** Redis sorted-set 键名。 */
  private key(orgId: string): string {
    return `presence:${orgId}`;
  }

  /** 获取（或建立）orgId 的内存 Map。 */
  private memOrg(orgId: string): Map<string, number> {
    let m = this.memStore.get(orgId);
    if (!m) {
      m = new Map();
      this.memStore.set(orgId, m);
    }
    return m;
  }
}
