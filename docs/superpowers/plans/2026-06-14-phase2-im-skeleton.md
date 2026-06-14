# Phase 2 IM 骨架 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在云端身份/组织之上建 Slack 式 IM 骨架：server-main 做消息中继（公共频道 + 1:1 私信 + 在线状态），server-agent 桥接（上云持久连接 + 转发浏览器 + 为 Phase 3 emit 收件流），web-agent 填充「消息」区。

**Architecture:** 方案 A 强制拓扑 —— 浏览器(本地 JWT)↔ server-agent ↔(cloud JWT)server-main。统一 conversation 模型（频道/私信同构）。实时走 socket.io（server-main 新 `ws/im` gateway + server-agent ImRelayClient/ImGateway），WS 为主发消息，REST 做列表/历史。Redis 可选（多副本扇出 + presence TTL，缺省回退单副本/内存）。

**Tech Stack:** NestJS、TypeORM(Postgres)、socket.io / socket.io-client、@nestjs/event-emitter、ioredis + @socket.io/redis-adapter、Zod + createZodDto、Next.js + jotai + react-query、next-intl。

---

## 关于测试与验证（先读）

- **后端（server-main / server-agent）走 TDD**：Service 先写失败单测 → 实现 → 通过（仓库现状：libs/main 的 OrgService 等已有单测）。命令：`pnpm jest <specPath>`（根 jest 配置；若某 spec 不在根 scope，按仓库实际 jest 配置调整）。server-main 全链路用既有 E2E（Postgres service），mirror Phase 1 的 org-flow e2e。
- **前端（web-agent）无单测设施**（仓库现状）：验证 = `pnpm --filter @meshbot/web-agent typecheck` + `pnpm --filter @meshbot/web-agent build` + 人工目测；新文案走 `sync:locales --write` 扁平 stub 工作流。
- **每个 task 提交前**：相关 `pnpm jest`/typecheck 通过 + `pnpm check`（6 围栏，尤其 repo 归属 / tx 命名 / 锁-事务 / 错误码）。commit 中文 conventional commits。已在分支 `feat/phase2-im-skeleton`。

## 跨层契约（一次定义，全程引用 —— 保证类型一致）

**实时事件与命名空间**（`libs/types/src/im`）：
```ts
export const IM_WS_NAMESPACE = "ws/im";
export const IM_WS_EVENTS = {
  // server → client（下行；server-agent EventEmitter2 上也用这套名）
  message: "im.message",
  presence: "im.presence",
  conversationCreated: "im.conversation_created",
  // client → server（上行）
  send: "im.send",
  read: "im.read",
} as const;
```

**数据 schema / 类型**（`libs/types/src/im`，Zod + z.infer）：
```ts
export type ConversationType = "channel" | "dm";

export const ImMessageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  senderId: z.string(),
  content: z.string(),
  createdAt: z.string(), // ISO
});
export type ImMessage = z.infer<typeof ImMessageSchema>;

export interface ImPeer { userId: string; displayName: string; email: string }

export interface ConversationSummary {
  id: string;
  type: ConversationType;
  name: string | null;            // 频道名；dm 为 null
  peer: ImPeer | null;            // dm 的对端；channel 为 null
  unreadCount: number;
  lastMessage: { content: string; senderId: string; createdAt: string } | null;
}

export interface PresenceState { userId: string; online: boolean }

// 上行入参
export const ImSendSchema = z.object({ conversationId: z.string(), content: z.string().min(1).max(8000) });
export type ImSendInput = z.infer<typeof ImSendSchema>;
export const ImReadSchema = z.object({ conversationId: z.string() });
export type ImReadInput = z.infer<typeof ImReadSchema>;

// REST 入参
export const CreateChannelSchema = z.object({ name: z.string().min(1).max(64) });
export type CreateChannelInput = z.infer<typeof CreateChannelSchema>;
export const CreateDmSchema = z.object({ userId: z.string() });
export type CreateDmInput = z.infer<typeof CreateDmSchema>;

// 下行事件 payload
export type ImMessageEvent = ImMessage;
export type ImPresenceEvent = PresenceState;
export type ImConversationCreatedEvent = ConversationSummary;
// 历史分页响应
export interface MessagePage { messages: ImMessage[]; hasMore: boolean }
```

