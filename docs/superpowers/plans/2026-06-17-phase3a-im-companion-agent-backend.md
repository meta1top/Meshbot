# Phase 3a：IM 伴生 Agent（后端）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** server-agent 侧打通「每个 IM 会话一个本地伴生 Agent」：入站 IM 消息按规则触发用户的完整本地 Agent 运行，产出候选回复进**伴生会话**（隐藏会话），并经 REST 暴露伴生会话 + 开关。前端侧栏（Plan 3b）后续消费。

**Architecture:** `sessions` 表加 `kind/im_conversation_id/im_conv_type/agent_enabled` 标识伴生会话（复用 Session/Runner/Graph）。relay 下行 emit 包进 `account.run(cloudUserId)`，新 `ImAgentService` `@OnEvent(im.message)` 在账号上下文里 find/create 伴生会话、把消息作为 pending 摄入、按"私信对端 / 频道@自己 + 开关"触发 `runner.kick`。触发逻辑与 @ 检测抽成纯函数单测。REST 暴露 `GET/PUT /api/im/:conversationId/agent-session`。

**Tech Stack:** NestJS、TypeORM(SQLite)、@nestjs/event-emitter、Jest。

## Global Constraints
- Spec：`docs/superpowers/specs/2026-06-17-phase3-im-companion-agent-design.md`。
- 仅 server-agent + libs；不动 server-main / 不引入新依赖。
- 账号隔离：伴生会话经 `ScopedRepository`（account 上下文）读写；ImAgentService 在 relay 注入的账号上下文内运行。
- 围栏：commit 前相关 `pnpm check:*` 通过；公开方法中文 JSDoc。
- 伴生会话**绝不自动发 IM**（Plan 3a 不含任何发送逻辑）。

---

## Task 1: 数据模型 —— sessions 加伴生字段 + 迁移

**Files:**
- Modify: `apps/server-agent/src/entities/session.entity.ts`
- Create: `apps/server-agent/src/migrations/1780300000000-AddSessionImCompanionFields.ts`
- Modify: `apps/server-agent/src/app.module.ts`（迁移注册数组，若迁移按 glob 自动加载则免改 —— 见步骤）

**Interfaces:**
- Produces: `Session.kind: "user" | "im"`、`Session.imConversationId: string | null`、`Session.imConvType: "channel" | "dm" | null`、`Session.agentEnabled: boolean`。

- [ ] **Step 1: 实体加字段**

`session.entity.ts` 在 `titleGenerated` 列之后追加：

```ts
  /** 'user' = 用户主动会话（默认）；'im' = IM 会话的伴生 Agent 会话（隐藏）。 */
  @Column({ type: "varchar", default: "user" })
  kind!: "user" | "im";

  /** 伴生会话绑定的 IM conversationId；kind='user' 为 null。 */
  @Column({ name: "im_conversation_id", type: "text", nullable: true })
  imConversationId!: string | null;

  /** 伴生会话对应的 IM 会话类型，用于触发判定；kind='user' 为 null。 */
  @Column({ name: "im_conv_type", type: "varchar", nullable: true })
  imConvType!: "channel" | "dm" | null;

  /** 仅 kind='im' 有意义：该 IM 会话是否启用伴生 Agent，默认开。 */
  @Column({ name: "agent_enabled", type: "boolean", default: true })
  agentEnabled!: boolean;
```

- [ ] **Step 2: 写迁移**

先 `ls apps/server-agent/src/migrations/` 看现有迁移类的写法（`implements MigrationInterface`，`up`/`down` 用 `queryRunner.query`）。创建 `1780300000000-AddSessionImCompanionFields.ts`：

