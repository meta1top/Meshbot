# 设备 Agent 反向通道(子项目 B)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让一台已注册设备的本地 Agent 成为云端可寻址、可私聊的 IM 身份——人在 web-main IM 私聊设备 Agent,消息经 ws/im 长连的 device room 定向下发到该设备,server-agent 触发本地 run,回复异步回流;离线消息排队,重连补处理。

**Architecture:** 复用 A 建好的每账号 ws/im 长连(im-relay ↔ ImGateway,握手已带 deviceId)。server-main 侧:IM 表加两列(`conversation.agent_device_id` / `message.sender_type`),device 连接握手加入 `device:<deviceId>` room,发给 Agent-DM 会话的消息定向 emit `agent.inbound` 到该 room,device token 连接回流的消息盖 `sender_type='agent'`;新增设备级 presence。server-agent 侧:新 `AgentInboxService`(仿 `DispatchSubagentService`)`@OnEvent(agent.inbound)` → 找/建映射本地会话 → `RunnerService.kickAndWait` → 回流;本地 `im_agent_session.last_processed_message_id` 作处理游标,重连时经新端点枚举本设备 Agent-DM 会话补处理。web-main 新建 IM 前端,直连 server-main `/ws/im`(浏览器 JWT)。

**Tech Stack:** NestJS + TypeORM(Postgres / better-sqlite3)、socket.io(server + client)、Redis adapter(跨副本 room)、Zod + nestjs-zod、Next.js + next-intl + react-query。

**Spec:** `docs/superpowers/specs/2026-07-04-device-agent-reverse-channel-design.md`

## Global Constraints

- 提交信息中文、conventional commits;每个 task 结束单独 commit;pre-commit `pnpm check` 必须全绿,禁止 `--no-verify`。
- 前端新增 `t()` key 时:在 web-main `messages/{zh,en}.json` **对称写入真实嵌套文案**(sync-locales 已能解析命名空间前缀,不需要顶层占位);`pnpm sync:locales -- --check` 必须 `missing=0 asymmetric=0`;禁裸字符串。
- 新 named export 必须同 commit 内有消费方(check:dead)。
- 错误码:libs/main 段 2000-2999(下一可用 **2029**);server-agent 段 3000-3999(下一可用 **3016**);新码同步 `apps/server-*/i18n/{zh,en}/*.json`。
- server-main DDL:纯 SQL 追加文件 `apps/server-main/migrations/<YYYYMMDDHHmm>-<summary>.sql`,幂等(`ADD COLUMN IF NOT EXISTS`)、snake_case、逻辑外键、文件不可变;服务不自动建表。
- server-agent SQLite:TypeORM 迁移 `apps/server-agent/src/migrations/<ts>-<Name>.ts`,`name` 字段 = class 名;下一时间戳 **1780900000000**;SQLite 无 DROP COLUMN,`down` 保留列;迁移经 glob 自动注册。
- 账号作用域:server-agent 带 `cloud_user_id` 的表必须经 `ScopedRepository`(构造里 `scopedFactory.create(rawRepo)`,另留裸 `txAnchorRepo` 供 `@Transactional`);where 用属性名 `cloudUserId`。
- 事务/锁:跨表写 `@Transactional()`(私有方法命名 `*InTx`/`*InDb`/`persist*`),`@WithLock` 包 `@Transactional`。
- Entity 唯一归属 Service;Controller/Gateway 禁注 Repository。
- IM 事件契约集中在 `libs/types/src/im/im.events.ts`(`IM_WS_EVENTS` 常量) + `im.schema.ts`(zod);新增下行事件加进常量表,三处消费方(ImGateway/EventsGateway/ImRelayClientService)自动可用。
- web-main WS 直连 server-main `/ws/im`(`IM_WS_NAMESPACE="ws/im"`),`auth.token = getMainToken()`(浏览器 JWT,非 device token),base 用 `NEXT_PUBLIC_SERVER_MAIN_URL`;订阅**直接的 `IM_WS_EVENTS.*` 事件**(非 web-agent 的 `"event"` 信封)。
- Agent 就是 device(deviceId 即参与者 id),不新建 Agent 表;B 限本人私聊,不做频道/群(C)、不做流式(只回最终 assistant 消息)。
- 公开方法中文 JSDoc;禁止 `if` 前一行注释。

## 任务总览

| Phase | Task | 内容 |
|---|---|---|
| 1 云端 | 1 | IM 表加列 DDL(agent_device_id / sender_type)+ Entity |
| | 2 | `MessageService` senderType + `ConversationService` Agent-DM(建/列/校验) |
| | 3 | `DevicePresenceService`(设备级 presence,键 deviceId) |
| | 4 | 共享 schema:`agent.inbound` 事件 + Agent-DM DTO |
| | 5 | `ImGateway`:device room + agent присence + agent.inbound 下发 + 回流盖 agent 身份 |
| | 6 | Agent-DM REST(建会话 / 列本设备会话 / 设备在线态) |
| | 7 | server-main e2e(反向通道全链路) |
| 2 本地 | 8 | SQLite 迁移 + `ImAgentSession` Entity + `ImAgentSessionService` |
| | 9 | im-relay-client:agent.inbound 下行 + connected 事件 |
| | 10 | `AgentInboxService`:inbound → 会话 → kickAndWait → 回流 |
| | 11 | `AgentInboxService` 重连补处理(游标 + in-flight 锁 + 枚举) |
| 3 前端 | 12 | web-main 依赖 + ws/im 客户端 + IM rest hooks |
| | 13 | IM 壳 + 侧栏 + Agent picker |
| | 14 | 会话视图(消息列表 + 输入框) |
| | 15 | presence 集成 + 设备页在线态 + 收尾 |
| 4 收尾 | 16 | 文档 + 全量回归 + boot + 冒烟 |

---

## Phase 1:云端后端(server-main + libs/main)

### Task 1: IM 表加列 DDL + Entity

**Files:**
- Create: `apps/server-main/migrations/202607041000-agent-dm-columns.sql`
- Modify: `libs/main/src/entities/conversation.entity.ts`(加 `agentDeviceId`)
- Modify: `libs/main/src/entities/message.entity.ts`(加 `senderType`)
- Test: `apps/server-main/test/e2e/agent-dm-ddl.spec.ts`

**Interfaces:**
- Produces: `Conversation.agentDeviceId: string | null`(列 `agent_device_id`);`Message.senderType: 'user' | 'agent'`(列 `sender_type`,默认 'user')。

- [ ] **Step 1: 写失败测试**

`apps/server-main/test/e2e/agent-dm-ddl.spec.ts`(仿 `apps/server-main/test/e2e/device-ddl.spec.ts` 装配:`createTestDb` + `information_schema` 断言):

```ts
import { DataSource } from "typeorm";
import { createTestDb, isPostgresReachable, type TestDbContext } from "../setup/test-db";

describe("agent-dm DDL", () => {
  let ctx: TestDbContext;
  let ds: DataSource;
  beforeAll(async () => {
    if (!(await isPostgresReachable())) return;
    ctx = await createTestDb();
    ds = new DataSource(ctx.dataSourceOptions);
    await ds.initialize();
  });
  afterAll(async () => {
    await ds?.destroy();
    await ctx?.cleanup();
  });

  it("conversation.agent_device_id 与 message.sender_type 列存在", async () => {
    if (!ds) return;
    const cols = await ds.query(
      `SELECT table_name, column_name, column_default FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND ((table_name='conversation' AND column_name='agent_device_id')
           OR (table_name='message' AND column_name='sender_type'))`,
    );
    const conv = cols.find((c: { table_name: string }) => c.table_name === "conversation");
    const msg = cols.find((c: { table_name: string }) => c.table_name === "message");
    expect(conv).toBeTruthy();
    expect(msg).toBeTruthy();
    expect(String(msg.column_default)).toContain("user");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec jest apps/server-main/test/e2e/agent-dm-ddl.spec.ts`
Expected: FAIL(列不存在)。Postgres 不可达时 suite skip。

- [ ] **Step 3: 写 DDL**

`apps/server-main/migrations/202607041000-agent-dm-columns.sql`:

```sql
-- 设备 Agent 反向通道(子项目 B):IM 表加列。DBA 手动执行;幂等;snake_case。
-- agent_device_id 有值 = 该会话是"人 ↔ 设备 Agent"的 DM(值为目标设备 id)。
ALTER TABLE "conversation" ADD COLUMN IF NOT EXISTS "agent_device_id" varchar(20);
CREATE INDEX IF NOT EXISTS "ix_conversation_agent_device" ON "conversation" ("agent_device_id");

-- sender_type:人发 'user' / Agent 回 'agent';存量行默认 'user'。
ALTER TABLE "message" ADD COLUMN IF NOT EXISTS "sender_type" varchar(8) NOT NULL DEFAULT 'user';
```

