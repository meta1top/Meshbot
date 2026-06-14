# Phase 2 设计：IM 骨架（云端消息中继 + 频道/私信 + 在线状态）

> 状态：已与产品对齐，待 review → 进 plan
> 日期：2026-06-14
> 上游：[Phase 1 云端身份 + 企业/组织](2026-06-11-phase1-cloud-identity-org-design.md)（已实现并合入 main）

## 0. 背景与定位

5 阶段总规划见 Phase 1 文档 §0。本阶段是 **Phase 2：IM 骨架**——在云端身份/组织之上建 Slack 式实时消息，并让本地 Agent 订阅收件流（为 Phase 3「Agent 感知消息出建议」铺垫）。

**架构红线（不变）**：server-main 只做身份、中继与协同元数据，**不跑 Agent 逻辑**。

**Phase 1 决定的拓扑约束（方案 A）**：server-agent 是唯一云端客户端，持有 cloud token；**cloud token 永不进浏览器**。因此 IM 实时链路被强制为：

```
浏览器 web-agent ──本地 socket.io(本地 JWT)──┐
                                              ▼
server-agent（本地，桥）
  • ImRelayClient：持久 socket.io-client → server-main（cloud JWT 握手）
  • 订阅活跃组织的会话流；inbound → EventEmitter2(IM_EVENTS)
        ├─► 转发浏览器（IM 界面）
        └─► 留给 Phase 3 本地 Agent 监听（本期建流不消费）
  • outbound：浏览器发消息 → 本地 socket → ImRelayClient → server-main
                                              ▲
            ──云端 socket.io(cloud JWT)───────┘
server-main（云端中继）
  • ws/im gateway：房间 conv:<id> / org:<id>；presence 广播
  • Postgres：conversation / conversation_member / message
  • Redis：socket.io adapter（多副本扇出）+ presence TTL（均可选，缺省单副本/内存）
  • REST：会话列表 + 历史分页 + 建频道 / 建私信
```

## 1. 范围

### 做
1. **统一会话模型**：公共频道（组织内全员可见可发）+ 1:1 私信。
2. **云端消息中继**：server-main 持久化 + 实时扇出消息，新增 `ws/im` gateway。
3. **在线状态**：由 server-agent↔server-main 连接生命周期驱动（连上=在线），online/offline 二态，按组织广播。
4. **server-agent 桥**：ImRelayClient（上云持久连接）+ ImGateway（转发浏览器）+ inbound emit 到 EventEmitter2（Phase 3 钩子）+ 薄 REST 代理。
5. **web-agent IM 界面**：填充已建好的「消息」区——频道/私信侧栏 + 会话视图 + 纯文本输入 + presence + 未读。
6. **消息特性**：纯文本、历史分页、未读计数、在线状态点。

### 不做（留后续阶段）
- 私有频道、群聊私信（统一模型已为其预留，本期不实现）。
- typing 指示、已读回执、表情、消息编辑/删除、附件、线程回复、@提醒、搜索。
- 本地 Agent **消费** IM 流（Phase 3）；任务面板（Phase 4/5）。
- 跨组织消息：私信/频道均限活跃组织内。
- 消息端到端加密、撤回、离线推送。

## 2. 关键决策记录

| 决策 | 选择 | 理由 |
|------|------|------|
| 会话建模 | **统一 conversation（type=channel/dm）** + conversation_member + message | 一套 message/未读/历史逻辑；未来私有频道/群聊=加成员行，零迁移 |
| 实时传输 | server-agent 持久 socket.io-client 上云 + 本地 socket 转发浏览器 | 方案 A 强制（cloud token 不进浏览器）；复用 server-main 已有 `BaseWebSocketGateway`+WS JWT 中间件 |
| 发消息路径 | **WS 为主**（`im.send` 由 server-main 落库 + 扇出）；REST 只做列表/历史/建会话 | 实时优先；单写入口 |
| 多副本扇出 | Redis 在场用 socket.io Redis adapter，缺省单副本 in-process | 沿用现有「Redis 可选回退」模式，不新增硬依赖 |
| 在线状态 | 连接生命周期驱动 + Redis TTL（缺省内存）；online/offline | server-agent↔server-main 一连接=一用户在线信号，天然 presence，无需浏览器额外心跳上云 |
| IM 类型/事件位置 | `libs/types`（跨域） | 三层（main/agent/web）共用同一套 payload |
| 默认频道 | 组织首次拉会话列表且无频道时懒建「综合」（`@WithLock` 按 org） | 自包含于 Phase 2，不改 Phase 1 org 创建流 |
| Agent 订阅 | inbound emit 到 server-agent EventEmitter2 | Phase 3 监听点；Phase 2 只建流 |