```ts
import type { MigrationInterface, QueryRunner } from "typeorm";

/** sessions 表加伴生 Agent 字段（IM 会话伴生会话）。SQLite。 */
export class AddSessionImCompanionFields1780300000000
  implements MigrationInterface
{
  name = "AddSessionImCompanionFields1780300000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "sessions" ADD COLUMN "kind" varchar NOT NULL DEFAULT 'user'`,
    );
    await queryRunner.query(
      `ALTER TABLE "sessions" ADD COLUMN "im_conversation_id" text`,
    );
    await queryRunner.query(
      `ALTER TABLE "sessions" ADD COLUMN "im_conv_type" varchar`,
    );
    await queryRunner.query(
      `ALTER TABLE "sessions" ADD COLUMN "agent_enabled" boolean NOT NULL DEFAULT 1`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_sessions_cloud_user_im_conv" ON "sessions" ("cloud_user_id", "im_conversation_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_sessions_cloud_user_im_conv"`);
    for (const col of ["agent_enabled", "im_conv_type", "im_conversation_id", "kind"]) {
      await queryRunner.query(`ALTER TABLE "sessions" DROP COLUMN "${col}"`);
    }
  }
}
```

- [ ] **Step 3: 确认迁移被加载**

查 `apps/server-agent/src/app.module.ts` 的 `migrations` 配置：若用 glob（如 `migrations/*.ts`/编译产物 glob）则自动加载，无需改；若是显式数组，把 `AddSessionImCompanionFields1780300000000` 加进去。（参照已有迁移如何被引用。）

- [ ] **Step 4: typecheck**

Run: `pnpm --filter @meshbot/server-agent typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server-agent/src/entities/session.entity.ts apps/server-agent/src/migrations/1780300000000-AddSessionImCompanionFields.ts apps/server-agent/src/app.module.ts
git commit -m "feat(server-agent): sessions 加伴生 Agent 字段（kind/im_conversation_id/im_conv_type/agent_enabled）+ 迁移

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: SessionService 伴生方法 + 列表隐藏（TDD）

**Files:**
- Modify: `apps/server-agent/src/services/session.service.ts`
- Test: `apps/server-agent/src/services/session.service.spec.ts`（若无则建；沿用现有 ScopedRepository 测试约定）

**Interfaces:**
- Consumes: `Session` 实体新字段（Task 1）。
- Produces:
  - `findOrCreateImCompanion(conversationId: string, convType: "channel" | "dm", title: string): Promise<Session>`
  - `getImCompanion(conversationId: string): Promise<Session | null>`
  - `setCompanionAgentEnabled(conversationId: string, enabled: boolean): Promise<void>`
  - `listAllSorted()` 现有签名不变，但只返回 `kind='user'`。

- [ ] **Step 1: 写失败测试**

在 `session.service.spec.ts` 追加（沿用该文件已有的 sessionRepo 桩风格；若文件不存在，参照 `conversation.service.spec.ts`（libs/main）的手写桩思路为 server-agent 的 ScopedRepository 建桩）：

```ts
describe("IM 伴生会话", () => {
  it("findOrCreateImCompanion: 首次建 kind='im' 会话，再次同 conversationId 返回同一条", async () => {
    const a = await svc.findOrCreateImCompanion("conv-1", "dm", "对端A");
    expect(a.kind).toBe("im");
    expect(a.imConversationId).toBe("conv-1");
    expect(a.imConvType).toBe("dm");
    expect(a.agentEnabled).toBe(true);
    const b = await svc.findOrCreateImCompanion("conv-1", "dm", "对端A");
    expect(b.id).toBe(a.id); // 幂等
  });

  it("getImCompanion: 未建返回 null，建后返回该会话", async () => {
    expect(await svc.getImCompanion("conv-x")).toBeNull();
    const c = await svc.findOrCreateImCompanion("conv-x", "channel", "综合");
    expect((await svc.getImCompanion("conv-x"))?.id).toBe(c.id);
  });

  it("setCompanionAgentEnabled: 切换开关", async () => {
    await svc.findOrCreateImCompanion("conv-2", "dm", "对端B");
    await svc.setCompanionAgentEnabled("conv-2", false);
    expect((await svc.getImCompanion("conv-2"))?.agentEnabled).toBe(false);
  });

  it("listAllSorted: 不含 kind='im' 伴生会话", async () => {
    await svc.createSession({ content: "普通会话" });
    await svc.findOrCreateImCompanion("conv-3", "dm", "对端C");
    const list = await svc.listAllSorted();
    expect(list.every((s) => s.id)).toBe(true);
    // 伴生会话 id 不应出现
    const companion = await svc.getImCompanion("conv-3");
    expect(list.map((s) => s.id)).not.toContain(companion?.id);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @meshbot/server-agent test -- session.service`
Expected: FAIL（方法未定义）

- [ ] **Step 3: 实现**

`session.service.ts` 新增方法（用 `this.sessionRepo` 作用域仓库；单表写，无需 `@Transactional`）：

```ts
  /** 找/建某 IM 会话的伴生会话（kind='im'）；同 conversationId 幂等。 */
  async findOrCreateImCompanion(
    conversationId: string,
    convType: "channel" | "dm",
    title: string,
  ): Promise<Session> {
    const existing = await this.sessionRepo.findOneBy({
      imConversationId: conversationId,
      kind: "im",
    });
    if (existing) return existing;
    return (await this.sessionRepo.save({
      title,
      status: "idle" as const,
      kind: "im" as const,
      imConversationId: conversationId,
      imConvType: convType,
      agentEnabled: true,
    })) as Session;
  }

  /** 取某 IM 会话的伴生会话；无则 null。 */
  async getImCompanion(conversationId: string): Promise<Session | null> {
    return this.sessionRepo.findOneBy({
      imConversationId: conversationId,
      kind: "im",
    });
  }

  /** 切换某 IM 会话伴生 Agent 开关。 */
  async setCompanionAgentEnabled(
    conversationId: string,
    enabled: boolean,
  ): Promise<void> {
    await this.sessionRepo.update(
      { imConversationId: conversationId, kind: "im" },
      { agentEnabled: enabled },
    );
  }
