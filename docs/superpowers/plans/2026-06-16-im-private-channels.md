# IM 私有频道 + 成员管理 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 Phase 2 IM 之上新增「私有频道」：仅成员可见可发言，支持创建时选初始成员、任意成员拉人、成员主动退出；公开频道行为不变。

**Architecture:** `conversation` 新增 `visibility('public'|'private')` 列。私有频道复用既有 `conversation_member` 表做成员制（同 DM）。可见性判定集中在 `ConversationService`。拉人复用现有 `conversationCreated` ws 事件让目标 socket 入房；退出新增 `im.conversation_removed` 下行事件让其离房。server-agent 薄代理 + relay 转发新事件；web-agent 建频道弹框加公开/私有 + 成员多选，私有频道头加成员/退出。

**Tech Stack:** NestJS + TypeORM(Postgres, server-main) / SQLite(server-agent)、socket.io、Zod + createZodDto、Next.js + jotai + next-intl、vitest/jest。

**依赖参考文件**：spec `docs/superpowers/specs/2026-06-16-phase2-private-channels-design.md`。

**关键既有签名（实现时对齐，勿改语义）：**
- `ConversationSummary`（`libs/types/src/im/im.schema.ts`）：`{ id, type, name, peer, unreadCount, lastMessage }`。
- `Conversation`（`libs/main/src/entities/conversation.entity.ts`）：`id/orgId/type/name/dmKey/createdBy/createdAt`。
- `ConversationMember`：`id/conversationId/userId/lastReadAt/joinedAt`，唯一索引 `(conversationId,userId)`。
- `MembershipService.isMember(orgId,userId): Promise<boolean>`、`listMembers(orgId): Promise<MemberSummary[]>`。
- `UserService.findById(id): Promise<{id,displayName,email,activeOrgId}|null>`（实现时按现有返回类型对齐）。
- `MainErrorCode`：已用到 2010；`CONVERSATION_FORBIDDEN(2008,403)`、`CONVERSATION_NOT_FOUND(2007)`。
- `IM_WS_EVENTS`：`message/presence/conversationCreated/send/read/ping`。

---

## Task 1: 共享 schema/类型扩展（libs/types）

**Files:**
- Modify: `libs/types/src/im/im.schema.ts`
- Modify: `libs/types/src/im/im.events.ts`

- [ ] **Step 1: 扩展 schema 与事件常量**

`im.schema.ts` —— 在文件相应位置修改/新增：

```ts
// ConversationSummary 增加 visibility（channel 才有意义；dm 恒为 "private" 占位也可，统一给值）
export interface ConversationSummary {
  id: string;
  type: ConversationType;
  visibility: "public" | "private"; // 新增：channel 的可见性；dm 取 "private"
  name: string | null;
  peer: ImPeer | null;
  unreadCount: number;
  lastMessage: { content: string; senderId: string; createdAt: string } | null;
}

// 频道成员（成员列表项）
export interface ChannelMember {
  userId: string;
  displayName: string;
  email: string;
}

// 建频道入参扩展：visibility + 私有时可选初始成员
export const CreateChannelSchema = z.object({
  name: z.string().min(1).max(64),
  visibility: z.enum(["public", "private"]).default("public"),
  memberIds: z.array(z.string()).optional(),
});
export type CreateChannelInput = z.infer<typeof CreateChannelSchema>;

// 拉人入参
export const AddChannelMemberSchema = z.object({ userId: z.string() });
export type AddChannelMemberInput = z.infer<typeof AddChannelMemberSchema>;
```

`im.events.ts` —— 在 `IM_WS_EVENTS` 对象内 server→client 段新增一行：

```ts
  conversationRemoved: "im.conversation_removed",
```

- [ ] **Step 2: 校验类型编译**

Run: `pnpm --filter @meshbot/types typecheck`
Expected: PASS（无报错）

- [ ] **Step 3: Commit**

```bash
git add libs/types/src/im/im.schema.ts libs/types/src/im/im.events.ts
git commit -m "feat(types): IM 私有频道 schema（visibility/memberIds/ChannelMember）+ conversationRemoved 事件"
```

---

## Task 2: DTO 类（libs/main）

**Files:**
- Modify: `libs/main/src/dto/index.ts`

`CreateChannelDto` 已 `extends createI18nZodDto(CreateChannelSchema)`，会自动带上新字段，无需改。仅新增 `AddChannelMemberDto`。

- [ ] **Step 1: 新增 AddChannelMemberDto**

在 `libs/main/src/dto/index.ts`（CreateDmDto 之后）追加，并确保顶部 import 含 `AddChannelMemberSchema` 与 `AddChannelMemberInput`：

