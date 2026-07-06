# L2 · 移除 Agent-DM + 助手列设备与跨设备查看会话 设计

**日期**：2026-07-06
**前置**：L1（全局 Agent 输入框改版）已合并。本 spec 覆盖 L2 全部。L3（在线远程"发消息/相同交互"）另开。

## 目标（一句话）

移除方向错误的「人↔设备 Agent 私聊（Agent-DM）」+ 其反向通道；改为在 web-agent「助手」里**两级列出该账号所有注册授权设备（A 本地 / B / C …）**，展开某设备 → 列该设备的 **agent 工作会话（Session）**，可只读查看历史；查看 B/C 会话要求其在线（实时 relay，不落云）。

## 已确认决策

- **会话** = agent 工作会话（server-agent 的 `Session` / `SessionMessage`），非 IM Conversation。
- **跨设备查看** = 目标设备**在线时实时 relay 拉取**；离线看不到（不做云端会话同步）。**只读**（不发消息/不触发 run —— 那是 L3）。
- **移除范围** = 仅「人↔设备 Agent 私聊（Agent-DM）+ 其反向通道」；**普通 IM（人↔人 频道/私聊）保留**；**设备在线态（devicePresence / `/api/devices/:id/online`）保留**（新特性复用）。
- **web-main `/messages`**（当前整页就是 Agent-DM 专用）：**直接移除**（含 rail 入口）。
- **UI 模型**：助手侧栏两级树 —— 一级=所有设备（常显、带在线点、A 标本地），展开→二级=该设备会话；**不是**单选切换器。
- **composer「选择 agent」= 助手侧栏同一份设备列表**（同源）。
- **senderType**：Agent-DM 移除后 `Message.sender_type` 只剩 `'user'` → 删列（与删 `agent_device_id` 同一支云端 DDL）。

## 关键架构洞察

要移除的 Agent-DM **反向通道**与新 L2「在线拉 B/C 会话」**共用底层管道**（`device:${id}` 房间 + relay 连接 + presence）。做法：**移除 Agent-DM 语义层**，**保留底层 relay/房间/presence**，在其上**新建「设备查询」请求-响应语义**（只读查会话）。不是拆了重建。

---

## Part A · 移除 Agent-DM（含反向通道 + web-main /messages）

> 依据 Explore 清单。区分「可整块删」与「与普通 IM 共用只能改」，**勿误删普通 IM 与设备在线态**。

### A1. 云端 server-main
- **删**：`apps/server-main/src/rest/agent-device.controller.ts` 整文件（`GET /api/agent/conversations`），并从 `app.module.ts` controllers 移除。
- **删**：`libs/main/src/services/conversation.service.ts` 的 Agent-DM 方法 `findOrCreateAgentDm` / `findOrCreateAgentDmLocked` / `persistAgentDmInTx` / `listAgentDmsForDevice` / `getAgentDmOrThrow` / `findAgentDevice`；随之移除对 `DeviceService` 的注入（若仅这些用）。
- **删**：`libs/main/src/dto/index.ts` 的 `CreateAgentDmDto` + import；`libs/main/src/errors/main.error-codes.ts` 的 `AGENT_DEVICE_INVALID`。
- **改**：`libs/main/src/entities/conversation.entity.ts` 删 `agentDeviceId` 列；`conversation.service.ts` `toSummary` 删 agent 分支 + `agentDeviceId` 字段；`entities/message.entity.ts` 删 `senderType` 列，`message.service.ts` `persistMessage`/`toImMessage` 去 senderType 参数（固定语义为普通消息）。
- **改**：`apps/server-main/src/rest/im.controller.ts` 删 `createAgentDm` + `CreateAgentDmDto` import；**保留** `deviceOnline`（`GET /api/devices/:id/online`）+ `DevicePresenceService`。
- **改**：`apps/server-main/src/ws/im.gateway.ts` 删 `handleSend` 的 device 回流分支 + 尾部 `agentInbound` 定向下发 + `ImAgentInboundEvent` import；**保留** device presence（onAuthedConnect setOnline / handleDisconnect / handlePing heartbeat / jwtVerify device token 分支 / `DeviceService` 注入 / `client.join(device:${id})`——后者 L2c 要复用）。
- **DDL**：新增 `apps/server-main/migrations/<ts>-drop-agent-dm-columns.sql`（幂等）：`ALTER TABLE conversation DROP COLUMN IF EXISTS agent_device_id;` `DROP INDEX IF EXISTS ix_conversation_agent_device;` `ALTER TABLE message DROP COLUMN IF EXISTS sender_type;`。文件不可变、DBA 手动执行。