```

`listAllSorted` 的 queryBuilder 加 `kind='user'` 过滤（在现有 `.scopedQueryBuilder("s")` 链上加一处 `.where`）：

```ts
  async listAllSorted(): Promise<SessionSummary[]> {
    const rows = await this.sessionRepo
      .scopedQueryBuilder("s")
      .where("s.kind = :kind", { kind: "user" })
      .orderBy("CASE WHEN s.pinned_at IS NULL THEN 1 ELSE 0 END", "ASC")
      .addOrderBy("s.pinned_at", "DESC")
      .addOrderBy("s.updated_at", "DESC")
      .addOrderBy("s.id", "DESC")
      .getMany();
    return rows.map(toSummary);
  }
```
> 注意：`scopedQueryBuilder` 已注入 `cloud_user_id` 条件；这里用 `.where` 追加 kind 过滤需确认不覆盖作用域条件——若 `.where` 会清掉作用域条件，改用 `.andWhere`。实现时按 ScopedRepository 的 queryBuilder 语义选 `.where`/`.andWhere`，并让"账号隔离单测"仍通过。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @meshbot/server-agent test -- session.service`
Expected: PASS（新用例 + 原有用例全绿）

- [ ] **Step 5: 围栏 + 提交**

Run: `pnpm check:scope && pnpm check:repo && pnpm check:naming`
Expected: 0 finding（新方法单表写、非 *InTx、走 ScopedRepository）

```bash
git add apps/server-agent/src/services/session.service.ts apps/server-agent/src/services/session.service.spec.ts
git commit -m "feat(server-agent): SessionService 伴生会话 find/create/toggle + listAllSorted 隐藏 kind='im'（TDD）

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: relay 下行 emit 包进账号上下文

**Files:**
- Modify: `apps/server-agent/src/cloud/im-relay-client.service.ts`
- Modify: `apps/server-agent/src/auth.module.ts`（ImRelayClientService factory 注入 AccountContextService）

**Interfaces:**
- Produces: 入站 IM 事件（`IM_WS_EVENTS.message` 等）经 EventEmitter2 派发时，处于 `AccountContextService.run(<该 relay 的 cloudUserId>)` 上下文内（同步派发 → `@OnEvent` handler 可 `account.getOrThrow()`）。

- [ ] **Step 1: relay 构造注入 AccountContextService + 包裹 emit**

READ `im-relay-client.service.ts`。构造函数加 `private readonly account: AccountContextService`（从 `@meshbot/agent` import）。把 §下行事件循环里的 emit 包进 `account.run(cloudUserId)`（`cloudUserId` 是 `connect(cloudUserId)` 的入参，闭包可见）：

```ts
      for (const event of [
        IM_WS_EVENTS.message,
        IM_WS_EVENTS.presence,
        IM_WS_EVENTS.conversationCreated,
        IM_WS_EVENTS.conversationRemoved,
      ] as const) {
        socket.on(event, (payload: unknown) => {
          this.account.run(cloudUserId, () => {
            this.emitter.emit(event, payload);
          });
        });
      }