**REST 路由**（server-main，且 server-agent 同名薄代理）：
- `GET /api/conversations` → `ConversationSummary[]`
- `POST /api/channels` `{name}` → `ConversationSummary`
- `POST /api/dms` `{userId}` → `ConversationSummary`
- `GET /api/conversations/:id/messages?before=<msgId>&limit=<n>` → `MessagePage`

**错误码**（`libs/main` main 段，2007 起）：`CONVERSATION_NOT_FOUND(2007)` / `CONVERSATION_FORBIDDEN(2008, httpStatus 403)` / `CHANNEL_NAME_INVALID(2009)` / `DM_TARGET_INVALID(2010)`。

---

## Phase A — libs/types/im（共享契约）

### Task A1: IM 类型与事件常量

**Files:**
- Create: `libs/types/src/im/im.schema.ts`（上方「数据 schema」+「上行/REST 入参」全部）
- Create: `libs/types/src/im/im.events.ts`（`IM_WS_NAMESPACE` + `IM_WS_EVENTS` + 下行 payload 类型 + `MessagePage`）
- Modify: `libs/types/src/index.ts`（re-export `./im/im.schema`、`./im/im.events`）

- [ ] **Step 1:** 按上方「跨层契约」逐字落两个文件 + index 导出。`z` 从 `zod` import。
- [ ] **Step 2:** Verify：`pnpm --filter @meshbot/types typecheck`（或 `pnpm typecheck`）→ 0 errors。
- [ ] **Step 3:** Commit：`git add libs/types/src/im libs/types/src/index.ts && git commit -m "feat(types): IM 共享 schema 与 ws 事件常量（conversation/message/presence）"`

> 这些类型被 server-main / server-agent / web-agent 三层 import，是全程类型一致的单一真相源。

---

## Phase B — server-main（云端中继）

参考既有：实体 mirror `libs/main/src/entities/membership.entity.ts`；Service（@Transactional + @WithLock + Repository 归属）mirror `libs/main/src/services/invitation.service.ts` 与 `org.service.ts`；Controller + DTO mirror `apps/server-main/src/rest/org.controller.ts`；WS gateway mirror `apps/server-main/src/ws/health.gateway.ts` + `libs/common/src/ws/base-gateway.ts`；DDL mirror `apps/server-main/migrations/202606130244-init-identity-and-org.sql`；错误码 mirror `libs/main/src/errors/main.error-codes.ts`。

### Task B1: 实体 + DDL

**Files:**
- Create: `libs/main/src/entities/conversation.entity.ts`（列见 spec §3：id/orgId/type/name/dmKey/createdBy/createdAt，`@Entity("conversation")`，SnakeNamingStrategy 自动 snake_case；无 DB 外键）
- Create: `libs/main/src/entities/conversation-member.entity.ts`（id/conversationId/userId/lastReadAt(nullable)/joinedAt）
- Create: `libs/main/src/entities/message.entity.ts`（id/conversationId/senderId/content(text)/createdAt）
- Create: `apps/server-main/migrations/<YYYYMMDDHHmm>-im-conversations.sql`（3 表 `CREATE TABLE IF NOT EXISTS` + 唯一索引 `(org_id, dm_key) WHERE type='dm'`、`(conversation_id, user_id)`；普通索引 `(org_id, type)`、`(conversation_id, created_at)`，幂等）

- [ ] **Step 1:** 写 3 个 entity（mirror membership.entity.ts 的装饰器风格；类型用 `varchar`/`text`/`timestamptz`/`uuid` 对应 column options）。
- [ ] **Step 2:** 写 DDL 文件（mirror Phase 1 init SQL 格式：snake_case 列、逻辑外键、`IF NOT EXISTS`）。大表索引此期数据量小，普通 `CREATE INDEX IF NOT EXISTS` 即可（线上才需 CONCURRENTLY 单独成文件，注释说明）。
- [ ] **Step 3:** Verify：`pnpm --filter @meshbot/main typecheck`（实体编译）；`pnpm check:repo`（实体归属此刻未注入，待 B3 Service）。
- [ ] **Step 4:** Commit：`git add libs/main/src/entities apps/server-main/migrations && git commit -m "feat(server-main): IM 会话/成员/消息 实体 + DDL 迁移"`

### Task B2: 错误码追加

**Files:**
- Modify: `libs/main/src/errors/main.error-codes.ts`（在 `defineErrorCode({...})` 内追加 2007–2010 四条，message 用 i18n key 如 `"im.conversationNotFound"` 等）