```ts
export class AddChannelMemberDto extends createI18nZodDto(
  AddChannelMemberSchema,
) {}
export interface AddChannelMemberDto extends AddChannelMemberInput {}
```

import 行（与现有 CreateChannelSchema 同处）补：

```ts
import {
  AddChannelMemberSchema,
  CreateChannelSchema,
  CreateDmSchema,
  // ...existing
} from "@meshbot/types";
import type {
  AddChannelMemberInput,
  CreateChannelInput,
  CreateDmInput,
  // ...existing
} from "@meshbot/types";
```

- [ ] **Step 2: typecheck**

Run: `pnpm --filter @meshbot/main typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add libs/main/src/dto/index.ts
git commit -m "feat(main): AddChannelMemberDto"
```

---

## Task 3: 错误码 + i18n（libs/main + server-main i18n）

**Files:**
- Modify: `libs/main/src/errors/main.error-codes.ts`
- Modify: `apps/server-main/i18n/zh/im.json`
- Modify: `apps/server-main/i18n/en/im.json`

- [ ] **Step 1: 新增错误码 2011**

`main.error-codes.ts` 在 `DM_TARGET_INVALID` 之后、`})` 之前追加：

```ts
  CHANNEL_MEMBER_INVALID: {
    code: 2011,
    message: "im.channelMemberInvalid",
  },
```

- [ ] **Step 2: 补 i18n key**

`apps/server-main/i18n/zh/im.json` 在 `im` 对象内加：`"channelMemberInvalid": "目标用户不是本组织成员"`
`apps/server-main/i18n/en/im.json` 加：`"channelMemberInvalid": "Target user is not a member of this organization"`

- [ ] **Step 3: 跑错误码围栏**

Run: `pnpm check:error-code`
Expected: `DUPLICATE_CODE 0 / OUT_OF_RANGE 0 / GAP 0`，无新增 finding

- [ ] **Step 4: Commit**

```bash
git add libs/main/src/errors/main.error-codes.ts apps/server-main/i18n
git commit -m "feat(main): IM 错误码 2011 CHANNEL_MEMBER_INVALID + i18n"
```

---

## Task 4: DDL + Conversation 实体 visibility 列

**Files:**
- Create: `apps/server-main/migrations/202606161200-im-channel-visibility.sql`（时间戳按创建当时分钟）
- Modify: `libs/main/src/entities/conversation.entity.ts`

- [ ] **Step 1: 写 DDL 文件**

新文件内容：

```sql
-- =============================================================================
-- meshbot server-main IM 私有频道：conversation 增加 visibility 列
-- DBA 手动执行（psql -f）。幂等、不可变。
-- =============================================================================
ALTER TABLE "conversation"
  ADD COLUMN IF NOT EXISTS "visibility" varchar(16) NOT NULL DEFAULT 'public';
```

- [ ] **Step 2: 实体加 visibility 字段**

`conversation.entity.ts` 在 `createdBy` 列之后加：

```ts
  /** 'public'（组织级可见）| 'private'（仅成员可见）。dm 不参与判定。 */
  @Column({ type: "varchar", length: 16, default: "public" })
  visibility!: "public" | "private";
```

- [ ] **Step 3: 应用 DDL 到本地/远程 dev 库**

Run（连 server-main 实际使用的 Postgres）: `psql -h <host> -p 5432 -U <user> -d <db> -f apps/server-main/migrations/202606161200-im-channel-visibility.sql`
Expected: `ALTER TABLE`（重复执行也安全）

- [ ] **Step 4: typecheck**

Run: `pnpm --filter @meshbot/main typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server-main/migrations/202606161200-im-channel-visibility.sql libs/main/src/entities/conversation.entity.ts
git commit -m "feat(main): conversation 增加 visibility 列 + DDL（私有频道）"
```

---

## Task 5: ConversationService 可见性与成员逻辑（核心，TDD）

**Files:**
- Modify: `libs/main/src/services/conversation.service.ts`
- Test: `libs/main/src/services/conversation.service.spec.ts`（若不存在则创建；遵循 Jest）

> 说明：`persistChannelInTx` 现签名 `(orgId, name, createdBy)`，扩展为 `(orgId, name, createdBy, visibility, memberIds?)`。`toSummary` 返回值加 `visibility`。`getVisibleOrThrow` 增加 private 分支。新增 `addMember`/`leave`/`listMembers`（均单表写，不挂 @Transactional）。

- [ ] **Step 1: 写失败测试（私有可见性 + 成员操作）**

创建/追加 `conversation.service.spec.ts`（用内存替身 repo 风格或 DataSource 测试库；与现有 main spec 约定一致——若现有 spec 用 Test.createTestingModule + sqlite/pg-mem，沿用之）。核心断言：

