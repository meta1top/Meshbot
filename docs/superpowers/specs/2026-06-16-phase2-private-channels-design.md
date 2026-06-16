# Phase 2 增量设计：私有频道 + 成员管理（拉人 / 退出）

> 状态：已与产品对齐，待实施
> 日期：2026-06-16
> 依赖：Phase 2 IM 骨架（已完成）。完成后进入 Phase 3（Agent 感知消息）。

## 0. 背景与范围

当前 Phase 2 的频道是**组织级公开频道**：`conversation.type='channel'` 的会话对全组织成员自动可见、可发言（`listConversations` 按 `orgId` 取全部 channel；`getVisibleOrThrow` 对 channel 仅校验 org 匹配）。`conversation_member` 表已存在，目前用于 DM 成员关系与 `last_read_at`、以及频道创建者的记录。

本设计在不破坏公开频道的前提下，**新增「私有频道」**：仅被拉进来的成员可见、可发言，并提供成员管理（任意成员可拉人、成员可主动退出）。

### 做
- 频道区分**公开 / 私有**两种可见性。
- 私有频道：仅成员可见可发言，复用 `conversation_member` 做成员制。
- 创建私有频道时可选**初始成员**（创建者自动加入）。
- **拉人**：任意频道成员可添加组织内其他成员。
- **退出**：成员可主动退出私有频道。
- 前端：建频道弹框公开/私有切换 + 私有的初始成员多选；私有频道头部成员数 + 加成员 + 退出。

### 不做（YAGNI / 留后续）
- **移除其他成员**（踢人）：与「任意成员可拉人」组合语义混乱，本期不做（仅自我退出）。
- 频道改名 / 归档 / 删除。
- 频道角色（管理员/普通成员）：本期所有成员平权。
- 公开↔私有互转。
- DM 不变。

## 1. 已确认的产品决策

| 决策点 | 选择 |
|--------|------|
| 公开/私有 | **并存**：保留组织级公开频道，新增私有频道 |
| 拉人权限 | **任意频道成员**均可拉人（Slack 私有频道式） |
| 成员操作范围 | **加人 + 自我退出**（不做移除他人） |
| 创建方式 | 建私有频道时**可选初始成员**，创建者自动加入 |

## 2. 关键决策记录

| 决策 | 选择 | 理由 |
|------|------|------|
| 可见性表示 | `conversation` 新增 `visibility ('public'\|'private')` 列，默认 `'public'` | 改动最聚焦；老频道与默认「综合」频道默认 public，行为零变化；私有复用既有 `conversation_member` 表 |
| 成员存储 | 复用 `conversation_member`（已存在，含 `last_read_at`/`joined_at`） | 无需新表；与 DM 成员制同构 |
| 越权/非成员访问错误码 | 复用 `CONVERSATION_FORBIDDEN (2008, 403)` | 语义一致（不可访问该会话） |
| 拉的目标非组织成员 | 新增 `CHANNEL_MEMBER_INVALID (2011)` | 与 `DM_TARGET_INVALID` 区分（频道语境） |
| 拉人实时入房 | 复用现有 `conversationCreated` 事件机制 | server-main `onConversationCreated` 已能 `fetchSockets` + 让目标 socket `join(conv:id)` + 下发 |
| 退出实时离房 | 新增轻量下行事件 `im.conversation_removed` | 让退出者 socket `leave(conv:id)` + 前端侧栏移除；与现有下行事件同构 |

## 3. 数据模型（server-main / Postgres）

### 3.1 DDL（云端轨规范：新文件、幂等、不可变、DBA 手动执行）

新文件 `apps/server-main/migrations/202606161200-im-channel-visibility.sql`（时间戳=创建时刻，实施时按当时分钟命名）：

```sql
ALTER TABLE "conversation"
  ADD COLUMN IF NOT EXISTS "visibility" varchar(16) NOT NULL DEFAULT 'public';
```

- 现有所有频道、默认「综合」频道在迁移后均为 `public` → 行为不变。
- 不加数据库外键（逻辑外键，遵循现有约定）。

### 3.2 实体（libs/main）

`Conversation` 实体新增：

```ts
@Column({ type: "varchar", length: 16, default: "public" })
visibility!: "public" | "private";
```

- DM 行的 `visibility` 不参与判定（始终按 `type='dm'` 的成员制），写入默认 `'public'` 即可。

## 4. 可见性与成员逻辑（ConversationService，libs/main）

唯一持有 `Conversation` / `ConversationMember` Repository 的归属 Service，全部变更在此层。