## 3. 数据模型（server-main / Postgres）

Entity + 归属 Service 放 `libs/main`，Zod schema/类型放 `libs/types`（跨域）。迁移遵守云端轨规范：幂等 SQL（`IF NOT EXISTS`）+ 索引 `CONCURRENTLY` 单独成文件 + snake_case + 逻辑外键（无 DB 外键）。

**`conversation`（新）**

| 列 | 类型/约束 | 说明 |
|---|---|---|
| id | uuid PK | |
| org_id | uuid，逻辑外键 → organization | |
| type | varchar(16) | `'channel' \| 'dm'` |
| name | varchar(64)，nullable | 频道名；DM 为 null |
| dm_key | varchar(80)，nullable | DM 去重键 = `min(uid)+':'+max(uid)`；channel 为 null |
| created_by | uuid，逻辑外键 → app_user | |
| created_at | timestamptz | |

索引：`(org_id, type)`（列频道）；唯一 `(org_id, dm_key) WHERE type='dm'`（防重复私信）。

**`conversation_member`（新）**

| 列 | 类型/约束 | 说明 |
|---|---|---|
| id | uuid PK | |
| conversation_id | uuid，逻辑外键 | |
| user_id | uuid，逻辑外键 | |
| last_read_at | timestamptz，nullable | 未读基线；首次查看懒建/更新 |
| joined_at | timestamptz | |

唯一索引 `(conversation_id, user_id)`。**频道**：成员隐式（=组织成员），member 行仅用于 `last_read_at`（懒建）；**私信**：2 条 member 行即参与者（可见性判据）。

**`message`（新）**

| 列 | 类型/约束 | 说明 |
|---|---|---|
| id | uuid PK | |
| conversation_id | uuid，逻辑外键 | |
| sender_id | uuid，逻辑外键 → app_user | |
| content | text | 纯文本 |
| created_at | timestamptz | |

索引 `(conversation_id, created_at)`（历史分页 + 未读统计）。

**presence**：不落表。Redis ephemeral key `presence:<org_id>:<user_id>`（TTL ~45s），缺 Redis 时 server-main 进程内 `Map`（单副本）。

## 4. 实时协议（libs/types/im）

IM 数据 schema + 事件常量集中放 `libs/types/src/im/`（跨域共用）：
- 类型：`Conversation`、`ConversationSummary`（带 unreadCount / lastMessage 预览 / 对端用户 for DM）、`Message`、`PresenceState`。
- 命名空间常量：`IM_WS_NAMESPACE = "ws/im"`（server-main 与 server-agent 本地各自的 gateway 同名，不同进程）。
- 事件常量 `IM_WS_EVENTS`（三层同一套）：
  - 下行（server→client）：`message`（新消息）、`presence`（成员在线变化）、`conversationCreated`（新 DM/新频道）。
  - 上行（client→server）：`send {conversationId, content}`、`read {conversationId}`。

**房间（server-main）**：每会话 `conv:<id>`；组织级 `org:<id>`（presence + 新会话通知）。

**订阅规则**：server-agent 连接（cloud JWT，已知 user U / org O）→ server-main 让其加入 `org:<O>` + U 可见的所有会话房间（O 的全部频道 + U 参与的 DM）。新建会话时把相关在线成员 join 进新房间并广播 `conversationCreated`。

## 5. API

### 5.1 server-main（`{success,code,message,data}` 信封 + 限流）