```ts
// 伪代码骨架（按现有 spec 装配方式落地 repo/service）
describe("ConversationService 私有频道", () => {
  it("listConversations：成员能看到私有频道，非成员看不到", async () => {
    const ch = await svc.persistChannelInTx(orgId, "私有", creator, "private", [memberB]);
    const forCreator = await svc.listConversations(creator, orgId);
    const forMember = await svc.listConversations(memberB, orgId);
    const forOutsider = await svc.listConversations(outsiderC, orgId);
    expect(forCreator.map(c => c.id)).toContain(ch.id);
    expect(forMember.map(c => c.id)).toContain(ch.id);
    expect(forOutsider.map(c => c.id)).not.toContain(ch.id);
  });

  it("listConversations：公开频道对全组织可见", async () => {
    const ch = await svc.persistChannelInTx(orgId, "公开", creator, "public");
    const forOutsider = await svc.listConversations(outsiderC, orgId);
    expect(forOutsider.map(c => c.id)).toContain(ch.id);
  });

  it("getVisibleOrThrow：私有频道非成员抛 CONVERSATION_FORBIDDEN", async () => {
    const ch = await svc.persistChannelInTx(orgId, "私有", creator, "private", []);
    await expect(svc.getVisibleOrThrow(ch.id, outsiderC, orgId)).rejects.toMatchObject({ code: 2008 });
    await expect(svc.getVisibleOrThrow(ch.id, creator, orgId)).resolves.toBeDefined();
  });

  it("addMember：幂等；actor 非成员 forbidden；target 非组织成员 CHANNEL_MEMBER_INVALID", async () => {
    const ch = await svc.persistChannelInTx(orgId, "私有", creator, "private", []);
    await expect(svc.addMember(ch.id, outsiderC, memberB)).rejects.toMatchObject({ code: 2008 }); // actor 非成员
    await svc.addMember(ch.id, creator, memberB); // ok
    await svc.addMember(ch.id, creator, memberB); // 幂等：不抛
    await expect(svc.addMember(ch.id, creator, "non-org-user")).rejects.toMatchObject({ code: 2011 });
    const forB = await svc.listConversations(memberB, orgId);
    expect(forB.map(c => c.id)).toContain(ch.id);
  });

  it("leave：成员退出后不再可见；非成员/公开频道抛 forbidden", async () => {
    const ch = await svc.persistChannelInTx(orgId, "私有", creator, "private", [memberB]);
    await svc.leave(ch.id, memberB);
    const forB = await svc.listConversations(memberB, orgId);
    expect(forB.map(c => c.id)).not.toContain(ch.id);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @meshbot/main test -- conversation.service`
Expected: FAIL（方法签名不符 / 未实现 addMember 等）

- [ ] **Step 3: 实现 service 变更**

`conversation.service.ts`：

(a) `toSummary` 返回值加 `visibility`：

```ts
    return {
      id: conv.id,
      type: conv.type as ConversationType,
      visibility: (conv.visibility ?? "public") as "public" | "private",
      name: conv.name,
      peer,
      unreadCount,
      lastMessage: lastMsg
        ? { content: lastMsg.content, senderId: lastMsg.senderId, createdAt: lastMsg.createdAt.toISOString() }
        : null,
    };
```
（lastMessage 字段按现有 toSummary 现状照搬，仅插入 visibility 行。）

(b) `listConversations` 改为公开频道 ∪ 成员私有频道 ∪ 参与的 DM：

```ts
  async listConversations(userId: string, orgId: string): Promise<ConversationSummary[]> {
    await this.ensureDefaultChannel(orgId, userId);

    const publicChannels = await this.convRepo.find({
      where: { orgId, type: "channel", visibility: "public" },
    });

    // 用户的全部 member 行 → 私有频道 + DM 的会话 id
    const myMembers = await this.memberRepo.find({ where: { userId } });
    const myConvIds = myMembers.map((m) => m.conversationId);

    let memberConvs: Conversation[] = [];
    if (myConvIds.length > 0) {
      const candidates = await this.convRepo.find({ where: { orgId } });
      memberConvs = candidates.filter(
        (c) =>
          myConvIds.includes(c.id) &&
          (c.type === "dm" ||
            (c.type === "channel" && c.visibility === "private")),
      );
    }

    const allConvs = [...publicChannels, ...memberConvs];
    return Promise.all(allConvs.map((conv) => this.toSummary(conv, userId)));
  }
```

(c) `getVisibleOrThrow` 增加 private 分支（替换原 dm 分支块）：

```ts
    const requiresMembership =
      conv.type === "dm" ||
      (conv.type === "channel" && conv.visibility === "private");
    if (requiresMembership) {
      const member = await this.memberRepo.findOne({
        where: { conversationId, userId },
      });
      if (!member) throw new AppError(MainErrorCode.CONVERSATION_FORBIDDEN);
    }
    return conv;
```