- [ ] **Step 1:** 追加 `CONVERSATION_NOT_FOUND(2007)` / `CONVERSATION_FORBIDDEN(2008, httpStatus:403)` / `CHANNEL_NAME_INVALID(2009)` / `DM_TARGET_INVALID(2010)`。
- [ ] **Step 2:** Verify：`pnpm check:error-code` → 无重复/越界/断号。
- [ ] **Step 3:** Commit：`git add libs/main/src/errors/main.error-codes.ts && git commit -m "feat(server-main): IM 错误码 2007-2010"`

### Task B3: ConversationService（TDD）—— 建频道 / DM find-or-create / 默认频道 / 列表

**Files:**
- Create: `libs/main/src/services/conversation.service.ts`（唯一持有 `@InjectRepository(Conversation)` + `@InjectRepository(ConversationMember)`；跨表写挂 `@Transactional()` 且私有方法名 `persist*`/`*InTx`；DM 去重与默认频道用 `@WithLock`，**锁在事务外层**）
- Test: `libs/main/src/services/conversation.service.spec.ts`

方法签名（被 controller/gateway 调用）：
```ts
listConversations(userId: string, orgId: string): Promise<ConversationSummary[]>   // 含懒建默认频道 + 未读 + lastMessage（unread/lastMessage 可委托 MessageService，见 B4）
persistChannelInTx(orgId: string, name: string, createdBy: string): Promise<ConversationSummary>  // @Transactional：插 conversation + creator member 行
findOrCreateDm(orgId: string, a: string, b: string): Promise<ConversationSummary>  // @WithLock(dmKey)：按 (org,dmKey) upsert，插 2 条 member 行
getVisibleOrThrow(conversationId: string, userId: string, orgId: string): Promise<Conversation>  // 频道按 org，dm 按 member；否则 CONVERSATION_NOT_FOUND/FORBIDDEN
ensureDefaultChannelInTx(orgId: string, userId: string): Promise<void>  // @WithLock(org)：无频道则建「综合」
markRead(conversationId: string, userId: string): Promise<void>  // upsert conversation_member.last_read_at = now（单表 upsert，无需事务）
```

- [ ] **Step 1: 写失败单测** —— 覆盖：建频道返回 type=channel；DM find-or-create 同两人二次调用返回同一 id（去重）；DM dmKey 排序无关（a,b 与 b,a 同一会话）；getVisibleOrThrow 对非成员 dm 抛 CONVERSATION_FORBIDDEN；默认频道懒建（空组织 listConversations 含「综合」）。用内存/sqlite test datasource 或 mock repo（mirror invitation.service.spec.ts 的测试风格）。
- [ ] **Step 2:** Run `pnpm jest libs/main/src/services/conversation.service.spec.ts` → FAIL（类未实现）。
- [ ] **Step 3: 实现** ConversationService（dmKey = `[a,b].sort().join(":")`；`@WithLock` 装饰器 mirror invitation.service.ts；`@Transactional` 私有方法命名 `persist*`/`*InTx`）。
- [ ] **Step 4:** Run 单测 → PASS。
- [ ] **Step 5:** Verify `pnpm check:repo`（Conversation/ConversationMember 唯一归属本 Service）+ `pnpm check:tx` + `pnpm check:naming` + `pnpm check:lock-tx`。
- [ ] **Step 6:** Commit。

### Task B4: MessageService（TDD）—— 落库 / 历史分页 / 未读

**Files:**
- Create: `libs/main/src/services/message.service.ts`（唯一持有 `@InjectRepository(Message)`；读 conversation_member 的 last_read 经 ConversationService 或注入只读——遵守归属：last_read 的写在 ConversationService，未读统计 MessageService 只读 message 表）
- Test: `libs/main/src/services/message.service.spec.ts`

方法：
```ts
persistMessage(conversationId: string, senderId: string, content: string): Promise<ImMessage>  // 单表写，无需 @Transactional
listMessages(conversationId: string, before: string | undefined, limit: number): Promise<MessagePage>  // 按 created_at desc 游标分页，返回时正序
unreadCount(conversationId: string, lastReadAt: Date | null): Promise<number>
lastMessage(conversationId: string): Promise<ImMessage | null>
```