- **`listConversations(userId, orgId)`**：
  - 公开频道：`{ orgId, type:'channel', visibility:'public' }`（组织级，现状）。
  - 私有频道：用户在 `conversation_member` 有行、且会话 `type='channel' AND visibility='private' AND orgId` 匹配。
  - DM：用户参与的 DM（现状）。
  - 三者并集 → `toSummary`。`ensureDefaultChannel` 仍保证一个 public「综合」。
- **`getVisibleOrThrow(conversationId, userId, orgId)`**：
  - `channel + public` → org 匹配即可（现状）。
  - `channel + private` → **必须有 `conversation_member` 行**，否则 `CONVERSATION_FORBIDDEN`。
  - `dm` → 必须有 member 行（现状不变）。
- **`persistChannelInTx(orgId, name, createdBy, visibility, memberIds)`**（扩展，`@Transactional`，跨表写）：
  - 建会话（带 `visibility`）。
  - `private`：写入 `[createdBy, ...memberIds]` 去重后的 member 行。
  - `public`：维持现状（仅创建者 member 行，用于 `last_read`）。
  - `memberIds` 中的非本组织成员**静默过滤**（不报错、不阻断创建）。
- **`addMember(conversationId, actorUserId, targetUserId)`**（新增）：
  - 校验会话存在、`type='channel' AND visibility='private'`、actor 与会话同组织。
  - 校验 actor 有 member 行（任意成员可拉人）；否则 `CONVERSATION_FORBIDDEN`。
  - 校验 target 是本组织成员（`MembershipService.isMember`）；否则 `CHANNEL_MEMBER_INVALID`。
  - upsert `conversation_member(conversationId, targetUserId)`（**单表写**，靠唯一索引 `idx_conversation_member_conv_user` 保证幂等；不挂 `@Transactional`、不用 `*InTx` 命名）。
  - 返回该会话对 target 的 `ConversationSummary`（供事件下发）。
- **`leave(conversationId, userId)`**（新增）：
  - 校验 `type='channel' AND visibility='private'` 且 userId 有 member 行；否则 `CONVERSATION_FORBIDDEN`。
  - 删除该 member 行（单表删，不需事务）。
- **`listMembers(conversationId, userId)`**（新增）：
  - 校验 userId 可见该会话（`getVisibleOrThrow`）。
  - 返回成员列表（`{ userId, displayName, email }`，经 `UserService` 组装）。

> 锁/事务：`addMember` / `leave` 均为单表写，靠唯一索引保证幂等，无需 `@Transactional` 或分布式锁。仅 `persistChannelInTx`（conversation + member 跨表写）保持 `@Transactional` + `*InTx` 命名（现状）。

## 5. API

### 5.1 server-main（全局 `api` 前缀；ImController = `@Controller()`）

- `POST /api/channels` —— 扩展 body：`{ name: string; visibility: 'public'|'private'; memberIds?: string[] }`。
  - `private` 时 `memberIds` 为初始成员（不含创建者，创建者自动加入）。
  - 建成后发 `conversationCreated`：public → 通知全组织成员（现状）；**private → 仅通知 `[createdBy, ...memberIds]`**。
- `POST /api/channels/:id/members` `{ userId }` —— 拉人。actor 取 JWT。建成后向 `userIds:[userId]` 发 `conversationCreated`。
- `DELETE /api/channels/:id/members/me` —— 退出。成功后向该用户发 `conversation_removed`。
- `GET /api/channels/:id/members` —— 成员列表（成员可见）。

### 5.2 server-agent 本地代理（薄代理，controller-thin）

`CloudImController` / `CloudImService` 增补转发：
- `POST /api/channels`（扩展 body）
- `POST /api/channels/:id/members`
- `DELETE /api/channels/:id/members/me`
- `GET /api/channels/:id/members`

均经 `CloudClientService` 带 `cloud_token` 转发到云端，沿用 `withToken` + 账号上下文。

## 6. 实时事件（ws）

### 6.1 server-main ImGateway
- **拉人 / 建私有频道**：复用现有 `@OnEvent(conversationCreated)` —— `fetchSockets('org:'+orgId)` 过滤 `userIds` → `s.join('conv:'+id)` + `s.emit(conversationCreated, summary)`。
- **退出**：新增 `im.conversation_removed` 下行。退出 handler 后：让该用户在线 socket `leave('conv:'+id)`，并 `emit(conversation_removed, { conversationId })`。