(d) `persistChannelInTx` 扩展签名 + 写成员行：

```ts
  @Transactional()
  async persistChannelInTx(
    orgId: string,
    name: string,
    createdBy: string,
    visibility: "public" | "private" = "public",
    memberIds: string[] = [],
  ): Promise<ConversationSummary> {
    const conv = await this.convRepo.save(
      this.convRepo.create({ orgId, type: "channel", name, dmKey: null, createdBy, visibility }),
    );
    const memberRepo = this.convRepo.manager.getRepository(ConversationMember);
    // 私有：创建者 + 初始成员（过滤非本组织成员）；公开：仅创建者（沿用现状）
    let ids = [createdBy];
    if (visibility === "private" && memberIds.length > 0) {
      const valid = await Promise.all(
        memberIds.map(async (id) => ((await this.membershipMemberCheck(orgId, id)) ? id : null)),
      );
      ids = [...new Set([createdBy, ...valid.filter((x): x is string => !!x)])];
    }
    await memberRepo.save(ids.map((userId) => memberRepo.create({ conversationId: conv.id, userId, lastReadAt: null })));
    return this.toSummary(conv, createdBy);
  }
```
> `membershipMemberCheck` 需要 `MembershipService.isMember`。若 `ConversationService` 未注入 `MembershipService`，在构造函数注入它（libs/main 内同域，允许），并加私有方法：
> ```ts
> private membershipMemberCheck(orgId: string, userId: string): Promise<boolean> {
>   return this.membership.isMember(orgId, userId);
> }
> ```
> 注入示例：构造函数追加 `private readonly membership: MembershipService,`（import 自同 lib）。注意 check:repo —— MembershipService 不持有 Conversation Repo，仅注入 Service 合规。

(e) 新增 `addMember`（单表写、幂等）：

```ts
  /** 拉人：actor 必须是私有频道成员；target 必须是本组织成员；幂等。返回对 target 的 summary。 */
  async addMember(
    conversationId: string,
    actorUserId: string,
    targetUserId: string,
  ): Promise<{ summary: ConversationSummary; orgId: string }> {
    const conv = await this.convRepo.findOne({ where: { id: conversationId } });
    if (!conv) throw new AppError(MainErrorCode.CONVERSATION_NOT_FOUND);
    if (conv.type !== "channel" || conv.visibility !== "private") {
      throw new AppError(MainErrorCode.CONVERSATION_FORBIDDEN);
    }
    const actorMember = await this.memberRepo.findOne({
      where: { conversationId, userId: actorUserId },
    });
    if (!actorMember) throw new AppError(MainErrorCode.CONVERSATION_FORBIDDEN);
    const targetIsOrgMember = await this.membership.isMember(conv.orgId, targetUserId);
    if (!targetIsOrgMember) throw new AppError(MainErrorCode.CHANNEL_MEMBER_INVALID);

    await this.memberRepo.upsert(
      { conversationId, userId: targetUserId, lastReadAt: null },
      { conflictPaths: ["conversationId", "userId"] },
    );
    const summary = await this.toSummary(conv, targetUserId);
    return { summary, orgId: conv.orgId };
  }
```

(f) 新增 `leave`：

```ts
  /** 成员主动退出私有频道。 */
  async leave(conversationId: string, userId: string): Promise<{ orgId: string }> {
    const conv = await this.convRepo.findOne({ where: { id: conversationId } });
    if (!conv) throw new AppError(MainErrorCode.CONVERSATION_NOT_FOUND);
    if (conv.type !== "channel" || conv.visibility !== "private") {
      throw new AppError(MainErrorCode.CONVERSATION_FORBIDDEN);
    }
    const member = await this.memberRepo.findOne({ where: { conversationId, userId } });
    if (!member) throw new AppError(MainErrorCode.CONVERSATION_FORBIDDEN);
    await this.memberRepo.delete({ conversationId, userId });
    return { orgId: conv.orgId };
  }
```

(g) 新增 `listMembers`：