- [ ] **Step 4: 改 Entity**

`conversation.entity.ts` 在 `visibility` 之后加:

```ts
  @Column({ type: "varchar", length: 20, nullable: true }) agentDeviceId!: string | null;
```

`message.entity.ts` 在 `content` 之后加:

```ts
  @Column({ type: "varchar", length: 8, default: "user" }) senderType!: "user" | "agent";
```

- [ ] **Step 5: 跑测试通过 + 提交**

Run: `pnpm exec jest apps/server-main/test/e2e/agent-dm-ddl.spec.ts` → PASS;`pnpm check`。

```bash
git add apps/server-main/migrations libs/main/src/entities
git commit -m "feat(server-main): Agent-DM IM 表加列(conversation.agent_device_id / message.sender_type)"
```

---

### Task 2: MessageService senderType + ConversationService Agent-DM

**Files:**
- Modify: `libs/main/src/services/message.service.ts`(persistMessage 带 senderType)
- Modify: `libs/main/src/services/conversation.service.ts`(建/列/校验 Agent-DM)
- Modify: `libs/main/src/errors/main.error-codes.ts`(2029 AGENT_DEVICE_INVALID)
- Modify: `apps/server-main/i18n/{zh,en}/*.json`
- Test: `libs/main/src/services/conversation.service.spec.ts`(新增或扩展)

**Interfaces:**
- Consumes: `DeviceService`(libs/main,`listByUser`/校验设备归属),`Conversation.agentDeviceId`(Task 1)。
- Produces:
  - `MessageService.persistMessage(conversationId, senderId, content, senderType?: 'user'|'agent'): Promise<ImMessage>`(默认 'user';返回的 `ImMessage` 需带 `senderType`——`ImMessage` 类型 Task 4 扩展)
  - `ConversationService.findOrCreateAgentDm(orgId, userId, deviceId): Promise<ConversationSummary>`(校验 device 属于该 user + orgId;`agent_device_id` 唯一化,一个 user↔device 一条会话;dmKey 复用 `[userId, 'agent:'+deviceId].sort().join(':')` 保证幂等)
  - `ConversationService.listAgentDmsForDevice(deviceId): Promise<{ conversationId: string; orgId: string }[]>`(server-agent 补处理枚举用,unscoped 按 agent_device_id 查)
  - `ConversationService.getAgentDmOrThrow(conversationId): Promise<Conversation>`(agent_device_id 为空抛 AGENT_DEVICE_INVALID;供 gateway 判定"这是 Agent-DM,该定向下发")

- [ ] **Step 1: 写失败测试**

扩展 `conversation.service.spec.ts`(mock repo + mock DeviceService),用例:
1. `findOrCreateAgentDm` 对合法 device 建会话,`agentDeviceId` 落值;二次调用返回同一会话(幂等)。
2. `findOrCreateAgentDm` 对不属于该 user 的 device 抛 `AGENT_DEVICE_INVALID`。
3. `listAgentDmsForDevice` 返回该 device 的全部 Agent-DM 会话 id + orgId。
4. `persistMessage(..., 'agent')` 落 `senderType='agent'`。

- [ ] **Step 2: 跑测试确认失败** → FAIL。

- [ ] **Step 3: 实现**

`message.service.ts` 的 `persistMessage` 加第 4 参数 `senderType: "user" | "agent" = "user"`,`create/save` 时写入,返回对象带 `senderType`。

`conversation.service.ts` 注入 `DeviceService`(同 libs/main,直接构造注入),新增:

```ts
/** 找/建当前用户与某设备 Agent 的私聊会话(幂等) */
async findOrCreateAgentDm(orgId: string, userId: string, deviceId: string): Promise<ConversationSummary> {
  const device = await this.devices.findOwnedActive(userId, deviceId);
  if (!device) throw new AppError(MainErrorCode.AGENT_DEVICE_INVALID);
  return this.findOrCreateAgentDmLocked(orgId, userId, deviceId);
}

@WithLock({ key: "agentdm:findOrCreate:#{1}:#{2}", waitTimeout: 5000 })
private async findOrCreateAgentDmLocked(orgId: string, userId: string, deviceId: string): Promise<ConversationSummary> {
  const existing = await this.convRepo.findOne({ where: { agentDeviceId: deviceId, createdBy: userId } });
  if (existing) return this.toSummary(existing, userId);
  return this.persistAgentDmInTx(orgId, userId, deviceId);
}

@Transactional()
private async persistAgentDmInTx(orgId: string, userId: string, deviceId: string): Promise<ConversationSummary> {
  const conv = await this.convRepo.save(this.convRepo.create({
    orgId, type: "dm", name: null, dmKey: null, createdBy: userId, visibility: "private", agentDeviceId: deviceId,
  }));
  const memberRepo = this.convRepo.manager.getRepository(ConversationMember);
  await memberRepo.save(memberRepo.create({ conversationId: conv.id, userId }));
  return this.toSummary(conv, userId);
}

/** 枚举某设备的全部 Agent-DM 会话(server-agent 补处理用,不带账号作用域) */
async listAgentDmsForDevice(deviceId: string): Promise<{ conversationId: string; orgId: string }[]> {
  const rows = await this.convRepo.find({ where: { agentDeviceId: deviceId } });
  return rows.map((c) => ({ conversationId: c.id, orgId: c.orgId }));
}

/** 断言会话是 Agent-DM,返回其 agentDeviceId */
async getAgentDmOrThrow(conversationId: string): Promise<Conversation> {
  const conv = await this.convRepo.findOne({ where: { id: conversationId } });
  if (!conv || !conv.agentDeviceId) throw new AppError(MainErrorCode.AGENT_DEVICE_INVALID);
  return conv;
}
```

(`toSummary` 对 agent-dm 需产出 `peer` 表达 Agent 身份:`peer = { userId: 'agent:'+deviceId, displayName: device.name, email: '' }`——Task 4 的 `ConversationSummary` 扩展一个 `agentDeviceId?` 字段,前端据此渲染 Agent 会话。实现时在 `toSummary` 里若 `conv.agentDeviceId` 非空,查 device 名填 peer + 带上 agentDeviceId。)

`DeviceService` 加 `findOwnedActive(userId, deviceId): Promise<Device | null>`(`findOne({where:{id:deviceId, userId}})`,`revokedAt` 非空返回 null)。

错误码 `main.error-codes.ts` 加 `AGENT_DEVICE_INVALID: { code: 2029, message: "im.agentDeviceInvalid", httpStatus: 400 }`;i18n zh `"设备 Agent 无效或已吊销"` / en。

- [ ] **Step 4: 跑测试通过 + 提交**

Run: `pnpm exec jest libs/main/src/services/conversation.service.spec.ts` → PASS;`pnpm check`。

```bash
git add libs/main/src apps/server-main/i18n
git commit -m "feat(server-main): ConversationService Agent-DM(建/列/校验)+ MessageService senderType"
```

---

### Task 3: DevicePresenceService(设备级 presence)

**Files:**
- Create: `libs/main/src/services/device-presence.service.ts`
- Modify: `libs/main/src/main.module.ts` / `libs/main/src/index.ts`(注册导出)
- Test: `libs/main/src/services/device-presence.service.spec.ts`

**Interfaces:**
- Produces(仿 `PresenceService`,键到 deviceId):
  - `DevicePresenceService.setOnline(orgId, deviceId): Promise<void>`(ZADD `presence:device:<orgId>` score=now+TTL member=deviceId)
  - `setOffline(orgId, deviceId): Promise<void>`
  - `heartbeat(orgId, deviceId): Promise<void>`(= setOnline 续期)
  - `listOnline(orgId): Promise<string[]>`(先 ZREMRANGEBYSCORE 清过期再 ZRANGE)
  - `isOnline(orgId, deviceId): Promise<boolean>`
- Consumes: `REDIS_CLIENT`(`@Optional`,不可用退化进程内 Map,同 PresenceService)。

- [ ] **Step 1: 写失败测试**

`device-presence.service.spec.ts`(用进程内退化路径,不需真 Redis:构造时不注入 REDIS_CLIENT):