```
> `account.run` 同步执行 fn；EventEmitter2 `emit` 同步派发所有监听器（含 im.gateway 转发 + 新 ImAgentService），均在该账号上下文内。payload 不变，im.gateway 现有监听不受影响。

- [ ] **Step 2: auth.module factory 注入 AccountContextService**

READ `auth.module.ts` 里 `provide: ImRelayClientService` 的 `useFactory`/`inject`。把 `AccountContextService` 加进 `inject` 数组并作为构造参数传入（顺序与构造函数一致）。AccountContextService 由全局 `AccountContextModule` 提供，可注入。

- [ ] **Step 3: typecheck + biome + relay 单测**

Run: `pnpm --filter @meshbot/server-agent typecheck && pnpm exec biome check apps/server-agent/src/cloud/im-relay-client.service.ts apps/server-agent/src/auth.module.ts`
Run: `npx jest apps/server-agent/src/cloud/im-relay-client.service.spec.ts`
Expected: typecheck PASS；biome clean；relay 单测 PASS（若桩注入了 ImRelayClientService 构造参数，更新桩补 AccountContextService —— 传 `new AccountContextService()` 真实实例即可）

- [ ] **Step 4: Commit**

```bash
git add apps/server-agent/src/cloud/im-relay-client.service.ts apps/server-agent/src/auth.module.ts apps/server-agent/src/cloud/im-relay-client.service.spec.ts
git commit -m "feat(server-agent): relay 下行 emit 包进 account.run（为 IM 伴生 Agent 提供账号上下文）

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: 触发判定 + @ 检测（纯函数，TDD）

**Files:**
- Create: `apps/server-agent/src/services/im-agent.trigger.ts`
- Test: `apps/server-agent/src/services/im-agent.trigger.spec.ts`

**Interfaces:**
- Produces:
  - `mentionsSelf(content: string, selfHandles: string[]): boolean`
  - `shouldTriggerCompanion(input: { convType: "channel" | "dm"; senderId: string; selfId: string; content: string; selfHandles: string[]; agentEnabled: boolean }): boolean`

- [ ] **Step 1: 写失败测试**

`im-agent.trigger.spec.ts`：

```ts
import { mentionsSelf, shouldTriggerCompanion } from "./im-agent.trigger";

describe("mentionsSelf", () => {
  it("命中 @displayName（大小写不敏感、词边界）", () => {
    expect(mentionsSelf("hey @Grant 看下", ["Grant", "grant"])).toBe(true);
    expect(mentionsSelf("hey @GRANT", ["Grant"])).toBe(true);
  });
  it("不命中：无 @ / 非自己 / 子串误匹配", () => {
    expect(mentionsSelf("Grant 你好", ["Grant"])).toBe(false); // 无 @
    expect(mentionsSelf("@Grantham", ["Grant"])).toBe(false); // 词边界
    expect(mentionsSelf("@Bob", ["Grant"])).toBe(false);
  });
});

describe("shouldTriggerCompanion", () => {
  const base = { selfId: "me", selfHandles: ["Grant"], agentEnabled: true };
  it("私信：对端消息触发", () => {
    expect(shouldTriggerCompanion({ ...base, convType: "dm", senderId: "peer", content: "在吗" })).toBe(true);
  });
  it("私信：自己消息不触发", () => {
    expect(shouldTriggerCompanion({ ...base, convType: "dm", senderId: "me", content: "在" })).toBe(false);
  });
  it("频道：@自己触发，未@不触发", () => {
    expect(shouldTriggerCompanion({ ...base, convType: "channel", senderId: "peer", content: "@Grant 看下" })).toBe(true);
    expect(shouldTriggerCompanion({ ...base, convType: "channel", senderId: "peer", content: "大家好" })).toBe(false);
  });
  it("开关关：一律不触发", () => {
    expect(shouldTriggerCompanion({ ...base, agentEnabled: false, convType: "dm", senderId: "peer", content: "在吗" })).toBe(false);
  });
  it("频道：自己@自己不触发（senderId=self）", () => {
    expect(shouldTriggerCompanion({ ...base, convType: "channel", senderId: "me", content: "@Grant" })).toBe(false);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx jest apps/server-agent/src/services/im-agent.trigger.spec.ts`
Expected: FAIL（模块未定义）

- [ ] **Step 3: 实现纯函数**

`im-agent.trigger.ts`：

```ts
/** content 是否 @ 了自己（任一 handle 命中，大小写不敏感、词边界）。 */
export function mentionsSelf(content: string, selfHandles: string[]): boolean {
  for (const h of selfHandles) {
    if (!h) continue;
    const escaped = h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // @handle 后接非单词字符或结尾
    const re = new RegExp(`@${escaped}(?![\\w-])`, "i");
    if (re.test(content)) return true;
  }
  return false;
}

/** 是否触发伴生 Agent 运行：开关开 + 非自己发 + (私信 | 频道@自己)。 */
export function shouldTriggerCompanion(input: {
  convType: "channel" | "dm";
  senderId: string;
  selfId: string;
  content: string;
  selfHandles: string[];
  agentEnabled: boolean;
}): boolean {
  if (!input.agentEnabled) return false;
  if (input.senderId === input.selfId) return false;
  if (input.convType === "dm") return true;
  return mentionsSelf(input.content, input.selfHandles);
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx jest apps/server-agent/src/services/im-agent.trigger.spec.ts`
Expected: PASS（全部用例）