```ts
  /** 成员列表（调用者需可见该会话）。 */
  async listMembers(conversationId: string, userId: string, orgId: string): Promise<ChannelMember[]> {
    await this.getVisibleOrThrow(conversationId, userId, orgId);
    const members = await this.memberRepo.find({ where: { conversationId } });
    const out: ChannelMember[] = [];
    for (const m of members) {
      const u = await this.userService.findById(m.userId);
      if (u) out.push({ userId: u.id, displayName: u.displayName, email: u.email });
    }
    return out;
  }
```
> import：从 `@meshbot/types` 增补 `ChannelMember`、`ConversationType`（toSummary 已用）。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @meshbot/main test -- conversation.service`
Expected: PASS（全部用例绿）

- [ ] **Step 5: 跑围栏（tx/naming/lock-tx/repo）**

Run: `pnpm check:tx && pnpm check:naming && pnpm check:lock-tx && pnpm check:repo`
Expected: 各 0 finding（`addMember`/`leave`/`listMembers` 非 *InTx、无 @Transactional，单表写合规）

- [ ] **Step 6: Commit**

```bash
git add libs/main/src/services/conversation.service.ts libs/main/src/services/conversation.service.spec.ts
git commit -m "feat(main): ConversationService 私有频道可见性 + addMember/leave/listMembers（TDD）"
```

---

## Task 6: server-main ImController 端点

**Files:**
- Modify: `apps/server-main/src/rest/im.controller.ts`

- [ ] **Step 1: 扩展 createChannel + 新增成员端点**

`createChannel` 改为读 `dto.visibility`/`dto.memberIds`，并按可见性决定通知范围：

```ts
  @Post("channels")
  async createChannel(
    @CurrentUser() user: JwtMainPayload,
    @Body() dto: CreateChannelDto,
  ): Promise<ConversationSummary> {
    const orgId = await this.resolveOrgId(user.userId);
    const summary = await this.conversation.persistChannelInTx(
      orgId,
      dto.name,
      user.userId,
      dto.visibility,
      dto.memberIds ?? [],
    );
    const notifyUserIds =
      dto.visibility === "private"
        ? [...new Set([user.userId, ...(dto.memberIds ?? [])])]
        : (await this.membership.listMembers(orgId)).map((m) => m.userId);
    this.eventEmitter.emit(IM_WS_EVENTS.conversationCreated, {
      summary,
      userIds: notifyUserIds,
      orgId,
    });
    return summary;
  }
```

新增端点（class 内、`listMessages` 之后）：

```ts
  /** 拉人：把组织成员加入私有频道。 */
  @Post("channels/:id/members")
  async addMember(
    @CurrentUser() user: JwtMainPayload,
    @Param("id") id: string,
    @Body() dto: AddChannelMemberDto,
  ): Promise<ConversationSummary> {
    const { summary, orgId } = await this.conversation.addMember(id, user.userId, dto.userId);
    this.eventEmitter.emit(IM_WS_EVENTS.conversationCreated, {
      summary,
      userIds: [dto.userId],
      orgId,
    });
    return summary;
  }

  /** 退出私有频道（自身）。 */
  @Delete("channels/:id/members/me")
  async leave(
    @CurrentUser() user: JwtMainPayload,
    @Param("id") id: string,
  ): Promise<{ ok: true }> {
    const { orgId } = await this.conversation.leave(id, user.userId);
    this.eventEmitter.emit(IM_WS_EVENTS.conversationRemoved, {
      conversationId: id,
      userId: user.userId,
      orgId,
    });
    return { ok: true };
  }

  /** 频道成员列表。 */
  @Get("channels/:id/members")
  async listMembers(
    @CurrentUser() user: JwtMainPayload,
    @Param("id") id: string,
  ): Promise<ChannelMember[]> {
    const orgId = await this.resolveOrgId(user.userId);
    return this.conversation.listMembers(id, user.userId, orgId);
  }
```

import 增补：`Delete` from `@nestjs/common`；`AddChannelMemberDto` from `@meshbot/main`；`ChannelMember` from `@meshbot/types`；`IM_WS_EVENTS` 已 import。

- [ ] **Step 2: Swagger 声明**

为新端点补 `@ApiOperation`/`@ApiOkResponse` 等（与现有 ImController 端点同风格；若现有端点未用 Swagger 装饰器则跳过，遵循现状）。

- [ ] **Step 3: typecheck**

Run: `pnpm --filter @meshbot/server-main typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/server-main/src/rest/im.controller.ts
git commit -m "feat(server-main): ImController 私有频道建/拉人/退出/成员列表端点"
```

---

## Task 7: server-main ImGateway 退出离房

**Files:**
- Modify: `apps/server-main/src/ws/im.gateway.ts`

- [ ] **Step 1: 新增 conversationRemoved 处理**

class 内新增 `@OnEvent` handler（与 `onConversationCreated` 同构）：

```ts
  /** 成员退出私有频道：让其在线 socket 离开 conv 房间并下发移除通知。 */
  @OnEvent(IM_WS_EVENTS.conversationRemoved)
  async onConversationRemoved(payload: {
    conversationId: string;
    userId: string;
    orgId: string;
  }): Promise<void> {
    try {
      const { conversationId, userId, orgId } = payload;
      const sockets = await this.server.in(`org:${orgId}`).fetchSockets();
      for (const s of sockets) {
        if (s.data.user?.userId === userId) {
          s.leave(`conv:${conversationId}`);
          s.emit(IM_WS_EVENTS.conversationRemoved, { conversationId });
        }
      }
    } catch (err) {
      this.logger.error("im onConversationRemoved failed", err as Error);
    }
  }