```ts
import { DevicePresenceService } from "./device-presence.service";

describe("DevicePresenceService(内存退化)", () => {
  it("setOnline → listOnline 含该设备;setOffline 后移除", async () => {
    const svc = new DevicePresenceService(null);
    await svc.setOnline("o1", "d1");
    await svc.setOnline("o1", "d2");
    expect((await svc.listOnline("o1")).sort()).toEqual(["d1", "d2"]);
    expect(await svc.isOnline("o1", "d1")).toBe(true);
    await svc.setOffline("o1", "d1");
    expect(await svc.listOnline("o1")).toEqual(["d2"]);
    expect(await svc.isOnline("o1", "d1")).toBe(false);
  });

  it("过期设备不再在线(注入可控 now)", async () => {
    let now = 1_000_000;
    const svc = new DevicePresenceService(null, () => now);
    await svc.setOnline("o1", "d1");
    now += 46_000;
    expect(await svc.listOnline("o1")).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败** → FAIL(模块不存在)。

- [ ] **Step 3: 实现**

`device-presence.service.ts`——照抄 `libs/main/src/services/presence.service.ts` 结构,键改为 `presence:device:<orgId>`,member 为 deviceId,加 `isOnline`:

```ts
import { Inject, Injectable, Optional } from "@nestjs/common";
import { REDIS_CLIENT } from "../tokens";
import type { RedisPresenceClient } from "./presence.service";

const PRESENCE_TTL_SECONDS = 45;

/** 设备级在线态(Agent relay 连接生命周期驱动);Redis 不可用退化进程内 Map */
@Injectable()
export class DevicePresenceService {
  private readonly memory = new Map<string, Map<string, number>>();

  constructor(
    @Optional() @Inject(REDIS_CLIENT) private readonly redis: RedisPresenceClient | null,
    @Optional() private readonly nowFn?: () => number,
  ) {}

  private now(): number {
    return this.nowFn ? this.nowFn() : Date.now();
  }
  private key(orgId: string): string {
    return `presence:device:${orgId}`;
  }

  /** 标记设备 Agent 在线(续期) */
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

  /** 心跳续期 */
  async heartbeat(orgId: string, deviceId: string): Promise<void> {
    return this.setOnline(orgId, deviceId);
  }

  /** 标记离线 */
  async setOffline(orgId: string, deviceId: string): Promise<void> {
    if (this.redis) {
      await this.redis.zrem(this.key(orgId), deviceId);
      return;
    }
    this.memory.get(orgId)?.delete(deviceId);
  }

  /** 在线设备列表(清过期) */
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

  /** 单设备是否在线 */
  async isOnline(orgId: string, deviceId: string): Promise<boolean> {
    return (await this.listOnline(orgId)).includes(deviceId);
  }
}
```

(`RedisPresenceClient` 接口从 `presence.service.ts` 导出复用;若未导出,本 task 顺手 `export` 它。)

`main.module.ts` providers/exports 加 `DevicePresenceService`;`index.ts` 导出。

- [ ] **Step 4: 跑测试通过 + 提交**

Run: `pnpm exec jest libs/main/src/services/device-presence.service.spec.ts` → PASS;`pnpm check`。

```bash
git add libs/main/src
git commit -m "feat(server-main): DevicePresenceService 设备级在线态"
```

---

### Task 4: 共享 schema——agent.inbound 事件 + Agent-DM DTO

**Files:**
- Modify: `libs/types/src/im/im.events.ts`(IM_WS_EVENTS 加 `agentInbound`;新 payload 接口)
- Modify: `libs/types/src/im/im.schema.ts`(`ImMessage` 加 `senderType`;`ConversationSummary` 加 `agentDeviceId`;`CreateAgentDmSchema`)
- Modify: `libs/types/src/index.ts`(具名导出)
- Test: `libs/types` 无独立测试(纯类型/常量);由消费方 typecheck 保证

**Interfaces:**
- Produces:
  - `IM_WS_EVENTS.agentInbound = "im.agent_inbound"`(下行:server-main → device 连接)
  - `interface ImAgentInboundEvent { conversationId: string; messageId: string; content: string; senderUserId: string }`
  - `ImMessageSchema` 加 `senderType: z.enum(["user","agent"]).default("user")` → `ImMessage.senderType`
  - `ConversationSummary` 加 `agentDeviceId: string | null`(agent-dm 会话非空)
  - `CreateAgentDmSchema = z.object({ deviceId: z.string().min(1) })` → `CreateAgentDmInput`
- Consumes: 无。

- [ ] **Step 1: 实现(纯类型,无 TDD)**

`im.events.ts` 的 `IM_WS_EVENTS` 在下行段加 `agentInbound: "im.agent_inbound"`;文件追加:

```ts
export interface ImAgentInboundEvent {
  conversationId: string;
  messageId: string;
  content: string;
  senderUserId: string;
}
```

`im.schema.ts`:`ImMessageSchema` 加 `senderType: z.enum(["user", "agent"]).default("user")`;`ConversationSummary` 接口加 `agentDeviceId: string | null`;追加:

```ts
export const CreateAgentDmSchema = z.object({ deviceId: z.string().min(1, { message: "validation.required" }) });
export type CreateAgentDmInput = z.infer<typeof CreateAgentDmSchema>;
```

`libs/types/src/index.ts` 具名导出 `ImAgentInboundEvent` / `CreateAgentDmSchema` / `CreateAgentDmInput`(`ImMessage`/`ConversationSummary`/`IM_WS_EVENTS` 已导出)。

- [ ] **Step 2: typecheck + 提交**

Run: `pnpm typecheck`(下游消费方在后续 task 才用,本 task 至少 libs/types 与既有消费方不断);`pnpm check`(check:dead:新 export 在 Task 5/6/9 消费——**本 task 与 Task 5 可合并提交以过 check:dead**,或本 task 先加、Task 5 紧接。实施时若 check:dead 卡,把 Task 4 与 Task 5 连续做、一起提交)。

```bash
git add libs/types/src
git commit -m "feat(types): agent.inbound 事件 + Agent-DM schema(senderType/agentDeviceId)"
```

---

### Task 5: ImGateway——device room + agent presence + agent.inbound 下发 + 回流盖 agent 身份

**Files:**
- Modify: `apps/server-main/src/ws/im.gateway.ts`
- Test: `apps/server-main/test/e2e/agent-dm-flow.e2e.spec.ts`(部分,Task 7 补全;本 task 先测 gateway 单元行为可用 `apps/server-main/test/im-gateway-agent.spec.ts` 轻量装配)

**Interfaces:**
- Consumes: `DevicePresenceService`(Task 3)、`ConversationService.getAgentDmOrThrow`(Task 2)、`MessageService.persistMessage(...,'agent')`(Task 2)、`IM_WS_EVENTS.agentInbound` / `ImAgentInboundEvent`(Task 4)。
- Produces: 三处 gateway 行为(见下)。

- [ ] **Step 1: 实现(gateway 接线,行为经 Task 7 e2e 验证;本 task 写一个轻量断言测试)**

`im.gateway.ts` 构造注入加 `DevicePresenceService devicePresence`。三处改动:

**(a) device 连接握手:join device room + 上线**——`onAuthedConnect` 里,在 `client.join('org:'+orgId)` 之后:

```ts
const deviceId = (client.data.user as { deviceId?: string }).deviceId;
if (deviceId) {
  client.join(`device:${deviceId}`);
  await this.devicePresence.setOnline(orgId, deviceId);
  this.server.to(`org:${orgId}`).emit(IM_WS_EVENTS.presence, { userId: `agent:${deviceId}`, online: true });
}
```

**(b) handleDisconnect:device 下线**——在现有 user setOffline 逻辑旁,若 `client.data.user.deviceId` 存在:

```ts
const deviceId = (client.data.user as { deviceId?: string })?.deviceId;
if (deviceId && orgId) {
  await this.devicePresence.setOffline(orgId, deviceId);
  this.server.to(`org:${orgId}`).emit(IM_WS_EVENTS.presence, { userId: `agent:${deviceId}`, online: false });
}
```

**(c) handleSend:发给 Agent-DM 的消息→定向下发;device 连接发的消息→盖 agent 身份**——改写 `handleSend`:

```ts
async handleSend(@MessageBody() body: ImSendInput, @ConnectedSocket() client): Promise<void> {
  const payload = client.data.user as { userId: string; deviceId?: string };
  const orgId = client.data.orgId;
  if (!orgId) throw new AppError(MainErrorCode.CONVERSATION_FORBIDDEN);
  const isAgentSender = !!payload.deviceId;
  if (isAgentSender) {
    // device token 连接回流:盖 agent 身份,senderId = deviceId,免可见性校验(设备只对自己的 Agent-DM 发)
    const msg = await this.message.persistMessage(body.conversationId, payload.deviceId!, body.content, "agent");
    this.server.to(`conv:${body.conversationId}`).emit(IM_WS_EVENTS.message, msg);
    return;
  }
  await this.conversation.getVisibleOrThrow(body.conversationId, payload.userId, orgId);
  const msg = await this.message.persistMessage(body.conversationId, payload.userId, body.content, "user");
  this.server.to(`conv:${body.conversationId}`).emit(IM_WS_EVENTS.message, msg);
  // 若目标是 Agent-DM,定向下发到设备
  const conv = await this.conversation.findAgentDevice(body.conversationId);
  if (conv?.agentDeviceId) {
    const event: ImAgentInboundEvent = {
      conversationId: body.conversationId, messageId: msg.id, content: body.content, senderUserId: payload.userId,
    };
    this.server.to(`device:${conv.agentDeviceId}`).emit(IM_WS_EVENTS.agentInbound, event);
  }
}
```

(`ConversationService.findAgentDevice(conversationId): Promise<{agentDeviceId: string|null} | null>` 轻量查询,Task 2 顺手加,或复用 `getAgentDmOrThrow` 的 try/catch——推荐加一个不抛的 `findAgentDevice`。device 连接握手时也要 `client.join('conv:...')` 它的 Agent-DM 会话,使回流广播能被 web-main 端收到:`onAuthedConnect` 对 device 连接同样跑 `listConversations`?——device 的 orgId 下 `listConversations(userId,...)` 用的是 device.userId,能列到该用户的 Agent-DM 会话,已 join `conv:`。确认 device 连接的 `client.data.user.userId` = 设备归属用户,`listConversations` 会带出 Agent-DM 会话。)

- [ ] **Step 2: 轻量断言测试**

`apps/server-main/test/im-gateway-agent.spec.ts`:手工 new `ImGateway`(mock conversation/message/devicePresence/server),调 `handleSend`:
1. device 连接(`client.data.user.deviceId` 存在)发消息 → `persistMessage` 收到 `'agent'` + senderId=deviceId;不调 getVisibleOrThrow。
2. user 连接发到 Agent-DM 会话(`findAgentDevice` 返回 agentDeviceId)→ `server.to('device:'+id).emit(agentInbound,...)` 被调,payload 字段正确。
3. user 连接发到普通会话(findAgentDevice 返回 null)→ 不 emit agentInbound。

- [ ] **Step 3: 跑测试通过 + 提交**

Run: `pnpm exec jest apps/server-main/test/im-gateway-agent.spec.ts` → PASS;`pnpm check`。

```bash
git add apps/server-main/src/ws libs/main/src apps/server-main/test
git commit -m "feat(server-main): ImGateway device room + agent presence + agent.inbound 定向下发 + 回流盖 agent 身份"
```

---

### Task 6: Agent-DM REST(建会话 / 列本设备会话 / 设备在线态)

**Files:**
- Modify: `apps/server-main/src/rest/im.controller.ts`(建 Agent-DM 端点)
- Create: `apps/server-main/src/rest/agent-device.controller.ts`(列本设备 Agent-DM 会话——device token 认证)
- Modify: `libs/main/src/dto/index.ts`(CreateAgentDmDto)
- Modify: `apps/server-main/src/app.module.ts`(注册新 controller)
- Test: `apps/server-main/test/agent-device-controller.routes.spec.ts`

**Interfaces:**
- Produces(REST,全部经 envelope):
  - `POST /api/agent-dms`(浏览器 JWT),body `CreateAgentDmDto{deviceId}` → `ConversationSummary`(编排 `ConversationService.findOrCreateAgentDm(u.orgId, u.userId, deviceId)`)
  - `GET /api/agent/conversations`(**device token**,Guard 已支持双凭据,`@CurrentUser().deviceId` 存在)→ `{ conversationId, orgId }[]`(编排 `listAgentDmsForDevice(u.deviceId)`;无 deviceId 抛 FORBIDDEN)
  - `GET /api/devices/:id/online`(浏览器 JWT)→ `{ online: boolean }`(`DevicePresenceService.isOnline(u.orgId, id)`)——web-main 侧栏在线点用(也可用 presence 事件,REST 作首屏)
- Consumes: Task 2/3 Service。

- [ ] **Step 1: 写失败路由测试**

`agent-device-controller.routes.spec.ts`(仿 `device-auth-controller.routes.spec.ts`,mock service):三端点各一条 happy-path + `GET /api/agent/conversations` 无 deviceId → 403。

- [ ] **Step 2: 跑测试确认失败** → FAIL。

- [ ] **Step 3: 实现**

`im.controller.ts` 加:

```ts
@Post("agent-dms")
createAgentDm(@CurrentUser() u: JwtMainPayload, @Body() dto: CreateAgentDmDto) {
  if (!u.orgId) throw new AppError(MainErrorCode.ORG_NOT_FOUND);
  return this.conversation.findOrCreateAgentDm(u.orgId, u.userId, dto.deviceId);
}