- [ ] **Step 1:** 失败单测：persistMessage 返回带 id/createdAt；listMessages 游标分页（before 之前的 limit 条 + hasMore）；unreadCount(lastReadAt=null)=全部、=某时刻只数之后的。
- [ ] **Step 2:** FAIL。
- [ ] **Step 3:** 实现（QueryBuilder where created_at < before、order desc、take limit+1 判 hasMore，结果 reverse 成正序）。
- [ ] **Step 4:** PASS。
- [ ] **Step 5:** `pnpm check:repo`（Message 唯一归属）。
- [ ] **Step 6:** Commit。

### Task B5: PresenceService —— Redis TTL（含内存回退）

**Files:**
- Create: `libs/main/src/services/presence.service.ts`（注入可选 Redis client token；缺省内存 Map）
- Test: `libs/main/src/services/presence.service.spec.ts`

方法：
```ts
setOnline(orgId: string, userId: string): Promise<void>   // Redis SET presence:<org>:<uid> EX 45；内存：Map + 定时清
setOffline(orgId: string, userId: string): Promise<void>
heartbeat(orgId: string, userId: string): Promise<void>   // 续期 TTL
listOnline(orgId: string): Promise<string[]>              // 在线 userId 列表
```

- [ ] **Step 1:** 失败单测：setOnline→listOnline 含该用户；setOffline→不含；内存回退路径（无 Redis）也通过（用 fake timers 验 TTL 行为可选）。
- [ ] **Step 2:** FAIL。
- [ ] **Step 3:** 实现（Redis 在场用 SET EX + SCAN/集合；缺省内存 Map<org, Map<uid, expiresAt>>）。Redis client 注入沿用 server-main 既有 `REDIS_CLIENT` token（见 app.module.ts buildRedis），可为 null。
- [ ] **Step 4:** PASS。
- [ ] **Step 5:** Commit。

### Task B6: ws/im gateway（server-main）

**Files:**
- Create: `apps/server-main/src/ws/im.gateway.ts`（mirror health.gateway.ts：extends BaseWebSocketGateway，`@WebSocketGateway({namespace: IM_WS_NAMESPACE, cors:true})`，`jwtVerify` 用 jwt-main `JwtService`）

职责：
- `handleConnection`：调 `super.handleConnection`；鉴权成功（socket.data.user={userId,email}）后异步 join 房间（`org:<orgId>` + 该用户可见会话 `conv:<id>`，orgId 从 user 的 active org 取——经注入服务查 membership/activeOrg）+ `presence.setOnline` + 广播 `presence` 到 `org:<orgId>` + 回推在线快照。
- `@SubscribeMessage(IM_WS_EVENTS.send)`（`@UseGuards(WsAuthGuard)`）：校验可见性 → `message.persistMessage` → `server.to(conv:<id>).emit(IM_WS_EVENTS.message, msg)`。
- `@SubscribeMessage(IM_WS_EVENTS.read)`：`conversation.markRead(conversationId, userId)`。
- `@OnEvent(IM_WS_EVENTS.conversationCreated)`：REST 建频道/私信时 ImController 在 EventEmitter2 上 emit 此事件（payload=ConversationSummary + 目标 userIds）→ 本 handler `server.to(org:<orgId>).emit(IM_WS_EVENTS.conversationCreated, summary)`，并把相关在线连接 join 进新房间 `conv:<id>`（mirror session gateway 的 @OnEvent 转发模式）。
- `handleDisconnect`：`presence.setOffline` + 广播。
- 定时 ping → `presence.heartbeat`（或在 send/read 时续期；最简：socket.io 内建 ping 周期触发 heartbeat —— 用 `@SubscribeMessage("im.ping")` 客户端 20s 心跳续期，或服务端 setInterval 对在线连接续期）。

- [ ] **Step 1:** 写 gateway（join 房间的 orgId/可见会话经注入 ConversationService 查）。在线快照 + presence 广播 mirror 「session gateway @OnEvent → server.to(room).emit」模式。
- [ ] **Step 2:** Verify `pnpm --filter @meshbot/server-main typecheck`。
- [ ] **Step 3:** `pnpm check:repo`（gateway 不直接注入 Repository，只经 Service）。
- [ ] **Step 4:** Commit。

### Task B7: ImController（REST）+ DTO