```

- [ ] **Step 2: typecheck**

Run: `pnpm --filter @meshbot/server-main typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/server-main/src/ws/im.gateway.ts
git commit -m "feat(server-main): ImGateway conversationRemoved 退出离房 + 下发"
```

---

## Task 8: server-agent 代理 + relay 转发

**Files:**
- Modify: `apps/server-agent/src/services/cloud-im.service.ts`
- Modify: `apps/server-agent/src/controllers/cloud-im.controller.ts`
- Modify: `apps/server-agent/src/dto/im.dto.ts`
- Modify: `apps/server-agent/src/cloud/im-relay-client.service.ts`
- Modify: `apps/server-agent/src/ws/im.gateway.ts`

- [ ] **Step 1: DTO（server-agent 侧）**

`apps/server-agent/src/dto/im.dto.ts`：`CreateChannelDto` 复用共享 `CreateChannelSchema`（已含新字段，若是本地重定义则同步加 visibility/memberIds）；新增 `AddChannelMemberDto`（基于 `AddChannelMemberSchema`）。与现有 createZodDto 用法一致。

- [ ] **Step 2: CloudImService 增补代理方法**

`cloud-im.service.ts` class 内新增（沿用 `withToken`）：

```ts
  createChannel(name: string, visibility: "public" | "private", memberIds?: string[]): Promise<ConversationSummary> {
    return this.withToken((t) =>
      this.cloud.post<ConversationSummary>("/api/channels", { name, visibility, memberIds }, t),
    );
  }
  addChannelMember(conversationId: string, userId: string): Promise<ConversationSummary> {
    return this.withToken((t) =>
      this.cloud.post<ConversationSummary>(`/api/channels/${conversationId}/members`, { userId }, t),
    );
  }
  leaveChannel(conversationId: string): Promise<{ ok: true }> {
    return this.withToken((t) =>
      this.cloud.delete<{ ok: true }>(`/api/channels/${conversationId}/members/me`, t),
    );
  }
  listChannelMembers(conversationId: string): Promise<ChannelMember[]> {
    return this.withToken((t) =>
      this.cloud.get<ChannelMember[]>(`/api/channels/${conversationId}/members`, t),
    );
  }
```
> 现有 `createChannel(name)` 替换为带 visibility 版本。`CloudClientService` 若无 `delete<T>(path, token)` 方法，按其现有 get/post 模式补一个 `delete`（薄封装）。`ChannelMember` import 自 `@meshbot/types`。

- [ ] **Step 3: CloudImController 增补端点**

`cloud-im.controller.ts`：

```ts
  @Post("channels")
  createChannel(@Body() dto: CreateChannelDto): Promise<ConversationSummary> {
    return this.cloudIm.createChannel(dto.name, dto.visibility, dto.memberIds);
  }

  @Post("channels/:id/members")
  addMember(@Param("id") id: string, @Body() dto: AddChannelMemberDto): Promise<ConversationSummary> {
    return this.cloudIm.addChannelMember(id, dto.userId);
  }

  @Delete("channels/:id/members/me")
  leave(@Param("id") id: string): Promise<{ ok: true }> {
    return this.cloudIm.leaveChannel(id);
  }

  @Get("channels/:id/members")
  listMembers(@Param("id") id: string): Promise<ChannelMember[]> {
    return this.cloudIm.listChannelMembers(id);
  }