@Get("devices/:id/online")
async deviceOnline(@CurrentUser() u: JwtMainPayload, @Param("id") id: string) {
  if (!u.orgId) throw new AppError(MainErrorCode.ORG_NOT_FOUND);
  return { online: await this.devicePresence.isOnline(u.orgId, id) };
}
```

新建 `agent-device.controller.ts`(`@Controller("agent")`):

```ts
@Controller("agent")
export class AgentDeviceController {
  constructor(private readonly conversation: ConversationService) {}

  @Get("conversations")
  listConversations(@CurrentUser() u: JwtMainPayload) {
    if (!u.deviceId) throw new AppError(CommonErrorCode.FORBIDDEN);
    return this.conversation.listAgentDmsForDevice(u.deviceId);
  }
}
```

DTO:`CreateAgentDmDto` class+interface 合并(`CreateAgentDmSchema`);`app.module.ts` controllers 加 `AgentDeviceController`;`im.controller.ts` 构造注入 `DevicePresenceService`。

- [ ] **Step 4: 跑测试通过 + 提交**

Run: `pnpm exec jest apps/server-main/test/agent-device-controller.routes.spec.ts` → PASS;`pnpm check`。

```bash
git add apps/server-main/src libs/main/src/dto apps/server-main/test
git commit -m "feat(server-main): Agent-DM REST(建会话/列本设备会话/设备在线态)"
```

---

### Task 7: server-main e2e(反向通道全链路)

**Files:**
- Create: `apps/server-main/test/e2e/agent-dm-flow.e2e.spec.ts`

**Interfaces:**
- Consumes: Task 1-6 全部;装配复制 `device-auth-flow.e2e.spec.ts` 模式 + socket.io-client 连 `ws/im`(参考 `im-flow.spec.ts` 的 WS e2e 装配)。

- [ ] **Step 1: 写 e2e**

场景(注册验证用 `test/setup/register-and-verify.ts`):
1. 注册用户 → 建组织 → 走设备授权拿一个 deviceToken(复用 device-auth-flow 的 start/approve/exchange helper)。
2. `POST /api/agent-dms {deviceId}` → 拿 Agent-DM 会话 id,`agentDeviceId` 正确。
3. 用 deviceToken 连 `ws/im`(模拟设备 Agent),断言收到 `agent.inbound` ——当浏览器 JWT 连接 `POST`/`emit(send)` 一条消息到该会话时:device socket 收到 `im.agent_inbound` 事件,payload `{conversationId, messageId, content}` 正确。
4. device socket `emit(send, {conversationId, content:"结果"})` → 浏览器连接收到 `im.message`,断言 `senderType='agent' senderId=deviceId`。
5. `GET /api/agent/conversations`(deviceToken)→ 含该会话。
6. `GET /api/devices/:id/online`(JWT)→ device socket 连着时 true,断开后 false(需等 presence 传播/直接查)。
7. 负面:非本人的 deviceId 建 Agent-DM → 400 AGENT_DEVICE_INVALID。

- [ ] **Step 2: 跑通过 + 提交**

Run: `pnpm exec jest apps/server-main/test/e2e/agent-dm-flow.e2e.spec.ts --runInBand` → PASS;`pnpm exec jest apps/server-main libs/main --runInBand`(全量不回归);`pnpm check`。

```bash
git add apps/server-main/test
git commit -m "test(server-main): Agent-DM 反向通道 e2e 全链路"
```

---

## Phase 2:本地后端(server-agent)

### Task 8: SQLite 迁移 + ImAgentSession Entity + Service

**Files:**
- Create: `apps/server-agent/src/migrations/1780900000000-ImAgentSession.ts`
- Create: `apps/server-agent/src/entities/im-agent-session.entity.ts`
- Create: `apps/server-agent/src/services/im-agent-session.service.ts`
- Modify: `apps/server-agent/src/app.module.ts`(entities 数组加 ImAgentSession)
- Test: `apps/server-agent/src/migrations/__tests__/im-agent-session-migration.spec.ts`、`apps/server-agent/src/services/im-agent-session.service.spec.ts`

**Interfaces:**
- Produces:
  - Entity `ImAgentSession`(表 `im_agent_session`):`conversationId`(text)、`sessionId`(text)、`cloudUserId`(text,作用域)、`lastProcessedMessageId`(text nullable)、`createdAt`。
  - `ImAgentSessionService.findByConversation(conversationId): Promise<ImAgentSession | null>`
  - `ImAgentSessionService.create(conversationId, sessionId): Promise<ImAgentSession>`(盖当前账号)
  - `ImAgentSessionService.advanceCursor(conversationId, messageId): Promise<void>`
  - `ImAgentSessionService.getCursor(conversationId): Promise<string | null>`

- [ ] **Step 1: 写失败迁移测试**

`im-agent-session-migration.spec.ts`(仿 `device-token-migration.spec.ts`:内存 better-sqlite3 跑全部迁移 + `PRAGMA table_info`):断言 `im_agent_session` 表存在,列含 `conversation_id`/`session_id`/`cloud_user_id`/`last_processed_message_id`。

- [ ] **Step 2: 跑测试确认失败** → FAIL。

- [ ] **Step 3: 实现迁移 + Entity + Service**

`1780900000000-ImAgentSession.ts`:

```ts
import type { MigrationInterface, QueryRunner } from "typeorm";