**WS（`ws/im` gateway，cloud JWT 握手）**
- 连接：标记 presence 在线（Redis TTL）+ 加入房间 + 回推在线成员快照。
- `send {conversationId, content}`：校验可见性 → 落 message（单表写）→ 扇出 `message` 到 `conv:<id>`。
- `read {conversationId}`：upsert conversation_member.last_read_at。
- 断开：presence 离线（删 key 或等 TTL）→ 广播 `presence`。

**REST（新 ImController；ConversationService / MessageService / PresenceService 在 libs/main，各自唯一持 Repository）**
- `GET /api/conversations` — 我的会话（活跃组织全部频道 + 我参与的 DM），每项带 `unreadCount`、`lastMessage` 预览、DM 的对端 user。首次无频道则懒建「综合」（`@WithLock` 按 org）。
- `POST /api/channels {name}` — 在活跃组织建公共频道。跨表写（conversation + creator 的 member 行）`@Transactional` + `persist*`/`*InTx`。
- `POST /api/dms {userId}` — 与组织成员 find-or-create 1:1 私信（按 dm_key；`@WithLock` 按 dm_key 防并发重复）。返回会话 + 广播 `conversationCreated` 给双方。
- `GET /api/conversations/:id/messages?before=<messageId>&limit=` — 历史分页（校验可见性）。
- 复用 Phase 1 `GET /api/orgs/:id/members` 做 DM 选人 + presence 名单。

**错误码（main 段 2007 起）**：`CONVERSATION_NOT_FOUND(2007)` / `CONVERSATION_FORBIDDEN(2008, 403)` / `CHANNEL_NAME_INVALID(2009)` / `DM_TARGET_INVALID(2010)`。

### 5.2 server-agent（本地代理 + 桥）

**ImRelayClientService（新核心组件）**：持久 socket.io-client → server-main `ws/im`。base URL 取 `MESHBOT_CLOUD_WS_URL`（默认由 `MESHBOT_CLOUD_URL` 推导）；握手带 `cloud_identity.cloudToken`；登录且有活跃组织时连接，断线指数退避重连，云端 401 → 触发与 CloudClient 一致的清 token 逻辑（落回 needs-login）。订阅下行事件 → `emitter.emit(IM_EVENTS.message|presence|conversationCreated, payload)`。暴露 `send()/read()` 透传上行。连接状态可查（供 presence「我」与 UI 连接指示）。

**ImGateway（本地 `ws/im` namespace，本地 JWT，复用 BaseWebSocketGateway）**：浏览器连；`@OnEvent(IM_EVENTS.*)` 广播给浏览器；浏览器 `send`/`read` → 调 ImRelayClient 透传上云。

**薄 REST 代理（controller-thin，复用 CloudClient）**：`GET /api/conversations`、`POST /api/channels`、`POST /api/dms`、`GET /api/conversations/:id/messages` → 转发 server-main 并解信封。

> **Phase 3 钩子**：`IM_EVENTS.message` 在 EventEmitter2 上可被本地 Agent 监听；Phase 2 仅保证该事件被 emit，不加 Agent 监听器。

## 6. 前端（web-agent，消息区）

替换 `/messages` 占位为 IM 视图：
- **消息侧栏**（深色，沿用外壳 + `--shell-sidebar`）：**频道**段（# 图标 + 未读徽标）+ **私信**段（presence 绿点 + 对端名 + 未读）；头部「+」→ 建频道 / 从组织成员目录发起私信。
- **内容**：会话头（频道名 / DM 对端名 + presence 点）+ **新 `ImMessageList`**（Slack 行式，**每条按 sender 显头像+名字+时间戳**；无 reasoning/工具/流式）+ 复用 `ChatInput`（纯文本，去掉 token 环/模型 chip）。空态：未选会话的引导。
- **路由**：`/messages`（空态）+ `/messages?id=<conversationId>`（仿 `/session?id=` 的 query 模式，`areaFromPath` 已把 `/messages` 归 messages 区）。
- **数据**：本地 `ws/im` 客户端（仿 `lib/socket.ts`，本地 JWT）；jotai/react-query 管会话列表、当前会话历史、未读、presence。发消息乐观插入 + WS 回执对齐。
- i18n：全程 next-intl，新增 `messages` 命名空间 key（频道/私信/在线/发消息等），遵守扁平 stub 工作流（`sync:locales --write`）。