**Files:**
- Create: `apps/server-main/src/rest/im.controller.ts`（mirror org.controller.ts：`@UseGuards` 隐含全局 jwt-main，`@CurrentUser()` 取 userId，调 Service，返回 data 由 ResponseInterceptor 包信封）
- Create: DTO via `createZodDto`（`CreateChannelDto extends createZodDto(CreateChannelSchema)` 等，放 `libs/main/src/dto` 或 controller 同目录，mirror 现有 org dto）

路由实现：`GET /api/conversations` → `conversation.listConversations(userId, activeOrgId)`；`POST /api/channels` → `persistChannelInTx`；`POST /api/dms` → `findOrCreateDm`；`GET /api/conversations/:id/messages` → `getVisibleOrThrow` + `message.listMessages`。activeOrgId 从 `app_user.active_org_id`（注入 UserService/直接查）。**建频道/私信成功后** controller 在 EventEmitter2 上 `emit(IM_WS_EVENTS.conversationCreated, {summary, userIds})` → 由 ImGateway 的 @OnEvent 转发到 `org:<orgId>` 房间（不在 controller 直接持有 socket server，保持 controller-thin + 解耦）。

- [ ] **Step 1:** 写 controller + DTO（controller-thin：逻辑在 Service；swagger 声明输入输出类型）。
- [ ] **Step 2:** Verify typecheck + `pnpm check:repo`（controller 不注入 Repo）+ swagger 围栏（若有）。
- [ ] **Step 3:** Commit。

### Task B8: 模块接线 + socket.io Redis adapter

**Files:**
- Modify: `apps/server-main/src/app.module.ts`（注册 ImController、ImGateway、provide ConversationService/MessageService/PresenceService —— 经 `MainModule` 导出；mirror Phase 1 service 导出方式）
- Modify: `libs/main/src/main.module.ts`（导出 3 个新 Service）
- Modify: server-main socket.io 适配器接线：Redis 在场用 `@socket.io/redis-adapter`（在 NestFactory 的 IoAdapter 或 gateway afterInit 接 `server.adapter(createAdapter(pub, sub))`）；缺省默认 in-memory adapter。

- [ ] **Step 1:** 接线模块 + Redis adapter（pub/sub = 复用 REDIS_CLIENT 的两个连接；缺省跳过）。
- [ ] **Step 2:** Verify typecheck + `pnpm check`（全 6 围栏）+ 启动 `pnpm dev:server-main` 确认无报错（gateway 注册、/ws/im 可连）。
- [ ] **Step 3:** Commit。

### Task B9: server-main E2E

**Files:**
- Create: `apps/server-main/test/im.e2e-spec.ts`（mirror 现有 org-flow e2e；Postgres service）

- [ ] **Step 1:** E2E：注册 A、B 同组织 → A `POST /api/channels` → A/B `GET /api/conversations` 含该频道 → A WS `im.send` → B WS 收 `im.message`；A `POST /api/dms {B}` 两次 → 同一会话 id；越权读他人 dm → CONVERSATION_FORBIDDEN；presence：A 连 → B 收 `presence{A,online}`，A 断 → offline。
- [ ] **Step 2:** Run E2E（mirror 仓库 e2e 启动命令）→ PASS。
- [ ] **Step 3:** Commit。

---

## Phase C — server-agent（桥）

参考既有：`apps/server-agent/src/cloud/cloud-client.service.ts`（token/401/useFactory）；`apps/server-agent/src/ws/session.gateway.ts`（本地 gateway + @OnEvent 转发）；`apps/server-agent/src/services/cloud-identity.service.ts`（取 cloudToken/orgId）；本地 auth 代理 controller（薄代理 mirror）。

### Task C1: ImRelayClientService（TDD）—— 上云持久 socket

**Files:**
- Create: `apps/server-agent/src/cloud/im-relay-client.service.ts`
- Test: `apps/server-agent/src/cloud/im-relay-client.service.spec.ts`

职责（mirror CloudClient 的 token/401 语义，但用 socket.io-client）：
- `connect()`：用 `socket.io-client` 连 `<cloudWsUrl>/ws/im`，`auth:{token: cloudToken}`（从 `CloudIdentityService.get()`）。登录且有 activeOrg 时连；断线重连（socket.io 内建 + 退避）；`connect_error`/收到 401 语义 → 调与 CloudClient 一致的 `onUnauthorized`（清 cloud_identity）。
- 监听下行 `IM_WS_EVENTS.message|presence|conversationCreated` → `this.emitter.emit(IM_WS_EVENTS.x, payload)`（EventEmitter2）。
- `send(input: ImSendInput)` / `read(input: ImReadInput)`：socket.emit 上行；未连接 → 抛本地错误（如新增 agent 段 `IM_NOT_CONNECTED`）。
- `isConnected()`。