- [ ] **Step 5: Commit**

```bash
git add apps/server-agent/src/services/im-agent.trigger.ts apps/server-agent/src/services/im-agent.trigger.spec.ts
git commit -m "feat(server-agent): IM 伴生 Agent 触发判定 + @检测纯函数（TDD）

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: ImAgentService —— 摄入/触发编排 + 模块注册（TDD）

**Files:**
- Create: `apps/server-agent/src/services/im-agent.service.ts`
- Test: `apps/server-agent/src/services/im-agent.service.spec.ts`
- Modify: `apps/server-agent/src/im.module.ts`（import SessionModule、provide ImAgentService）
- Modify: `apps/server-agent/src/session.module.ts`（确保 exports SessionService + RunnerService）

**Interfaces:**
- Consumes: `SessionService.{findOrCreateImCompanion,getImCompanion,appendMessage}`、`RunnerService.kick`、`CloudImService.listConversations`、`CloudIdentityService.get`、`AccountContextService.get`、`shouldTriggerCompanion`（Task 4）、`IM_WS_EVENTS.message`、`ImMessage`。
- Produces: `ImAgentService.onImMessage(msg: ImMessage): Promise<void>`（`@OnEvent(IM_WS_EVENTS.message)`）。

- [ ] **Step 1: 写失败测试（用桩验证摄入 + 触发决策）**

`im-agent.service.spec.ts`（手写桩，不接真 DB/relay）：

```ts
import { ImAgentService } from "./im-agent.service";

function makeSvc(opts: { convType: "channel" | "dm"; selfId: string; agentEnabled?: boolean }) {
  const appended: { sessionId: string; content: string }[] = [];
  const kicked: string[] = [];
  const companion = { id: "comp-1", imConvType: opts.convType, agentEnabled: opts.agentEnabled ?? true };
  const sessions: any = {
    findOrCreateImCompanion: jest.fn().mockResolvedValue(companion),
    appendMessage: jest.fn(async (sid: string, m: any) => { appended.push({ sessionId: sid, content: m.content }); return { messageId: m.messageId, queued: false }; }),
  };
  const runner: any = { kick: jest.fn((sid: string) => kicked.push(sid)) };
  const cloudIm: any = { listConversations: jest.fn().mockResolvedValue([{ id: "conv-1", type: opts.convType, name: "X", peer: opts.convType === "dm" ? { displayName: "对端" } : null }]) };
  const identity: any = { get: jest.fn().mockResolvedValue({ cloudUserId: opts.selfId, displayName: "Grant", email: "grant@x.com" }) };
  const account: any = { get: jest.fn().mockReturnValue(opts.selfId) };
  const svc = new ImAgentService(sessions, runner, cloudIm, identity, account);
  return { svc, appended, kicked, sessions, runner };
}