> `MessageList` 把所有 user 行渲染成"当前用户"，IM 每条 sender 不同，故新建轻量 `ImMessageList`（复用 Slack 行视觉）；ChatInput 直接复用。

## 7. 在线状态（presence）

- **信号源**：server-agent↔server-main 的 `ws/im` 连接。连上 = 该用户在线；断开 = 离线。无需浏览器单独向云端心跳。
- **存储**：server-main Redis key `presence:<org_id>:<user_id>`（TTL ~45s，socket 周期 ping 续期）；缺 Redis 回退进程内 Map（单副本）。
- **广播**：上下线变化 → `presence` 事件到 `org:<id>` 房间 → server-agent → 浏览器。连接时回推组织在线成员快照。
- **粒度**：online/offline 二态（无 idle/away）。

## 8. 错误处理与边界
- **云端不可达 / ImRelay 未连**：IM 界面顶部提示「实时连接断开，重连中」；历史/列表 REST 仍可读（经代理，云端可达时）。本地 Agent 与会话功能不受影响。
- **云端 token 失效**：ImRelayClient 收 401 → 与 CloudClient 一致清 token，前端落 needs-login。
- **可见性校验**：频道按 org 成员；DM 按 conversation_member。越权 → `CONVERSATION_FORBIDDEN`。
- **DM 去重并发**：`@WithLock` 按 dm_key，find-or-create 幂等。
- **默认频道并发**：`@WithLock` 按 org，懒建幂等。
- **乱序/重连**：消息以 server `created_at` + id 排序；重连后按当前会话重拉首页对齐（参考 session 页 reconnect 重拉）。

## 9. 测试
- **server-main 单测（Jest）**：ConversationService（建频道、DM find-or-create 去重、默认频道懒建、可见性）、MessageService（落库、历史分页 cursor、未读统计）、PresenceService（TTL 上下线、Redis 缺省回退）。
- **server-main E2E（Postgres service）**：组织内 A 建频道 → B 收到 `message`；A 私信 B（去重）；presence 上下线广播；越权负向。
- **server-agent 单测**：ImRelayClient（连接/token 注入/重连/401 清理/emit）、ImGateway（OnEvent 广播、send/read 透传）、REST 代理解信封。
- **web-agent**：IM 视图渲染、发送乐观插入、presence 点、未读。
- **静态围栏**：commit 前 `pnpm check` 全套（repo 归属 / tx 命名 / 锁-事务 / 死导出 / 错误码）。

## 10. 配置与迁移
| 端 | 变更 |
|---|---|
| server-agent | 新增 `MESHBOT_CLOUD_WS_URL`（默认由 `MESHBOT_CLOUD_URL` 推导，如 `ws://127.0.0.1:3200`） |
| server-main | 无新增配置切片（复用 redis/jwt）；新增 DDL 文件 `<YYYYMMDDHHmm>-im-conversations.sql`（conversation / conversation_member / message + 索引），大表索引 `CONCURRENTLY` 单独成文件；DBA 手动执行 |
| libs/types | 新增 `im/` 域（Conversation/Message/Presence schema + `IM_WS_EVENTS`/`IM_WS_NAMESPACE`） |

## 11. 文件结构（实现时落点，便于 plan 拆分）
- `libs/types/src/im/*` — schema + 事件常量。
- `libs/main/src/entities/{conversation,conversation-member,message}.entity.ts` + `services/{conversation,message,presence}.service.ts` + 错误码追加。
- `apps/server-main/src/ws/im.gateway.ts` + `rest/im.controller.ts` + Redis adapter 接线 + DDL 文件。
- `apps/server-agent/src/cloud/im-relay-client.service.ts` + `ws/im.gateway.ts` + `rest/im.controller.ts`（代理）+ `IM_EVENTS`。
- `apps/web-agent/src/app/messages/page.tsx`（替占位）+ `components/im/{im-sidebar,im-message-list,im-conversation-header,dm-picker}.tsx` + `lib/im-socket.ts` + `atoms/im.ts` + `rest/im.ts` + `messages.json` i18n。