### A2. 本地 server-agent（SQLite）
- **删整块**：`services/agent-inbox.service.ts`、`agent-inbox.module.ts`（+ app.module import/imports）、`entities/im-agent-session.entity.ts`（+ app.module entities 数组）、`services/im-agent-session.service.ts`、`im-agent-session.module.ts`（+ app.module）。
- **删**：`services/cloud-im.service.ts` 的 `listAgentConversations`；`services/session.service.ts` 的 `createImAgentSession` / `createImAgentSessionInTx`。
- **改**：`cloud/im-relay-client.service.ts` 下行 for-loop 里 `agentInbound` 那一项删；**保留** `send`/`read`（普通 IM 频道发消息用）。`entities/session.entity.ts` 的 `kind` 联合类型去掉 `"im-agent"`。
- **迁移**：仿现有 Drop 迁移新增一支删 `im_agent_session` 表的 SQLite 迁移；删旧的 `1780900000000-ImAgentSession.ts` / `1781000000000-AddImAgentSessionAppendedCursor.ts` 及其 `__tests__` spec（历史迁移移除后基线迁移集变化——启动自动跑新 Drop 迁移即可，旧迁移文件删除不影响已建库，因新 Drop 幂等 `DROP TABLE IF EXISTS`）。

### A3. libs/types
- **改**：`im/im.events.ts` 删 `agentInbound` 事件名 + `ImAgentInboundEvent` 接口；`im/im.schema.ts` 删 `ConversationSummary.agentDeviceId`、`ImMessageSchema.senderType`、`CreateAgentDmSchema`/`Input`；`index.ts` 去相应导出。

### A4. web-main
- **删整块**：`components/im/{agent-picker,im-sidebar,im-conversation}.tsx`、整个 `app/(shell)/messages/**`、`rest/im.ts` 的 `useCreateAgentDm`（若 `useConversations`/`fetchMessages` 无其它消费者则随之删）。`components/shell/workspace-rail.tsx` 去掉 `messages` rail 项。
- **保留**：`rest/agent-devices.ts`（deviceOnline/presence，设备在线态）、`rest/devices.ts`（`useDevices`）、`app/(shell)/settings/devices/page.tsx`。

### A5. web-agent
- **无 Agent-DM 触点**（已确认）；web-agent 的 `messages` 模块是普通 IM，不动。

---

## Part B · 设备列表（助手侧栏 + composer 共享同源）

- **server-agent 云代理**：`CloudImService` 加 `listDevices()` → 云端 `GET /api/devices`（deviceToken）；`CloudImController` 加 `GET /api/devices` 路由（薄代理）。另加 `GET /api/me/device`（或在 sidebar 聚合里）返回**本设备自身 deviceId**（取自 `cloud_identity`），供前端标记 A=本地。
- **web-agent rest**：新增 `rest/devices.ts` —— `useDevices()`（列表：`{id,name,platform,online?,isLocal}`）+ 在线态（`GET /api/devices/:id/online`，代理或直取）。设备列表状态放一个共享 atom / react-query key，**助手侧栏与 composer「选择 agent」同源消费**。
- **A=本地标记**：前端拿 `me/device` 的 deviceId，与 devices 列表匹配置 `isLocal`。
- **在线态**：首屏 REST + presence 事件（经本地 `ws/events` 总线转发的 `agent:${deviceId}` presence，若 relay 已订阅）。

---

## Part C · 助手侧栏两级树 UI（web-agent）

- `AssistantSidebar` 改为**两级列表**：
  - **一级 = 设备（agent）**：列出所有注册设备（A 本地 / B / C …），每行带名称 + 平台 + 在线点（●/○）+「本地」标。
  - **二级 = 展开某设备 → 该设备会话列表**：
    - **A（本地）**：会话来自现成 `GET /api/sessions`（本地 SQLite）。默认展开。
    - **B/C（远程）**：展开时若在线 → 触发 L2c relay 拉取该设备会话；离线 → 该设备行置灰 + 提示「离线，无法查看」，不可展开。
  - 点某会话 → 只读查看历史（详见 Part D 的 messages 查询）。**远程会话只读**（输入框禁用 + 提示「远程会话，暂只读」）。
- **composer「选择 agent」**（L1 的 `ComposerTargetBar`）：下拉用同一份 devices 列表（本地默认选中；离线设备置灰）。L2 阶段选中远程设备仅作展示/占位（真正远程发任务是 L3）。

---

## Part D · 在线 relay「设备查询」请求-响应协议（L2c 核心）

云端零工作会话数据 → 只能在线 relay。在保留的 `device:${id}` 房间 + relay + presence 上，新增只读查询通道。