describe("ImAgentService.onImMessage", () => {
  it("私信对端消息：摄入 + kick", async () => {
    const { svc, appended, kicked } = makeSvc({ convType: "dm", selfId: "me" });
    await svc.onImMessage({ id: "m1", conversationId: "conv-1", senderId: "peer", content: "在吗", createdAt: "t" });
    expect(appended).toHaveLength(1);
    expect(kicked).toEqual(["comp-1"]);
  });

  it("私信自己消息：只摄入不 kick", async () => {
    const { svc, appended, kicked } = makeSvc({ convType: "dm", selfId: "me" });
    await svc.onImMessage({ id: "m2", conversationId: "conv-1", senderId: "me", content: "在", createdAt: "t" });
    expect(appended).toHaveLength(1);
    expect(kicked).toEqual([]);
  });

  it("频道未@：只摄入不 kick；@自己：kick", async () => {
    const a = makeSvc({ convType: "channel", selfId: "me" });
    await a.svc.onImMessage({ id: "m3", conversationId: "conv-1", senderId: "peer", content: "大家好", createdAt: "t" });
    expect(a.kicked).toEqual([]);
    const b = makeSvc({ convType: "channel", selfId: "me" });
    await b.svc.onImMessage({ id: "m4", conversationId: "conv-1", senderId: "peer", content: "@Grant 看下", createdAt: "t" });
    expect(b.kicked).toEqual(["comp-1"]);
  });

  it("开关关：摄入也跳过、不 kick", async () => {
    const { svc, appended, kicked } = makeSvc({ convType: "dm", selfId: "me", agentEnabled: false });
    await svc.onImMessage({ id: "m5", conversationId: "conv-1", senderId: "peer", content: "在吗", createdAt: "t" });
    expect(appended).toEqual([]);
    expect(kicked).toEqual([]);
  });

  it("无账号上下文：直接返回", async () => {
    const { svc, appended } = makeSvc({ convType: "dm", selfId: "me" });
    (svc as any).account.get = () => null;
    await svc.onImMessage({ id: "m6", conversationId: "conv-1", senderId: "peer", content: "x", createdAt: "t" });
    expect(appended).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx jest apps/server-agent/src/services/im-agent.service.spec.ts`
Expected: FAIL（ImAgentService 未定义）

- [ ] **Step 3: 实现 ImAgentService**

`im-agent.service.ts`：

```ts
import { AccountContextService } from "@meshbot/agent";
import { IM_WS_EVENTS, type ImMessage } from "@meshbot/types";
import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";

import { CloudIdentityService } from "./cloud-identity.service";
import { CloudImService } from "./cloud-im.service";
import { RunnerService } from "./runner.service";
import { SessionService } from "./session.service";
import { shouldTriggerCompanion } from "./im-agent.trigger";

/**
 * IM 伴生 Agent 编排：监听入站 IM 消息，把消息摄入对应会话的伴生 Agent 会话，
 * 按"私信对端 / 频道@自己 + 开关"触发本地 Agent 运行（候选回复进伴生会话，不发 IM）。
 * 运行在 relay 注入的账号上下文内（见 relay account.run 包裹）。
 */
@Injectable()
export class ImAgentService {
  private readonly logger = new Logger(ImAgentService.name);

  constructor(
    private readonly sessions: SessionService,
    private readonly runner: RunnerService,
    private readonly cloudIm: CloudImService,
    private readonly identity: CloudIdentityService,
    private readonly account: AccountContextService,
  ) {}

  /** 入站 IM 消息钩子（relay → EventEmitter2，账号上下文内同步派发）。 */
  @OnEvent(IM_WS_EVENTS.message)
  async onImMessage(msg: ImMessage): Promise<void> {
    const selfId = this.account.get();
    if (!selfId) return; // 无账号上下文（异常）→ 跳过

    // 解析会话类型/标题（建伴生会话用）
    const convs = await this.cloudIm.listConversations();
    const conv = convs.find((c) => c.id === msg.conversationId);
    if (!conv || (conv.type !== "channel" && conv.type !== "dm")) return;
    const title = conv.name ?? conv.peer?.displayName ?? "IM 会话";

    const companion = await this.sessions.findOrCreateImCompanion(
      msg.conversationId,
      conv.type,
      title,
    );

    // 开关关：跳过（不摄入、不运行）
    if (!companion.agentEnabled) return;

    // 摄入：作为 pending 消息进伴生会话（含发送者标注）；msg.id 作 pending id（幂等）
    const self = await this.identity.get(selfId);
    const who = msg.senderId === selfId ? "我" : "对端";
    await this.sessions.appendMessage(companion.id, {
      messageId: msg.id,
      content: `[${who}] ${msg.content}`,
    });

    // 触发判定
    const selfHandles = self
      ? [self.displayName, self.email.split("@")[0]].filter(Boolean)
      : [];
    const trigger = shouldTriggerCompanion({
      convType: companion.imConvType ?? conv.type,
      senderId: msg.senderId,
      selfId,
      content: msg.content,
      selfHandles,
      agentEnabled: companion.agentEnabled,
    });
    if (trigger) {
      this.runner.kick(companion.id); // 跑 Agent，处理累积的 pending（候选回复进伴生会话）
    }
  }
}
```
> 设计说明（写进类 JSDoc 或 PR 说明）：摄入用 pending 队列累积上下文；非触发消息只 append 不 kick，下次触发 kick 时 runner 一并 claim 处理（批量上下文）。开关关时跳过摄入（避免 pending 永不消费的堆积；再开启从新上下文起）。Agent 的"协助回复"角色暂由消息 `[我]/[对端]` 标注框定（系统 prompt 仍是全局；专用 prompt 留后续 refine）。

- [ ] **Step 4: 模块注册**

`session.module.ts`：确保 `exports` 含 `SessionService` 与 `RunnerService`（READ 确认；缺则补到 exports）。
`im.module.ts`：`imports` 加 `SessionModule`；`providers` 加 `ImAgentService`。`CloudImService` 已在本模块、`CloudIdentityService` 由 `AuthModule`（已 import）导出、`AccountContextService` 全局。

```ts
// im.module.ts 摘要
@Module({
  imports: [AuthModule, SessionModule],
  controllers: [CloudImController],
  providers: [CloudImService, ImGateway, ImAgentService],
})
export class ImModule {}
```

- [ ] **Step 5: 运行确认通过 + typecheck**

Run: `npx jest apps/server-agent/src/services/im-agent.service.spec.ts`
Expected: PASS
Run: `pnpm --filter @meshbot/server-agent typecheck`
Expected: PASS（含模块装配类型）

- [ ] **Step 6: 围栏 + 提交**

Run: `pnpm check:repo && pnpm check:scope`
Expected: 0 finding（ImAgentService 不注入 Repo，只注入 Service）

```bash
git add apps/server-agent/src/services/im-agent.service.ts apps/server-agent/src/services/im-agent.service.spec.ts apps/server-agent/src/im.module.ts apps/server-agent/src/session.module.ts
git commit -m "feat(server-agent): ImAgentService —— IM 入站摄入 + 触发本地 Agent（@OnEvent，TDD）

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: REST —— 伴生会话查询 / 开关切换

**Files:**
- Create: `apps/server-agent/src/controllers/im-agent.controller.ts`
- Create: `apps/server-agent/src/dto/im-agent.dto.ts`（开关 DTO）
- Modify: `apps/server-agent/src/im.module.ts`（注册 ImAgentController）
- Modify: `libs/types/src/im/im.schema.ts`（共享开关 schema，可选）

**Interfaces:**
- Consumes: `SessionService.{getImCompanion, setCompanionAgentEnabled, findOrCreateImCompanion}`、`CloudImService.listConversations`、`AccountContextService`。
- Produces（前端 Plan 3b 消费）:
  - `GET /api/im/:conversationId/agent-session` → `{ sessionId: string; agentEnabled: boolean; convType: "channel"|"dm" }`
  - `PUT /api/im/:conversationId/agent-session` body `{ enabled: boolean }` → `{ ok: true }`

- [ ] **Step 1: DTO**

`libs/types/src/im/im.schema.ts` 加：
```ts
export const SetAgentEnabledSchema = z.object({ enabled: z.boolean() });
export type SetAgentEnabledInput = z.infer<typeof SetAgentEnabledSchema>;
```
`apps/server-agent/src/dto/im-agent.dto.ts`（沿用本仓库 createZodDto 风格，参照 `dto/im.dto.ts`）：
```ts
import { createZodDto } from "@meshbot/common"; // 按现有 im.dto.ts 实际 import 来源对齐
import { SetAgentEnabledSchema } from "@meshbot/types";

export class SetAgentEnabledDto extends createZodDto(SetAgentEnabledSchema) {}
```

- [ ] **Step 2: Controller**

`im-agent.controller.ts`（受本地 JWT 保护，账号上下文由全局 interceptor 注入）：
```ts
import { Body, Controller, Get, Param, Put } from "@nestjs/common";

import { SetAgentEnabledDto } from "../dto/im-agent.dto";
import { CloudImService } from "../services/cloud-im.service";
import { SessionService } from "../services/session.service";

/** IM 伴生 Agent 会话的本地 REST：取伴生会话 + 开关切换。 */
@Controller("api/im")
export class ImAgentController {
  constructor(
    private readonly sessions: SessionService,
    private readonly cloudIm: CloudImService,
  ) {}

  /** 取（或惰性建）某 IM 会话的伴生会话 id + 开关。 */
  @Get(":conversationId/agent-session")
  async getAgentSession(
    @Param("conversationId") conversationId: string,
  ): Promise<{ sessionId: string; agentEnabled: boolean; convType: "channel" | "dm" }> {
    const convs = await this.cloudIm.listConversations();
    const conv = convs.find((c) => c.id === conversationId);
    const type: "channel" | "dm" = conv?.type === "channel" ? "channel" : "dm";
    const title = conv?.name ?? conv?.peer?.displayName ?? "IM 会话";
    const companion = await this.sessions.findOrCreateImCompanion(conversationId, type, title);
    return {
      sessionId: companion.id,
      agentEnabled: companion.agentEnabled,
      convType: (companion.imConvType ?? type) as "channel" | "dm",
    };
  }

  /** 切换某 IM 会话伴生 Agent 开关。 */
  @Put(":conversationId/agent-session")
  async setAgentEnabled(
    @Param("conversationId") conversationId: string,
    @Body() dto: SetAgentEnabledDto,
  ): Promise<{ ok: true }> {
    await this.sessions.findOrCreateImCompanion(
      conversationId,
      "dm", // 若不存在先建；类型在 get 时已正确写入，update 不改类型
      "IM 会话",
    );
    await this.sessions.setCompanionAgentEnabled(conversationId, dto.enabled);
    return { ok: true };
  }
}
```
> 路由前缀注意：server-agent **无全局 prefix**，故 `@Controller("api/im")` → `/api/im/...`。与现有 `CloudImController`（`@Controller("api")`）不冲突（路径不同）。确认 server-agent 确无 `setGlobalPrefix`（main.ts）——若有则去掉 controller 里的 `api`。

- [ ] **Step 3: 注册 + typecheck**

`im.module.ts` 的 `controllers` 加 `ImAgentController`。
Run: `pnpm --filter @meshbot/server-agent typecheck && pnpm exec biome check apps/server-agent/src/controllers/im-agent.controller.ts apps/server-agent/src/dto/im-agent.dto.ts`
Expected: PASS / clean

- [ ] **Step 4: 冒烟（可选，需登录账号）**

Run（带有效本地 token）: `curl -s localhost:3100/api/im/<conversationId>/agent-session -H "Authorization: Bearer <token>"`
Expected: 返回 `{sessionId, agentEnabled:true, convType}`（或在无 conv 时按默认）。无法快速验则跳过，由 Plan 3b 手验覆盖。

- [ ] **Step 5: 围栏 + 提交**

Run: `pnpm check:repo && pnpm check:swagger 2>/dev/null || true`（controller 不注入 Repo）
```bash
git add apps/server-agent/src/controllers/im-agent.controller.ts apps/server-agent/src/dto/im-agent.dto.ts apps/server-agent/src/im.module.ts libs/types/src/im/im.schema.ts
git commit -m "feat(server-agent): IM 伴生会话 REST（取伴生会话 / 切开关）

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: 全量验证 + 收尾

- [ ] **Step 1: 全量 typecheck**

Run: `pnpm typecheck`
Expected: 全包 PASS

- [ ] **Step 2: 静态围栏全套**

Run: `pnpm check`
Expected: 6 围栏全 0 新增 finding

- [ ] **Step 3: server-agent 相关单测**

Run: `pnpm --filter @meshbot/server-agent test -- "session.service|im-agent"`
Expected: PASS

- [ ] **Step 4: 端到端冒烟（手动，dev 起 server-main + server-agent + Redis）**

私信里让对端发一条消息 → server-agent 日志应显示伴生会话被建 + runner kick；`GET /api/im/<conv>/agent-session` 返回伴生 sessionId；查该 session 历史（`GET /api/sessions/<id>/history` 或 DB）应有 `[对端] ...` 摄入消息 + Agent 候选回复。频道未 @ 不 kick、@ 后 kick。关开关后不再 kick。

- [ ] **Step 5: 最终 Commit（如有零碎）**

```bash
git add -A && git commit -m "chore(server-agent): Phase 3a 伴生 Agent 后端收尾（typecheck/围栏/测试）" || echo "无额外改动"
```

---

## 自检记录（spec 覆盖）

- 伴生会话模型（kind/im_conversation_id/im_conv_type/agent_enabled）→ Task 1 ✓
- 隐藏（listAllSorted 只 kind='user'）→ Task 2 ✓
- relay 账号上下文（owner 传递）→ Task 3 ✓
- 触发规则（私信对端 / 频道@ / 自己抑制 / 开关）+ @检测 → Task 4（纯函数）+ Task 5（编排）✓
- 摄入双方消息为上下文（pending 累积，开关关跳过）→ Task 5 ✓
- 复用完整 Agent 运行（runner.kick）→ Task 5 ✓
- 每会话开关 REST + 取伴生会话 → Task 6 ✓
- 不自动发 IM → Plan 3a 全程无发送逻辑 ✓
- 账号隔离 / 围栏 → Task 2/5/7 ✓
- 前端侧栏 + 一键发送 → **Plan 3b（不在本计划）**
- 任务面板 MCP / PDF → **Phase 4（不在本计划）**