- [ ] **Step 1:** 失败单测：注入 socket 桩（fake socket emitter），验：连接时带 token；收 message 事件→emitter.emit 被调用且 payload 透传；send 未连接抛错；401/connect_error→onUnauthorized 调用。
- [ ] **Step 2:** FAIL。
- [ ] **Step 3:** 实现（socket.io-client 可注入便于测试；EventEmitter2 注入）。新增 agent 错误码 `IM_NOT_CONNECTED`（agent 3000 段，`pnpm check:error-code` 取下一可用号）。
- [ ] **Step 4:** PASS。
- [ ] **Step 5:** Commit。

### Task C2: ImGateway（本地，转发浏览器）

**Files:**
- Create: `apps/server-agent/src/ws/im.gateway.ts`（mirror session.gateway.ts：extends BaseWebSocketGateway，`@WebSocketGateway({namespace: IM_WS_NAMESPACE, cors:true})`，本地 `JwtService` verify 本地 JWT）

职责：
- `@OnEvent(IM_WS_EVENTS.message)` → `server.to(<conversationId>).emit(IM_WS_EVENTS.message, payload)`；`presence`/`conversationCreated` 同理（presence/conversationCreated 走 namespace 广播或全局，本地单用户可全广播）。
- `@SubscribeMessage(IM_WS_EVENTS.send/read)`（`@UseGuards(WsAuthGuard)`）→ 调 `imRelay.send/read`。
- `@SubscribeMessage("im.subscribe")`：client.join(conversationId)（仿 session subscribe 房间模型）。

- [ ] **Step 1:** 写 gateway。
- [ ] **Step 2:** Verify typecheck + `pnpm check:repo`。
- [ ] **Step 3:** Commit。

### Task C3: 本地 REST 代理 + 模块接线

**Files:**
- Create: `apps/server-agent/src/rest/im.controller.ts`（薄代理：`GET /api/conversations`、`POST /api/channels`、`POST /api/dms`、`GET /api/conversations/:id/messages` → CloudClient 转发，带 cloud_identity.cloudToken）
- Modify: server-agent 模块（注册 ImRelayClientService(useFactory 取 ws url)/ImGateway/ImController；登录成功 + 启动时触发 ImRelay.connect，登出时 disconnect —— hook 进现有 CloudAuthService.login/logout）
- Modify: `apps/server-agent` 配置：新增 `MESHBOT_CLOUD_WS_URL`（默认由 `MESHBOT_CLOUD_URL` 推导）

- [ ] **Step 1:** 写代理 controller（controller-thin）+ 接线 + 在 CloudAuthService.login 成功后 `imRelay.connect()`、logout 时 `imRelay.disconnect()`。
- [ ] **Step 2:** Verify typecheck + `pnpm check` 全套；`pnpm jest apps/server-agent/...`（C1 单测）通过。
- [ ] **Step 3:** Commit。

---

## Phase D — web-agent（消息区）

参考既有：`apps/web-agent/src/lib/socket.ts`（本地 socket 连接）；`apps/web-agent/src/atoms/sessions.ts`（atom 模式）；`apps/web-agent/src/rest/session.ts`（rest 模式）；`message-list.tsx` / `chat-input.tsx`（复用/参考）；Slack 外壳 `assistant-sidebar.tsx`（侧栏样式参考）。

### Task D1: IM socket 客户端 + rest + atoms

**Files:**
- Create: `apps/web-agent/src/lib/im-socket.ts`（mirror socket.ts：连 `<base>/ws/im`，本地 JWT；导出 getImSocket()）
- Create: `apps/web-agent/src/rest/im.ts`（`fetchConversations()`、`createChannel(name)`、`createDm(userId)`、`fetchMessages(conversationId, before?)` → 本地代理）
- Create: `apps/web-agent/src/atoms/im.ts`（conversationsAtom、currentConversationAtom、messagesAtom、presenceAtom、unread 派生；load/append/markRead actions）