export class ImAgentSession1780900000000 implements MigrationInterface {
  name = "ImAgentSession1780900000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "im_agent_session" (
        "id" varchar(20) PRIMARY KEY NOT NULL,
        "conversation_id" TEXT NOT NULL,
        "session_id" TEXT NOT NULL,
        "cloud_user_id" TEXT NOT NULL,
        "last_processed_message_id" TEXT,
        "created_at" datetime NOT NULL DEFAULT (datetime('now'))
      )`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_im_agent_session_conv" ON "im_agent_session" ("conversation_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_im_agent_session_cloud_user" ON "im_agent_session" ("cloud_user_id")`,
    );
  }

  public async down(): Promise<void> {
    // SQLite 无 DROP COLUMN / 保留表
  }
}
```

`im-agent-session.entity.ts`(继承 `SnowflakeBaseEntity`,`@Entity("im_agent_session")`):列 `conversationId`(text)、`sessionId`(text)、`cloudUserId`(name `cloud_user_id`,text)、`lastProcessedMessageId`(name `last_processed_message_id`,text nullable)、`@CreateDateColumn createdAt`。

`im-agent-session.service.ts`(ScopedRepository):

```ts
@Injectable()
export class ImAgentSessionService {
  private readonly repo: ScopedRepository<ImAgentSession>;

  constructor(
    @InjectRepository(ImAgentSession) private readonly rawRepo: Repository<ImAgentSession>,
    scopedFactory: ScopedRepositoryFactory,
  ) {
    this.repo = scopedFactory.create(rawRepo);
  }

  /** 查会话映射(当前账号) */
  findByConversation(conversationId: string): Promise<ImAgentSession | null> {
    return this.repo.findOne({ where: { conversationId } });
  }

  /** 建映射(盖当前账号) */
  async create(conversationId: string, sessionId: string): Promise<ImAgentSession> {
    return this.repo.save(this.repo.create({ conversationId, sessionId })) as Promise<ImAgentSession>;
  }

  /** 推进处理游标 */
  async advanceCursor(conversationId: string, messageId: string): Promise<void> {
    await this.repo.update({ conversationId }, { lastProcessedMessageId: messageId });
  }

  /** 取处理游标 */
  async getCursor(conversationId: string): Promise<string | null> {
    const row = await this.repo.findOne({ where: { conversationId } });
    return row?.lastProcessedMessageId ?? null;
  }
}
```

`app.module.ts` 的 `entities` 显式数组加 `ImAgentSession`;`ImAgentSession` 经 `TxTypeOrmModule.forFeature([...])` 在 Task 10 的模块注册(本 task Service 也可先挂到一个新模块,与 Task 10 合并——实施时 Service 与 AgentInboxService 同模块)。

- [ ] **Step 4: 写 Service 单测 + 跑通过 + 提交**

`im-agent-session.service.spec.ts`:内存桩 ScopedRepository(或真 better-sqlite3 + AccountContext),测 create/findByConversation/advanceCursor/getCursor + 账号作用域(不同账号互不可见)。

Run: `pnpm exec jest apps/server-agent/src/migrations apps/server-agent/src/services/im-agent-session.service.spec.ts` → PASS;`pnpm check`(check:scope 盯 cloud_user_id 表经 ScopedRepository)。

```bash
git add apps/server-agent/src/migrations apps/server-agent/src/entities apps/server-agent/src/services apps/server-agent/src/app.module.ts
git commit -m "feat(server-agent): im_agent_session 表 + Entity + Service(会话映射与处理游标)"
```

---

### Task 9: im-relay-client——agent.inbound 下行 + connected 事件

**Files:**
- Modify: `apps/server-agent/src/cloud/im-relay-client.service.ts`
- Create: `apps/server-agent/src/cloud/im-relay.events.ts`(IM_RELAY_EVENTS 常量)
- Test: 扩展 `apps/server-agent/src/cloud/im-relay-client.service.spec.ts`

**Interfaces:**
- Produces:
  - 下行:`agent.inbound`(`IM_WS_EVENTS.agentInbound`)加入 relay 监听数组 → `account.run(cloudUserId, () => emitter.emit(IM_WS_EVENTS.agentInbound, payload))`
  - `IM_RELAY_EVENTS = { connected: "im.relay.connected" }`;`socket.on("connect")` 重连成功时 `account.run(cloudUserId, () => emitter.emit(IM_RELAY_EVENTS.connected, { cloudUserId }))`
- Consumes: `IM_WS_EVENTS.agentInbound`(Task 4)。

- [ ] **Step 1: 更新测试(失败先行)**

`im-relay-client.service.spec.ts` 补:
1. 服务端 emit `im.agent_inbound` → 本地 `emitter.emit` 收到该事件,且在 `account.run` 上下文内(断言 `ctx.get()===cloudUserId`)。
2. FakeSocket 触发 `connect`(重连)→ `emitter.emit(IM_RELAY_EVENTS.connected, {cloudUserId})` 被发。

- [ ] **Step 2: 跑测试确认失败** → FAIL。

- [ ] **Step 3: 实现**

`im-relay.events.ts`:

```ts
/** im-relay 本地事件(server-agent 进程内 EventEmitter2) */
export const IM_RELAY_EVENTS = { connected: "im.relay.connected" } as const;
export interface ImRelayConnectedEvent { cloudUserId: string }
```

`im-relay-client.service.ts`:把 `IM_WS_EVENTS.agentInbound` 加进下行监听数组(第 4 点探索里那个 `for (const event of [...])`);`socket.on("connect", ...)` 里(现有重连回放 presence 之处)追加 `this.account.run(cloudUserId, () => this.emitter.emit(IM_RELAY_EVENTS.connected, { cloudUserId }))`。

- [ ] **Step 4: 跑测试通过 + 提交**

Run: `pnpm exec jest apps/server-agent/src/cloud/im-relay-client.service.spec.ts` → PASS;`pnpm check`。

```bash
git add apps/server-agent/src/cloud
git commit -m "feat(server-agent): relay 下行 agent.inbound + 重连 connected 事件"
```

---

### Task 10: AgentInboxService——inbound → 会话 → kickAndWait → 回流

**Files:**
- Create: `apps/server-agent/src/services/agent-inbox.service.ts`
- Create: `apps/server-agent/src/agent-inbox.module.ts`(@Global,imports SessionModule + AuthModule)
- Modify: `apps/server-agent/src/app.module.ts`(imports 加 AgentInboxModule)
- Modify: `apps/server-agent/src/errors/agent.error-codes.ts`(3016 AGENT_INBOX_RUN_FAILED——可选,失败走回错误消息不一定要错误码)
- Test: `apps/server-agent/src/services/agent-inbox.service.spec.ts`

**Interfaces:**
- Consumes: `ImAgentSessionService`(Task 8)、`SessionService.createSession/appendMessage`、`RunnerService.kickAndWait`、`SessionMessageService.findLastAssistant`、`ImRelayClientService.send`、`ConversationService`(云端,不可达——server-agent 无 ConversationService;建会话映射时本地 `createSession`)、`IM_WS_EVENTS.agentInbound`(Task 4/9)。
- Produces:
  - `AgentInboxService.handleInbound(payload: ImAgentInboundEvent): Promise<void>`(`@OnEvent(IM_WS_EVENTS.agentInbound)`,已在 relay 的 `account.run` 上下文内)
  - 内部:找/建 `im_agent_session`(会话首次→`sessions.createSession({content: payload.content, kind:'im-agent'})` 建本地会话,存映射;非首次→`sessions.appendMessage(sessionId, {content})`)→ `runner.kickAndWait(sessionId)` → `messages.findLastAssistant(sessionId)` → `relay.send(cloudUserId, {conversationId, content: reply})` → `imAgentSession.advanceCursor(conversationId, payload.messageId)`。失败:`relay.send` 回一条错误文案 + 照常推进游标。
  - **每会话 in-flight 锁**(`Map<conversationId, Promise>` 串行化,仿 dispatch 的信号量思路但按会话)。

- [ ] **Step 1: 写失败测试**

`agent-inbox.service.spec.ts`(mock imAgentSession/sessions/runner/messages/relay + 真 AccountContextService,包 `account.run`):
1. 首次 inbound(findByConversation 返回 null)→ `sessions.createSession` 建会话 + `imAgentSession.create(convId, newSessionId)` + `kickAndWait` + `findLastAssistant` → `relay.send({conversationId, content: 回复})` + `advanceCursor(convId, messageId)`。
2. 二次 inbound(已有映射)→ `appendMessage(sessionId, {content})`(不再 createSession)+ 同上。
3. run 失败(kickAndWait 抛)→ `relay.send` 收到错误文案 + `advanceCursor` 仍被调。
4. 同 conversationId 并发两条 inbound → 串行(第二条在第一条完成后才处理;断言 kickAndWait 调用不交错——用可控 deferred)。

- [ ] **Step 2: 跑测试确认失败** → FAIL。

- [ ] **Step 3: 实现**

`agent-inbox.service.ts`:

```ts
import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { IM_WS_EVENTS, type ImAgentInboundEvent } from "@meshbot/types";
import { AccountContextService } from "@meshbot/agent"; // 按实际导出路径
import { ImRelayClientService } from "../cloud/im-relay-client.service";
import { RunnerService } from "./runner.service";
import { SessionService } from "./session.service";
import { SessionMessageService } from "./session-message.service";
import { ImAgentSessionService } from "./im-agent-session.service";