### 事件契约（libs/types/im.events）
- `DEVICE_QUERY_REQUEST = "device.query.request"`：`{ correlationId: string; targetDeviceId: string; kind: "sessions" | "messages"; params?: { sessionId?: string; cursor?: string; limit?: number } }`
- `DEVICE_QUERY_RESPONSE = "device.query.response"`：`{ correlationId: string; ok: boolean; data?: SessionView[] | SessionMessagePage; error?: "offline" | "not_found" | "internal" }`
- DTO：`SessionView { id; title; status; kind; pinnedAt; background; updatedAt }`；`SessionMessagePage { items: SessionMessageView[]; nextCursor?: string }`；`SessionMessageView { id; seq; role; content; reasoning?; toolCalls?; toolCallId?; createdAt }`。

### 链路
```
web-agent(A)  REST→ A 的 server-agent
  GET /api/remote-devices/:deviceId/sessions
  GET /api/remote-devices/:deviceId/sessions/:sessionId/messages?cursor=
     → RemoteDeviceQueryService：建 correlationId + pending Promise（超时 ~10s）
        → relay emit device.query.request{correlationId,targetDeviceId,kind,params}
  云 server-main ws/im.gateway @SubscribeMessage(device.query.request)：
     校验 requesterDevice 与 targetDevice 同一 userId + target 在线；
     离线 → 直接回 device.query.response{ok:false,error:"offline"} 给 A；
     在线 → 附 requesterDeviceId 定向下发到 device:${targetDeviceId}
  B 的 server-agent（im-relay-client 订阅 device.query.request）：
     account.run(cloudUserId) 内查本地 SessionService.listAllSorted / SessionMessageService.listPage
     → relay emit device.query.response{correlationId,requesterDeviceId:A,ok:true,data}
  云 gateway @SubscribeMessage(device.query.response)：按 requesterDeviceId 路由回 device:${A}
  A 的 server-agent 订阅 device.query.response → 按 correlationId resolve pending → 返回 REST
```
- **安全**：gateway 强校验 requester 与 target 属**同一账号/用户**（`DeviceService` 校验 device.userId），拒绝跨账号；返回的会话本就按 target 的 `cloudUserId` 隔离（同账号）。
- **超时/离线**：A 侧 pending 有超时兜底（返回「设备离线/超时」）；gateway 离线短路。
- **只读**：仅查询，不触发 run、不写。

### 各端新增
- libs/types：上面事件 + DTO。
- server-main：`ws/im.gateway` 两个 `@SubscribeMessage` + 同账号校验 + 响应路由（复用 `device:${id}` 房间 / `DevicePresenceService` / `DeviceService`）。
- server-agent：`RemoteDeviceQueryService`（出站：correlation map + 超时 + relay emit）+ `RemoteDeviceController`（`/api/remote-devices/...`）；`im-relay-client` 入站订阅 `device.query.request` + handler（查本地 Session/SessionMessage）。
- web-agent：`rest/remote-device.ts`（拉远程设备会话/消息）+ 助手侧栏消费。

---

## 非目标（L2 明确不做）

- 远程**发消息 / 相同交互对话 / 触发远端 run**（= L3）。
- 云端会话同步 / 离线查看历史（本 L2 只在线 relay）。
- 普通 IM（人↔人）功能的重建（web-main /messages 只删不补）。

## 测试与验证

- **移除**：全量 `pnpm test` + `pnpm typecheck` 必绿；被删迁移/entity 的 spec 同步删；新 Drop 迁移加 spec（仿现有 Drop 迁移测试）；`pnpm check`（tx/naming/repo/lock-tx/dead/error-code）过（删 Service 方法/Entity 会动 repo 归属，需过 check:repo）。
- **relay 协议**：server-main ws/im.gateway 新事件加单测（同账号校验、离线短路、响应路由）；server-agent RemoteDeviceQueryService 超时/correlation 单测 + 入站 handler 查询单测；e2e 覆盖「A 查在线 B 会话」链路（若 e2e 设施允许双设备模拟，否则以 gateway + service 单测为主）。
- **UI**：web-agent 无组件测试基建（L1 已确认）→ 目视：助手两级树（展开 A 本地会话、B 在线拉取、C 离线置灰）、composer 选择器同源、web-main /messages 已移除。
- Biome + i18n 键对齐（新文案）+ 桌面端跑通。

## 风险

- **移除面广**：跨 server-main / server-agent / libs / web-main 四处 + DDL + SQLite 迁移，需全量测试回归 + `pnpm check:repo`（Entity 归属变化）。
- **relay 请求-响应**是新协议：correlation/超时/离线/跨账号校验要严；WS 路由比单向下发复杂。
- **双设备验证难**：本地单机难模拟 A/B 两设备在线；以单测 + 手工双实例为主。
- server-agent 删 `im-agent` 会话种类：确认无历史数据依赖（`listAllSorted` 只取 `kind='user'`，不受影响）。
</content>