- [ ] **Step 1:** 写三文件（类型从 `@meshbot/types` im 导入）。
- [ ] **Step 2:** Verify `pnpm --filter @meshbot/web-agent typecheck`。
- [ ] **Step 3:** Commit。

### Task D2: ImMessageList 组件

**Files:**
- Create: `apps/web-agent/src/components/im/im-message-list.tsx`（Slack 行式：每条按 `senderId` 显头像+名字+时间戳+文本；名字/头像从组织成员名录解析；无 reasoning/工具/流式）

- [ ] **Step 1:** 写组件（复用 message-list 的 Slack 行视觉；sender 名经传入的成员 map 解析）。
- [ ] **Step 2:** typecheck。
- [ ] **Step 3:** Commit。

### Task D3: IM 侧栏 + 会话头 + DM 选人

**Files:**
- Create: `apps/web-agent/src/components/im/im-sidebar.tsx`（频道段 + 私信段 + presence 点 + 未读徽标 + 「+」建频道/发起私信）
- Create: `apps/web-agent/src/components/im/im-conversation-header.tsx`（频道名/对端名 + presence）
- Create: `apps/web-agent/src/components/im/dm-picker.tsx`（组织成员名录选人发起 DM）
- Modify: `apps/web-agent/src/components/layouts/app-shell-layout.tsx`（messages 区的 autoSidebar 由 PlaceholderSidebar 换成 `<ImSidebar/>`）

- [ ] **Step 1:** 写三组件 + 把 messages 区侧栏接成 ImSidebar。
- [ ] **Step 2:** typecheck。
- [ ] **Step 3:** Commit。

### Task D4: /messages 页（填充占位）+ i18n

**Files:**
- Modify: `apps/web-agent/src/app/messages/page.tsx`（替换 AreaPlaceholder：读 `?id=` 选会话；渲染 ImConversationHeader + ImMessageList + 复用 ChatInput；订阅 im-socket 收 `message`/`presence`；空态引导）
- Modify: `apps/web-agent/messages/{en,zh}.json`（新增 `messages` 命名空间 key：频道/私信/在线/离线/发消息/新建频道/发起私信/空态等）

- [ ] **Step 1:** 写页面（仿 session/page.tsx 的 socket 订阅 + 乐观发送 + 历史分页结构；ChatInput 复用，隐藏 token 环/模型 chip）。
- [ ] **Step 2:** i18n：`pnpm sync:locales -- --write` 后 `--check` 通过。
- [ ] **Step 3:** Verify `pnpm --filter @meshbot/web-agent typecheck` + `pnpm --filter @meshbot/web-agent build`。
- [ ] **Step 4:** Commit。

---

## Phase E — 集成验证

### Task E1: 三层联调 + 全量围栏

- [ ] **Step 1:** `pnpm check`（6 围栏全过）+ `pnpm typecheck`（全包）+ `pnpm --filter @meshbot/web-agent build` + `pnpm --filter @meshbot/server-main build` + server-agent build。
- [ ] **Step 2:** 人工联调（需本地起 server-main + Postgres + server-agent + web-agent）：登录两个账号同组织 → 一方发频道消息另一方实时收到 → 私信 → presence 上下线点。无环境则记录为待联调项。
- [ ] **Step 3:** 自检对照 spec §1 范围与 §11 文件落点，确认无遗漏。

---

## 风险与备注

- **socket.io-client 依赖**：server-agent 需加 `socket.io-client`，server-main 需 `@socket.io/redis-adapter`（Redis 在场才用）。装包走 pnpm workspace。
- **presence 心跳**：最简实现可服务端对在线连接 setInterval 续期 TTL；若加客户端 `im.ping`，server-agent↔server-main 这一连接负责，浏览器不额外心跳上云。
- **activeOrgId 来源**：server-main gateway/controller 取 `app_user.active_org_id`（注入 UserService 只读）。
- **未读定义**：`unreadCount` = conversation_member.last_read_at 之后的 message 数；无 member 行（频道从未打开）按全部未读或某基线，实现时统一并在 ConversationService 注释说明。
- **Phase 3 钩子**：本期只保证 `IM_WS_EVENTS.message` 在 server-agent EventEmitter2 上被 emit，不加 Agent 监听器。
- **DDL 手动执行**：server-main 不自动建表，新迁移文件需 DBA/开发手动 `psql -f`，联调前先执行。