const AGENT_DM_SESSION_KIND = "im-agent";

/** 云端→设备 Agent 的入站消息处理:找/建本地会话 → 触发 run → 回流。仿 DispatchSubagentService。 */
@Injectable()
export class AgentInboxService {
  private readonly logger = new Logger(AgentInboxService.name);
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(
    private readonly imAgentSession: ImAgentSessionService,
    private readonly sessions: SessionService,
    private readonly runner: RunnerService,
    private readonly messages: SessionMessageService,
    private readonly relay: ImRelayClientService,
    private readonly account: AccountContextService,
  ) {}

  /** relay 下行 agent.inbound(已在 account.run 上下文内) */
  @OnEvent(IM_WS_EVENTS.agentInbound)
  async handleInbound(payload: ImAgentInboundEvent): Promise<void> {
    const cloudUserId = this.account.getOrThrow();
    await this.serialize(payload.conversationId, () => this.process(cloudUserId, payload));
  }

  private async serialize(key: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.inflight.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    this.inflight.set(key, next);
    try {
      await next;
    } finally {
      if (this.inflight.get(key) === next) this.inflight.delete(key);
    }
  }

  private async process(cloudUserId: string, payload: ImAgentInboundEvent): Promise<void> {
    try {
      const sessionId = await this.resolveSession(payload.conversationId, payload.content);
      await this.runner.kickAndWait(sessionId);
      const last = await this.messages.findLastAssistant(sessionId);
      const reply = last?.content ?? "(Agent 未产生回复)";
      this.relay.send(cloudUserId, { conversationId: payload.conversationId, content: reply });
    } catch (err) {
      this.logger.warn(`Agent 入站处理失败 conv=${payload.conversationId}: ${String(err)}`);
      try {
        this.relay.send(cloudUserId, { conversationId: payload.conversationId, content: `Agent 处理失败:${String(err)}` });
      } catch { /* relay 未连,重连补处理会再来 */ }
    } finally {
      await this.imAgentSession.advanceCursor(payload.conversationId, payload.messageId).catch(() => undefined);
    }
  }

  /** 找/建会话映射:首次建本地会话,非首次 append 到既有会话 */
  private async resolveSession(conversationId: string, content: string): Promise<string> {
    const existing = await this.imAgentSession.findByConversation(conversationId);
    if (existing) {
      await this.sessions.appendMessage(existing.sessionId, { content });
      return existing.sessionId;
    }
    const { sessionId } = await this.sessions.createSession({ content, kind: AGENT_DM_SESSION_KIND });
    await this.imAgentSession.create(conversationId, sessionId);
    return sessionId;
  }
}
```

(`sessions.createSession` 的 `kind` 参数需确认接受任意字符串;`appendMessage` 的入参 `{messageId?, content}`——messageId 可省或用 `clientSnowflakeId`,按现有签名补。`AccountContextService` 导出路径以实际为准。)

`agent-inbox.module.ts`(`@Global`,`imports:[SessionModule, AuthModule]`,SessionModule 供 Session/Runner/SessionMessage,AuthModule 供 ImRelayClientService/CloudIdentity;`TxTypeOrmModule.forFeature([ImAgentSession])` 注册 Entity + `ImAgentSessionService` + `AgentInboxService`);`app.module.ts` imports 加 `AgentInboxModule`。

- [ ] **Step 4: 跑测试通过 + boot 验证 + 提交**

Run: `pnpm exec jest apps/server-agent/src/services/agent-inbox.service.spec.ts` → PASS;`pnpm exec jest apps/server-agent` 全量;**真启 `pnpm dev:server-agent` 确认 DI 装配无 UnknownDependenciesException**(新模块 + 跨模块依赖);`pnpm check`。

```bash
git add apps/server-agent/src
git commit -m "feat(server-agent): AgentInboxService 入站消息→触发 run→回流(每会话串行)"
```

---

### Task 11: AgentInboxService 重连补处理(游标 + 枚举)

**Files:**
- Modify: `apps/server-agent/src/services/agent-inbox.service.ts`(加补处理)
- Modify: `apps/server-agent/src/services/cloud-im.service.ts`(若无"列本设备 Agent-DM 会话"代理,加 `listAgentConversations()` 打 `GET /api/agent/conversations`)
- Test: 扩展 `agent-inbox.service.spec.ts`

**Interfaces:**
- Consumes: `CloudImService.listAgentConversations(): Promise<{conversationId, orgId}[]>`(代理 `GET /api/agent/conversations`,deviceToken)、`CloudImService.getMessages(convId, before?, limit?)`(现有,拉消息分页)、`IM_RELAY_EVENTS.connected`(Task 9)、`ACCOUNT_EVENTS.runtimeCreated`。
- Produces:
  - `@OnEvent(IM_RELAY_EVENTS.connected)` 与 `@OnEvent(ACCOUNT_EVENTS.runtimeCreated)` → `catchUp(cloudUserId)`
  - `catchUp`:`listAgentConversations()` 枚举本设备全部 Agent-DM 会话 → 每个会话取本地游标 `getCursor` → `getMessages` 拉游标之后的 user 消息(`senderType==='user'`)→ 逐条经 `serialize`+`process` 处理(process 内已推进游标)。

- [ ] **Step 1: 写失败测试**

补 `agent-inbox.service.spec.ts`:
1. `catchUp`:listAgentConversations 返回 2 个会话;会话 A 游标之后有 2 条 user 消息 → 各触发一次 process(kickAndWait 2 次)+ 游标推进到最后一条;会话 B 无新消息 → 不处理。
2. catchUp 与实时 inbound 对同一会话不双处理(游标去重 + serialize 锁)。

- [ ] **Step 2: 跑测试确认失败** → FAIL。

- [ ] **Step 3: 实现**

`cloud-im.service.ts` 加(若无):

```ts
/** 列本设备的全部 Agent-DM 会话(deviceToken) */
listAgentConversations(): Promise<{ conversationId: string; orgId: string }[]> {
  return this.withToken((token) => this.cloud.get("/api/agent/conversations", token));
}
```

`agent-inbox.service.ts` 加:

```ts
@OnEvent(ACCOUNT_EVENTS.runtimeCreated)
onRuntimeCreated(payload: { cloudUserId: string }): void {
  void this.account.run(payload.cloudUserId, () => this.catchUp(payload.cloudUserId));
}