```
import 增补 `Delete`、`AddChannelMemberDto`、`ChannelMember`。

- [ ] **Step 4: relay 转发 conversationRemoved**

`im-relay-client.service.ts` 第 89-93 行的下行事件循环数组加入 `IM_WS_EVENTS.conversationRemoved`：

```ts
      for (const event of [
        IM_WS_EVENTS.message,
        IM_WS_EVENTS.presence,
        IM_WS_EVENTS.conversationCreated,
        IM_WS_EVENTS.conversationRemoved,
      ] as const) {
```

- [ ] **Step 5: 本地 ImGateway 广播 conversationRemoved**

`apps/server-agent/src/ws/im.gateway.ts` 新增（与 onConversationCreated 同构）：

```ts
  @OnEvent(IM_WS_EVENTS.conversationRemoved)
  onConversationRemoved(payload: { conversationId: string }): void {
    this.server.emit(IM_WS_EVENTS.conversationRemoved, payload);
  }
```

- [ ] **Step 6: typecheck**

Run: `pnpm --filter @meshbot/server-agent typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/server-agent/src/services/cloud-im.service.ts apps/server-agent/src/controllers/cloud-im.controller.ts apps/server-agent/src/dto/im.dto.ts apps/server-agent/src/cloud/im-relay-client.service.ts apps/server-agent/src/ws/im.gateway.ts
git commit -m "feat(server-agent): 私有频道代理（建/拉人/退出/成员）+ relay 转发 conversationRemoved"
```

---

## Task 9: server-main E2E（私有频道全链路）

**Files:**
- Modify/Create: `apps/server-main/test/e2e/im-private-channel.spec.ts`（参照 `im-flow.spec.ts` 装配，需 Postgres service）

- [ ] **Step 1: 写 E2E**

参照 `im-flow.spec.ts`（`createNestApplication` + `setGlobalPrefix("api")` + supertest）。流程：注册 A/B/C 三用户，A 建组织、邀请 B/C 加入；A `POST /api/channels {name, visibility:'private', memberIds:[B]}` → A、B `GET /api/conversations` 含该频道、C 不含；C `GET /api/conversations/:id/messages` → 403/forbidden envelope；A `POST /api/channels/:id/members {userId:C}` → C `GET /api/conversations` 含；C `DELETE /api/channels/:id/members/me` → C 不再含；负向：非成员 `addMember` → 2008，加非组织用户 → 2011。

- [ ] **Step 2: 跑 E2E**

Run: `pnpm --filter @meshbot/server-main test:e2e -- im-private-channel`（按现有 e2e 脚本名）
Expected: PASS（需本地/CI Postgres）

- [ ] **Step 3: Commit**

```bash
git add apps/server-main/test/e2e/im-private-channel.spec.ts
git commit -m "test(server-main): 私有频道 E2E（可见性/拉人/退出/负向）"
```

---

## Task 10: 前端 rest/im 扩展

**Files:**
- Modify: `apps/web-agent/src/rest/im.ts`

- [ ] **Step 1: 扩展 createChannel + 新增成员函数**

```ts
import type { ChannelMember, ConversationSummary, MessagePage } from "@meshbot/types";

export async function createChannel(
  name: string,
  visibility: "public" | "private" = "public",
  memberIds?: string[],
): Promise<ConversationSummary> {
  const { data } = await apiClient.post<ConversationSummary>("/api/channels", { name, visibility, memberIds });
  return data;
}

export async function addChannelMember(conversationId: string, userId: string): Promise<ConversationSummary> {
  const { data } = await apiClient.post<ConversationSummary>(`/api/channels/${conversationId}/members`, { userId });
  return data;
}

export async function leaveChannel(conversationId: string): Promise<void> {
  await apiClient.delete(`/api/channels/${conversationId}/members/me`);
}

export async function listChannelMembers(conversationId: string): Promise<ChannelMember[]> {
  const { data } = await apiClient.get<ChannelMember[]>(`/api/channels/${conversationId}/members`);
  return Array.isArray(data) ? data : [];
}
```

- [ ] **Step 2: typecheck**

Run: `pnpm --filter @meshbot/web-agent typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/web-agent/src/rest/im.ts
git commit -m "feat(web-agent): rest/im 私有频道接口（createChannel 扩展 + 成员增删查）"
```

---

## Task 11: 前端 atoms/socket 处理 conversationRemoved

**Files:**
- Modify: `apps/web-agent/src/lib/im-socket.ts`
- Modify: `apps/web-agent/src/atoms/im.ts`

- [ ] **Step 1: socket 监听 conversationRemoved**

在 `im-socket.ts` 现有 `socket.on(IM_WS_EVENTS.conversationCreated, ...)` 旁新增：

```ts
  socket.on(IM_WS_EVENTS.conversationRemoved, (payload: { conversationId: string }) => {
    // 调用 atom 的移除逻辑（与 conversationCreated 的新增对称）
    onConversationRemoved(payload.conversationId);
  });
```
> `onConversationRemoved` 为 atoms/im.ts 暴露的移除函数：从会话列表 atom 删除该 id；若当前选中会话即被移除，则清空选中（切回默认频道或空态）。按 atoms/im.ts 现有 conversationCreated 的写法对称实现。

- [ ] **Step 2: atoms 增加移除逻辑**

`atoms/im.ts`：参照新增会话的 atom 写法，新增"按 id 移除会话 + 复位选中"的 setter/action。

- [ ] **Step 3: typecheck + 手测**

Run: `pnpm --filter @meshbot/web-agent typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/web-agent/src/lib/im-socket.ts apps/web-agent/src/atoms/im.ts
git commit -m "feat(web-agent): 处理 conversationRemoved（退出后移除会话）"
```

---

## Task 12: 前端 建频道弹框（公开/私有 + 成员多选）

**Files:**
- Modify: `apps/web-agent/src/components/im/im-sidebar.tsx`（频道「+」建频道入口）
- 参考: `apps/web-agent/src/components/im/dm-picker.tsx`（组织成员选择 UI 模式）
- Modify: i18n `apps/web-agent/messages/{zh,en}.json`（或现有 next-intl 文案文件）

- [ ] **Step 1: 建频道弹框加公开/私有切换 + 私有成员多选**

在现有建频道交互（Enter 提交频道名）基础上扩展为弹框：频道名输入 + 公开/私有切换；选「私有」时展示组织成员多选（成员数据用 `fetchMembers(orgId)`，复用 dm-picker 的列表/勾选模式）。提交调用 `createChannel(name, visibility, selectedMemberIds)`。文案走 next-intl（新增 key：频道可见性、公开、私有、选择成员等）。

- [ ] **Step 2: typecheck + lint**

Run: `pnpm --filter @meshbot/web-agent typecheck && pnpm exec biome check apps/web-agent/src/components/im/im-sidebar.tsx`
Expected: PASS / clean

- [ ] **Step 3: Commit**

```bash
git add apps/web-agent/src/components/im/im-sidebar.tsx apps/web-agent/messages
git commit -m "feat(web-agent): 建频道弹框支持公开/私有 + 私有初始成员多选"
```

---

## Task 13: 前端 私有频道头部（成员 / 加成员 / 退出）

**Files:**
- Modify: `apps/web-agent/src/components/im/im-conversation-header.tsx`
- 参考: `dm-picker.tsx`

- [ ] **Step 1: 私有频道头加成员区与操作**

当 `conversation.type === "channel" && conversation.visibility === "private"` 时：头部显示成员数（`listChannelMembers`）、「加成员」按钮（弹出组织成员选择，排除已是成员者，选定后 `addChannelMember`）、「退出频道」按钮（`leaveChannel` → 成功后由 conversationRemoved 事件移除）。公开频道/ DM 不显示这些。文案走 next-intl。

- [ ] **Step 2: typecheck + lint**

Run: `pnpm --filter @meshbot/web-agent typecheck && pnpm exec biome check apps/web-agent/src/components/im/im-conversation-header.tsx`
Expected: PASS / clean

- [ ] **Step 3: Commit**

```bash
git add apps/web-agent/src/components/im/im-conversation-header.tsx apps/web-agent/messages
git commit -m "feat(web-agent): 私有频道头部成员管理（成员列表/加成员/退出）"
```

---

## Task 14: 全量围栏 + 类型 + 收尾验证

- [ ] **Step 1: 全包 typecheck**

Run: `pnpm typecheck`
Expected: PASS（全包）

- [ ] **Step 2: 静态围栏全套**

Run: `pnpm check`
Expected: 6 围栏全 0 新增 finding

- [ ] **Step 3: 相关单测/E2E**

Run: `pnpm --filter @meshbot/main test -- conversation.service`，并（有 Postgres 时）`pnpm --filter @meshbot/server-main test:e2e -- im-private-channel`
Expected: PASS

- [ ] **Step 4: 端到端手测（重启 server-main / server-agent 后）**

按 spec「12. 验收」走一遍：A 建私有频道含 B → A/B 可见、C 不可见；B 拉 C → C 实时出现；C 退出 → C 侧栏移除；公开频道不变。

- [ ] **Step 5: 最终 Commit / 准备 PR**

```bash
git add -A && git commit -m "chore(im): 私有频道收尾（围栏/类型/验收）" || echo "无额外改动"
```

---

## 自检记录（spec 覆盖）

- visibility 列 + 默认 public → Task 4 ✓
- 可见性判定（list/getVisible）→ Task 5 ✓
- 建私有频道 + 初始成员 → Task 5(persistChannelInTx) + Task 6(controller) + Task 12(UI) ✓
- 拉人（任意成员）→ Task 5(addMember) + Task 6 + Task 8(代理) + Task 13(UI) ✓
- 退出 → Task 5(leave) + Task 6 + Task 7(ws 离房) + Task 8(转发) + Task 11(前端移除) + Task 13(UI) ✓
- 成员列表 → Task 5(listMembers) + Task 6 + Task 8 + Task 13 ✓
- 错误码 2011 + 复用 2008 → Task 3 + Task 5 ✓
- conversationCreated 通知范围（私有仅成员）→ Task 6 ✓
- conversationRemoved 事件 → Task 1 + Task 7 + Task 8 ✓
- 公开频道/DM 不变 → Task 5（公开分支保留、dm 分支不变）✓
- 测试（单测 + E2E）→ Task 5 + Task 9 ✓
- 围栏/类型/i18n/Swagger → Task 3/6/14 ✓