### 6.2 共享事件常量（libs/types `im.events.ts`）
`IM_WS_EVENTS` 新增：`conversationRemoved: "im.conversation_removed"`。

### 6.3 server-agent ImRelayClientService + ImGateway
- relay 下行监听集合新增 `conversationRemoved` → 经 EventEmitter2 转发。
- 本地 `ImGateway` 新增 `@OnEvent(conversationRemoved)` → `this.server.emit(conversationRemoved, payload)` 广播给本地浏览器（与现有 message/presence/conversationCreated 同构）。

## 7. 错误码（main 2000 段）

- 复用 `CONVERSATION_FORBIDDEN (2008, 403)`：非成员访问/操作私有频道、actor 非成员拉人。
- 新增 `CHANNEL_MEMBER_INVALID (2011)`：拉的 target 不是本组织成员。i18n key `im.channelMemberInvalid`（`apps/server-main/i18n/{zh,en}/im.json` 同步）；server-agent 侧若需透传，补 `apps/server-agent/i18n` 对应文案。

## 8. 共享数据模型（libs/types / libs/types-*）

- `ConversationSummary` 增加 `visibility: 'public'|'private'`（前端据此显示私有标记 / 成员入口）。
- `CreateChannelDto`（建频道）schema 扩展：`visibility`、可选 `memberIds: string[]`。
- 新增 `AddChannelMemberDto`：`{ userId: string }`。
- 新增成员列表项类型 `ChannelMember`：`{ userId; displayName?; email? }`。
- 跨域共享放 `libs/types`（IM schema 现位置）；后端用 `createZodDto` 转 DTO；`libs/types-*` 禁依赖 NestJS/TypeORM。

## 9. 前端（web-agent）

- **建频道弹框**（现 IM 侧栏「+」）：
  - 公开/私有切换。
  - 选「私有」时出现组织成员**多选**（来自 `GET /api/orgs/:id/members`）作初始成员；创建者隐含加入。
  - 表单走 `Form/FormItem` + `useSchema`（共享 Zod schema），文案走 next-intl。
- **频道头部 / 成员面板**（私有频道）：成员数 + 「加成员」选人器（拉人）+ 「退出频道」。公开频道不显示这些。
- **IM 数据层（atoms / im-socket / rest）**：
  - `rest/im`：新增 createChannel(扩展)、addMember、leaveChannel、listMembers。
  - socket：处理 `conversationCreated`（已有，新增频道入侧栏）+ 新增 `conversation_removed`（退出后从侧栏移除、若正打开则切走）。
- 私有频道在侧栏「频道」分组内，带锁/私有视觉标记。

## 10. 测试

- **server-main 单测（Jest）**：`ConversationService`
  - `listConversations`：非成员看不到私有频道、成员能看到、公开频道仍全员可见。
  - `getVisibleOrThrow`：私有频道非成员 → `CONVERSATION_FORBIDDEN`；成员 → 通过。
  - `persistChannelInTx`：私有写入创建者+初始成员 member 行；非组织成员 memberId 被过滤。
  - `addMember`：幂等；actor 非成员 → forbidden；target 非组织成员 → `CHANNEL_MEMBER_INVALID`。
  - `leave`：删除 member 行；非成员/公开频道 → forbidden。
- **server-main E2E（Postgres service）**：建私有频道（带初始成员）→ 成员可见 / 非成员不可见 → 拉非成员进来 → 可见且能收发消息 → 退出 → 不可见、消息广播不再到达。负向：非成员发消息 `CONVERSATION_FORBIDDEN`。
- **server-agent**：cloud-im 代理新端点的装配/转发单测（如有逻辑）。
- **静态围栏**：commit 前 `pnpm check` 全套（repo 归属 / tx 命名 / 锁-事务 / 死导出 / 错误码）+ Swagger DTO 声明 + i18n 无裸串。

## 11. 升级 / 兼容

- DDL 仅新增 `visibility` 列（默认 `'public'`），现有频道与默认频道行为不变；可见性逻辑对 `public` 等价于现状。
- 旧客户端不带 `visibility`/`memberIds` 调 `POST /api/channels` → 默认建公开频道（向后兼容）。
- DM 链路完全不变。

## 12. 验收

- 用户 A 建私有频道并选 B 为初始成员 → A、B 侧栏出现该频道、可收发；C（同组织非成员）看不到、发消息被拒。
- B 在频道内拉 C → C 实时收到 `conversationCreated`、侧栏出现、可收发。
- C 退出 → C 侧栏移除、不再收到该频道消息；A、B 不受影响。
- 公开频道行为与现状一致。