@OnEvent(IM_RELAY_EVENTS.connected)
onRelayConnected(payload: { cloudUserId: string }): void {
  void this.account.run(payload.cloudUserId, () => this.catchUp(payload.cloudUserId));
}

/** 重连/启动补处理:枚举本设备 Agent-DM 会话,处理各自游标之后的 user 消息 */
private async catchUp(cloudUserId: string): Promise<void> {
  let convs: { conversationId: string; orgId: string }[];
  try {
    convs = await this.cloudIm.listAgentConversations();
  } catch (err) {
    this.logger.warn(`补处理枚举会话失败: ${String(err)}`);
    return;
  }
  for (const { conversationId } of convs) {
    await this.catchUpConversation(cloudUserId, conversationId).catch((err) =>
      this.logger.warn(`补处理会话 ${conversationId} 失败: ${String(err)}`),
    );
  }
}

private async catchUpConversation(cloudUserId: string, conversationId: string): Promise<void> {
  const cursor = await this.imAgentSession.getCursor(conversationId);
  const page = await this.cloudIm.getMessages(conversationId, undefined, "50");
  const fresh = page.messages
    .filter((m) => m.senderType === "user" && (!cursor || m.id > cursor))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const m of fresh) {
    await this.serialize(conversationId, () =>
      this.process(cloudUserId, { conversationId, messageId: m.id, content: m.content, senderUserId: m.senderId }),
    );
  }
}
```

(`cloudIm` = 注入 `CloudImService`;`getMessages` 返回 `MessagePage`,`m.id` 雪花可字典序比较作游标。若某会话消息 >50 条未处理需翻页——MVP 拉最近 50,超出的老消息忽略并日志,记为已知限制。)

构造注入加 `CloudImService cloudIm`;module imports 确保 `ImModule`(供 CloudImService)可见。

- [ ] **Step 4: 跑测试通过 + 提交**

Run: `pnpm exec jest apps/server-agent/src/services/agent-inbox.service.spec.ts` → PASS;`pnpm exec jest apps/server-agent`;`pnpm check`。

```bash
git add apps/server-agent/src
git commit -m "feat(server-agent): AgentInbox 重连补处理(枚举会话+游标拉未读)"
```

---

## Phase 3:web-main IM 前端

> 验证方式:`pnpm --filter @meshbot/web-main typecheck` + `npx biome check apps/web-main` + `pnpm sync:locales -- --check` + dev 联调冒烟(server-main 本地 Postgres + web-main + curl 模拟设备 relay)。无前端测试基建,不强行新增。所有可见字符串走 next-intl。参考实现:web-agent 的 IM(`components/im/*`、`components/shell/messages-sidebar.tsx`),但 **web-main 直连 server-main `/ws/im`(浏览器 JWT),订阅直接的 `IM_WS_EVENTS.*` 事件(非信封)**。

### Task 12: web-main 依赖 + ws/im 客户端 + IM rest hooks

**Files:**
- Modify: `apps/web-main/package.json`(加 `socket.io-client`、`lucide-react`)
- Create: `apps/web-main/src/lib/im-socket.ts`(连 server-main /ws/im)
- Create: `apps/web-main/src/rest/im.ts`(会话/消息/Agent-DM hooks)
- Create: `apps/web-main/src/rest/agent-devices.ts`(设备在线态 hook,复用 useDevices)

**Interfaces:**
- Produces:
  - `getImSocket(): Socket`——`io(`${NEXT_PUBLIC_SERVER_MAIN_URL}/ws/im`, { transports:["websocket"], auth:{ token: getMainToken() ?? "" }, autoConnect:true })`;`disconnectImSocket()`
  - `useConversations(): UseQueryResult<ConversationSummary[]>`(`GET /api/conversations`)
  - `fetchMessages(conversationId, before?): Promise<MessagePage>`(`GET /api/conversations/:id/messages`)
  - `useCreateAgentDm()`(`POST /api/agent-dms {deviceId}` → ConversationSummary)
  - `useDeviceOnline(deviceId): UseQueryResult<{online:boolean}>`(`GET /api/devices/:id/online`)
- Consumes: Task 4 类型(ConversationSummary/ImMessage/MessagePage/CreateAgentDmInput)、`mainApi`/`getMainToken`(A 基建)。

- [ ] **Step 1: 加依赖**

`apps/web-main/package.json` dependencies 加 `"socket.io-client": "^4.8.3"`、`"lucide-react": "^0.xxx"`(版本对齐 web-agent 现值,grep `apps/web-agent/package.json` 取)。`pnpm install`。

- [ ] **Step 2: 实现 im-socket + rest**

`im-socket.ts`:

```ts
import { io, type Socket } from "socket.io-client";
import { IM_WS_NAMESPACE } from "@meshbot/types";
import { getMainToken } from "./auth-storage";

let socket: Socket | null = null;

/** 连 server-main /ws/im(浏览器 JWT) */
export function getImSocket(): Socket {
  if (socket) return socket;
  const base = process.env.NEXT_PUBLIC_SERVER_MAIN_URL ?? "";
  socket = io(`${base}/${IM_WS_NAMESPACE}`, {
    transports: ["websocket"],
    auth: { token: getMainToken() ?? "" },
    autoConnect: true,
  });
  return socket;
}

