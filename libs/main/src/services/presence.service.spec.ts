/**
 * PresenceService 单测
 *
 * 测试策略：
 * - null Redis → 内存回退路径（可控、无外部依赖）
 * - fake Redis 桩 → Redis 路径（Sorted-Set 命令手写桩）
 * - 时钟可注入（nowFn）→ TTL 过期场景可验证
 */

import { PresenceService } from "./presence.service";

// ─── 手写 Fake Redis 桩（仅实现 PresenceService 用到的命令） ────────────────

type FakeZMember = { score: number; member: string };

class FakeRedis {
  private zsets = new Map<string, FakeZMember[]>();

  /** ZADD key score member */
  async zadd(key: string, score: number, member: string): Promise<number> {
    let members = this.zsets.get(key) ?? [];
    const idx = members.findIndex((m) => m.member === member);
    if (idx >= 0) {
      members[idx].score = score;
      return 0;
    }
    members = [...members, { score, member }];
    this.zsets.set(key, members);
    return 1;
  }

  /** ZREM key member */
  async zrem(key: string, member: string): Promise<number> {
    const members = this.zsets.get(key);
    if (!members) return 0;
    const next = members.filter((m) => m.member !== member);
    this.zsets.set(key, next);
    return members.length - next.length;
  }

  /** ZREMRANGEBYSCORE key -inf max（删除 score <= max 的成员） */
  async zremrangebyscore(
    key: string,
    _min: string | number,
    max: string | number,
  ): Promise<number> {
    const members = this.zsets.get(key);
    if (!members) return 0;
    const maxN = typeof max === "number" ? max : Number(max);
    const next = members.filter((m) => m.score > maxN);
    const removed = members.length - next.length;
    this.zsets.set(key, next);
    return removed;
  }

  /** ZRANGE key 0 -1（取全部成员，不含 score） */
  async zrange(key: string, _start: number, _stop: number): Promise<string[]> {
    const members = this.zsets.get(key) ?? [];
    return members.map((m) => m.member);
  }
}

// ─── 辅助工厂 ────────────────────────────────────────────────────────────────

function makeInMemorySvc(nowFn?: () => number): PresenceService {
  return new PresenceService(null, nowFn);
}

function makeRedisSvc(redis: FakeRedis, nowFn?: () => number): PresenceService {
  // biome-ignore lint/suspicious/noExplicitAny: FakeRedis 桩不完整对齐 ioredis 类型
  return new PresenceService(redis as any, nowFn);
}

// ─── 内存回退路径 ─────────────────────────────────────────────────────────────

describe("PresenceService（内存回退路径 redis=null）", () => {
  it("setOnline 后 listOnline 包含该用户", async () => {
    const svc = makeInMemorySvc();
    await svc.setOnline("org1", "user1");
    expect(await svc.listOnline("org1")).toContain("user1");
  });

  it("setOffline 后 listOnline 不含该用户", async () => {
    const svc = makeInMemorySvc();
    await svc.setOnline("org1", "user1");
    await svc.setOffline("org1", "user1");
    expect(await svc.listOnline("org1")).not.toContain("user1");
  });

  it("heartbeat 续期后仍在线（到期前）", async () => {
    let now = 1_000_000;
    const svc = makeInMemorySvc(() => now);

    await svc.setOnline("org1", "user1");
    // 向前推进 44 秒（TTL=45s，还差 1s 到期）
    now += 44_000;
    await svc.heartbeat("org1", "user1");

    // 再向前推进 44 秒（heartbeat 续期后总还差 1s）
    now += 44_000;
    expect(await svc.listOnline("org1")).toContain("user1");
  });

  it("TTL 过期后 listOnline 不含该用户", async () => {
    let now = 1_000_000;
    const svc = makeInMemorySvc(() => now);

    await svc.setOnline("org1", "user1");
    // 向前推进 46 秒（超过 TTL 45s）
    now += 46_000;
    expect(await svc.listOnline("org1")).not.toContain("user1");
  });

  it("多 org 隔离：org1 的在线不出现在 org2", async () => {
    const svc = makeInMemorySvc();
    await svc.setOnline("org1", "user1");
    await svc.setOnline("org2", "user2");

    const org1 = await svc.listOnline("org1");
    const org2 = await svc.listOnline("org2");

    expect(org1).toContain("user1");
    expect(org1).not.toContain("user2");
    expect(org2).toContain("user2");
    expect(org2).not.toContain("user1");
  });

  it("未上线的 org 返回空数组", async () => {
    const svc = makeInMemorySvc();
    expect(await svc.listOnline("org-empty")).toEqual([]);
  });
});

// ─── Redis 路径 ───────────────────────────────────────────────────────────────

describe("PresenceService（Redis 路径）", () => {
  it("setOnline 后 listOnline 包含该用户", async () => {
    const redis = new FakeRedis();
    const svc = makeRedisSvc(redis);
    await svc.setOnline("org1", "user1");
    expect(await svc.listOnline("org1")).toContain("user1");
  });

  it("setOffline 后 listOnline 不含该用户", async () => {
    const redis = new FakeRedis();
    const svc = makeRedisSvc(redis);
    await svc.setOnline("org1", "user1");
    await svc.setOffline("org1", "user1");
    expect(await svc.listOnline("org1")).not.toContain("user1");
  });

  it("heartbeat 续期后仍在线（到期前）", async () => {
    let now = 1_000_000;
    const redis = new FakeRedis();
    const svc = makeRedisSvc(redis, () => now);

    await svc.setOnline("org1", "user1");
    // 向前 44s（TTL 剩 1s）
    now += 44_000;
    await svc.heartbeat("org1", "user1");

    // 再向前 44s（heartbeat 后 TTL 重置，仍剩 1s）
    now += 44_000;
    expect(await svc.listOnline("org1")).toContain("user1");
  });

  it("TTL 过期后 listOnline 不含该用户", async () => {
    let now = 1_000_000;
    const redis = new FakeRedis();
    const svc = makeRedisSvc(redis, () => now);

    await svc.setOnline("org1", "user1");
    now += 46_000; // 超过 45s TTL
    expect(await svc.listOnline("org1")).not.toContain("user1");
  });

  it("多 org 隔离：org1 的在线不出现在 org2", async () => {
    const redis = new FakeRedis();
    const svc = makeRedisSvc(redis);
    await svc.setOnline("org1", "user1");
    await svc.setOnline("org2", "user2");

    const org1 = await svc.listOnline("org1");
    const org2 = await svc.listOnline("org2");

    expect(org1).toContain("user1");
    expect(org1).not.toContain("user2");
    expect(org2).toContain("user2");
    expect(org2).not.toContain("user1");
  });
});