export function disconnectImSocket(): void {
  socket?.disconnect();
  socket = null;
}
```

`rest/im.ts`、`rest/agent-devices.ts`:按 Interfaces 用 `mainApi` + react-query 实现(模板照 `rest/devices.ts` 的 useQuery/useMutation)。`fetchMessages` 直接 `mainApi.get`。

- [ ] **Step 3: typecheck + 提交**

Run: `pnpm --filter @meshbot/web-main typecheck` + `npx biome check apps/web-main`。

```bash
git add apps/web-main pnpm-lock.yaml
git commit -m "feat(web-main): IM 依赖 + ws/im 客户端 + 会话/消息/Agent-DM rest hooks"
```

---

### Task 13: IM 壳 + 侧栏 + Agent picker

**Files:**
- Create: `apps/web-main/src/app/messages/layout.tsx`(IM 壳:侧栏 + 内容区,含 AuthGuard 覆盖已由全局 Providers 提供)
- Create: `apps/web-main/src/app/messages/page.tsx`(空态:选一个 Agent 开始)
- Create: `apps/web-main/src/components/im/im-sidebar.tsx`(Agent-DM 会话列表 + 在线点)
- Create: `apps/web-main/src/components/im/agent-picker.tsx`(从设备列表建 DM)
- Modify: `apps/web-main/src/app/settings/layout.tsx` 或导航(加"消息"入口 → /messages)
- Modify: `apps/web-main/messages/{zh,en}.json`(`messages`/`messagesSidebar` 命名空间)

**Interfaces:**
- Consumes: Task 12 hooks;`useDevices`(A);`getImSocket`。
- Produces: `/messages` 路由 + IM 壳;侧栏列 Agent-DM 会话(名 = 设备名,在线点来自 presence 事件/`useDeviceOnline`);Agent picker 从 `useDevices()`(过滤未吊销)选设备 → `useCreateAgentDm` → 打开会话。

- [ ] **Step 1: 实现壳 + 侧栏 + picker**

参考 web-agent `messages-sidebar.tsx`(手写 Tailwind + lucide 图标 + 在线绿点),复刻精简版:侧栏顶部"新建"按钮(开 agent-picker),下面列 `useConversations()` 里 `agentDeviceId != null` 的会话(名取 `peer.displayName`,在线点)。壳布局:左侧栏 `w-64` + 右会话区(`{children}` 或选中会话)。导航入口:在 web-main 顶部导航(或 settings/layout 的 UserMenu 旁)加"消息"链接到 `/messages`。

- [ ] **Step 2: i18n + 走查 + 提交**

`messages.*` / `messagesSidebar.*` 命名空间 zh/en 对称真实文案;`pnpm sync:locales -- --check`;typecheck + biome;dev 起 web-main 看侧栏/picker 渲染。

```bash
git add apps/web-main
git commit -m "feat(web-main): IM 壳 + Agent-DM 侧栏 + Agent picker"
```

---

### Task 14: 会话视图(消息列表 + 输入框)

**Files:**
- Create: `apps/web-main/src/app/messages/[conversationId]/page.tsx`(会话视图)
- Create: `apps/web-main/src/components/im/im-conversation.tsx`(订阅 + 发消息 + 历史)
- Create: `apps/web-main/src/components/im/im-message-list.tsx`(消息列表,复刻 web-agent 行式)
- Modify: `apps/web-main/messages/{zh,en}.json`(`imConversation`/`chatInput` 命名空间)

**Interfaces:**
- Consumes: Task 12(`getImSocket`/`fetchMessages`)、`IM_WS_EVENTS`、`ImMessage`。
- Produces: 会话视图——打开时 `fetchMessages` 拉历史 + `socket.emit(IM_WS_EVENTS.read,{conversationId})`;`socket.on(IM_WS_EVENTS.message)` 收新消息(按 conversationId 过滤)追加;输入框 `socket.emit(IM_WS_EVENTS.send,{conversationId,content})`(无乐观插入,靠回声上屏);消息列表按 `senderType` 区分渲染(user=右/自己,agent=左/Agent 名+头像);向上滚动分页(顶部 sentinel → `fetchMessages(id, cursor)`)。

- [ ] **Step 1: 实现会话视图 + 消息列表**

复刻 web-agent `im-conversation-body.tsx` + `im-message-list.tsx` 的骨架(socket 订阅/发送/历史分页/粘底),但用 `getImSocket()`(直连 server-main)+ 直接 `socket.on("im.message", ...)`(非信封);消息列表按 `senderType` 分左右/配色(Agent 消息用 `sender_type==='agent'` 判定,头像用设备名首字母)。输入框用 design 的 `Input`/`textarea` + `Send` 图标(不引 tiptap,MVP 纯文本)。

- [ ] **Step 2: i18n + 联调冒烟 + 提交**

`imConversation.*`/`chatInput.*` zh/en 对称;`pnpm sync:locales -- --check`;typecheck + biome;**dev 四件套联调**(server-main 本地 Postgres + web-main + curl 模拟设备 relay 连 ws/im 收 agent.inbound + send 回复):web-main 建 Agent-DM → 发消息 → curl 模拟设备回一条 agent 消息 → web-main 会话视图显示 Agent 回复。报告写清覆盖。

```bash
git add apps/web-main
git commit -m "feat(web-main): Agent-DM 会话视图(消息列表+输入框+实时订阅)"
```

---

### Task 15: presence 集成 + 设备页在线态 + 收尾

**Files:**
- Modify: `apps/web-main/src/components/im/im-sidebar.tsx`(订阅 presence 事件更新在线点)
- Modify: `apps/web-main/src/app/settings/devices/page.tsx`(设备列表加在线态列)
- Modify: `apps/web-main/messages/{zh,en}.json`

**Interfaces:**
- Consumes: `getImSocket`(`IM_WS_EVENTS.presence` 事件,payload `{userId:'agent:'+deviceId, online}`)、`useDeviceOnline`(首屏)。
- Produces: 侧栏 Agent 在线点实时更新(presence 事件里 `userId` 以 `agent:` 前缀区分设备 presence);设备管理页每行显示在线/离线。

- [ ] **Step 1: 实现 presence 订阅 + 设备页在线列**

侧栏挂 `socket.on(IM_WS_EVENTS.presence, ...)`,解析 `userId` 若以 `agent:` 开头 → 提取 deviceId 更新对应 Agent 在线点(本地 state/react-query cache）。设备页 `useDevices()` 每行调 `useDeviceOnline(device.id)` 或批量(MVP 逐行 REST 可接受)显示在线态。

- [ ] **Step 2: i18n + 走查 + 提交**

zh/en 对称;`pnpm sync:locales -- --check`;typecheck + biome + dev 走查。

```bash
git add apps/web-main
git commit -m "feat(web-main): Agent 在线态实时更新 + 设备页在线列"
```

---

## Phase 4:收尾

### Task 16: 文档 + 全量回归 + boot + 冒烟

**Files:**
- Modify: `.claude/CLAUDE.md`(表归属:server-main 追加 `im_agent_session` 不适用——它在 server-agent;server-agent 行 Entity 追加 `ImAgentSession`;conversation/message 加列说明可选)
- Modify: `docs/architecture.md`(若有 IM/设备章节则补反向通道,无则跳过)

- [ ] **Step 1: 文档更新**(server-agent 表归属加 `ImAgentSession`;两轨的 IM 反向通道一句话)。

- [ ] **Step 2: 全量回归(读完整输出,不 tail 掩盖)**

```bash
pnpm typecheck
pnpm test            # 根 jest 应全绿
pnpm check:strict
pnpm sync:locales -- --check
```

基线:`libs/agent` vitest 9 个预存在失败不计入,以失败集合 diff 判断。

- [ ] **Step 3: boot 验证**

```bash
pnpm dev:server-main    # 本地 Postgres 配置;无 DI 错误、CORS 生效、监听
pnpm dev:server-agent   # SQLite 迁移(im_agent_session)自动执行;AgentInboxModule DI 无崩;端口自检
```

- [ ] **Step 4: 手动冒烟(四进程/curl)**

1. web-main 登录 → 建组织 → 授权一台设备(拿 deviceToken)。
2. curl 用 deviceToken 连 server-main `ws/im`(模拟设备 Agent 在线)。
3. web-main `/messages` → Agent picker 选该设备 → 建 DM → 发一条消息。
4. 断言:模拟设备 socket 收到 `agent.inbound`;(手工/脚本)让设备侧 `emit(send)` 回一条 → web-main 会话显示 Agent 回复;侧栏 Agent 在线点亮。
5. 断开设备 socket → 发消息 → 重连 → 补处理(设备侧 catchUp 拉到未读并回复)。
6. 真链路(可选,需 dev:server-agent 真跑 Agent + 真模型):web-main 私聊真实本地 Agent → 本地 run → 回复回流。

- [ ] **Step 5: 部署待办收集 + 提交**

汇总:server-main 新 DDL `202607041000-agent-dm-columns.sql` 需 DBA 执行;其余沿用 A 的(encryption-key/反代/CORS)。

```bash
git add .claude/CLAUDE.md docs
git commit -m "docs: 子项目B收尾——表归属与架构文档更新"
```

---

## Self-Review 记录(写完计划后自查)

1. **Spec 覆盖**:身份=device(T2/4)、IM 表加列(T1)、反向通道定向下发(T5)、agent.inbound 触发本地 run+回流(T9/10)、离线排队+本地游标补处理(T8/11)、设备级 presence(T3/5/15)、web-main IM 前端(T12-15)、错误处理(T10 失败回错误消息+推进游标)、迁移兼容(T1 存量默认 user、T8 SQLite)、测试(各 task TDD + T7 e2e + T16 boot/冒烟)。spec 全部条目有对应 task。
2. **有意偏离/留待实施确认**:①`sessions.createSession` 的 `kind` 接受任意字符串(`im-agent`)需实施时确认签名;②`AccountContextService` 导出路径以实际为准;③补处理 MVP 拉最近 50 条(超出老消息忽略+日志,已知限制);④web-main IM 输入框用纯文本(不引 tiptap);⑤device 连接回流广播依赖 device 连接已 join 该会话 `conv:` room(T5 靠 `listConversations(device.userId)` 覆盖,实施时 e2e 验证)。
3. **类型一致性**:`ImAgentInboundEvent{conversationId,messageId,content,senderUserId}`(T4 定义、T5 emit、T9 转发、T10 消费)一致;`ConversationSummary.agentDeviceId`(T4)/`ImMessage.senderType`(T4)前后端一致;`IM_WS_EVENTS.agentInbound="im.agent_inbound"`(T4)三处消费;`IM_RELAY_EVENTS.connected`(T9 定义、T11 消费);`ImAgentSessionService` 方法名(T8 定义、T10/11 消费)一致。
4. **执行顺序**:T4(类型)与 T5/6 消费方紧邻,check:dead 可能要求合并提交——实施时 T4→T5 连续;T7 e2e 依赖 T1-6;Phase 2 依赖 Phase 1 的云端端点(T10/11 的 relay/REST 契约);Phase 3 依赖 Phase 1 REST + ws/im;T16 全部之后。



