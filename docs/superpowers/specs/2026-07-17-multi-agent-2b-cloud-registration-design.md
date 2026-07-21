# 计划二 · 2b：云端注册 + agentId 寻址 设计

> 日期：2026-07-17
> 状态：设计已确认，待写实施计划
> 上游：`2026-07-15-multi-agent-per-device-design.md`（§4 云端注册与寻址）

## 背景

「一设备多 Agent」计划二拆三个子项目：2a（本机 Agent 侧栏，已完成，含去全局当前 Agent 修订）、**2b**（云端注册 + agentId 寻址）、2c（两端远程 Agent 打通 + web-main IA 打磨）。

前置已就绪：server-agent 有 `agents` 表（含 `remote_enabled` / `visibility` 列，计划一只建列不用）、`sessions.agent_id` 绑定会话。**当前远程 run 恒落默认 Agent**（`remote-run-inbound.service.ts` `ensureDefault()`），且**没有任何 remote_enabled 门控**——今天只要设备在线 + 同账号，任何端都能远程 kick 它跑默认 agent。

**2b 目标**：把本机 `remote_enabled=true` 的 Agent 元数据注册到云端；云端寻址从 deviceId 改成 agentId；补上本地二次门控（安全命门）。这是「远程 Agent 能存在、能被寻址」的地基。

**2b 边界（用户确认）**：后端为主 + **web-main 最小改到「能按 agentId 寻址」**。web-main 起手台/侧栏的「设备列表 → 扁平 Agent 列表 + 在线态从宿主设备派生」IA 打磨留 2c。

## 已决策（主 spec §4 已定，2b 照实施）

| 项 | 结论 |
|---|---|
| 注册方向 | 单向**推送** + 全量对账（权威源在本地）——照 `ModelConfigSyncService` 反向 |
| 云端 agent id | 云端**另发**雪花 PK，不复用本地 id（各设备自生成会撞）；`(device_id, local_agent_id)` 唯一 |
| 上云内容 | 只上元数据 `name` / `avatar` / `description`。prompt / 技能 / MCP **不出本地** |
| `remote_enabled` | **不上云**——云端表里的 agent 天然就是「本地开了远程的」；本地是 remote_enabled 唯一真相（二次门控） |
| 寻址 | `targetDeviceId` → `targetAgentId`；网关查 agent 行拿 deviceId，仍 emit 到 `device:<deviceId>` room（连接层不动），payload 带 `localAgentId` |
| 二次门控 | B 侧不信云端，查本地 `remote_enabled=true` 才建会话 |
| visibility | 本期恒 `private`，org 预留 |

## 1. 云端 agent 表 + 注册同步

### 1.1 云端 Postgres 新表 `agent`（DDL 文件，DBA 手动执行）

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | 云端雪花 PK | 云端另发，不复用本地 id |
| `device_id` | text | 归属设备（关联 `device.id`，逻辑外键） |
| `user_id` | text | 归属用户 |
| `org_id` | text nullable | 组织（可空） |
| `local_agent_id` | text | 本地 agent 的 id |
| `name` / `avatar` / `description` | text | 元数据（唯三上云的内容） |
| `visibility` | text | `private`（本期恒 private，org 预留） |
| `last_synced_at` | timestamptz | 最近对账时刻 |
| `deleted_at` | timestamptz nullable | 软删 |
| `created_at` / `updated_at` | timestamptz | |

唯一索引：`(device_id, local_agent_id) WHERE deleted_at IS NULL`（重复注册幂等）。
索引：`(user_id) WHERE deleted_at IS NULL`（web-main 按用户列 Agent）。

DDL 走 `ddl-migration` 技能：纯 SQL 文件 `apps/server-main/migrations/<YYYYMMDDHHMM>-create-agent-table.sql`，幂等（`IF NOT EXISTS`）、snake_case、逻辑外键（无 DB 级 FK）、文件不可变、DBA 手动执行。

### 1.2 云端实体 + Service（server-main）

- `libs/main/src/entities/agent.entity.ts`：`Agent` 实体（继承 `SnowflakeBaseEntity`）。
- `AgentService`（唯一归属，持 `@InjectRepository(Agent)`）：`upsertBatch(deviceId, userId, orgId, agents[])`（全量对账：upsert 列表内的、软删列表外的）+ `listForUser(userId)`（web-main 用）。
- REST（server-main）：
  - `PUT /api/agent/agents`（**device token 鉴权**）：注册对账入口。
  - `GET /api/agents`（**用户 JWT 鉴权**）：web-main 列当前用户已注册的远程 Agent（带 device_id + 在线态）。

### 1.3 本地注册同步（server-agent）

- 新增 `AgentCloudSyncService`（照 `model-config-sync.service.ts` 的事件触发面，方向反过来——推）。
- 触发时机：`onApplicationBootstrap`（启动全量）/ `AUTH_EVENTS.authorized`（登录）/ `IM_RELAY_EVENTS.connected`（relay 重连追平）/ **本地 Agent CRUD 事件**（增量）。
- `syncNow`：读本地所有 `remote_enabled=true` 的 Agent → `cloud.put('/api/agent/agents', {agents: [...]}, deviceToken)`。
- **新基建：本地 Agent CRUD 事件总线**。现在 `agent.service.ts` / `agent.controller.ts` 无事件。新增 `AGENT_EVENTS.changed`（create/update/delete/toggle-remote 后 emit），`AgentCloudSyncService` 监听它触发 `syncNow`。

### 1.4 web-agent 编辑抽屉补「允许远程」开关

计划一故意没放（留给 2b）。2b 在 `agent-editor-sheet.tsx` 补 `remoteEnabled` 开关（`PATCH /api/agents/:id` 已支持该字段）。开关旁写清后果：「打开后，你在其他设备或网页上可以远程调度这个 Agent」。改开关 → 触发 `AGENT_EVENTS.changed` → 同步到云端（打开则注册，关闭则从云端软删）。

## 2. agentId 寻址一刀切 + 二次门控

### 2.1 协议改 targetDeviceId → targetAgentId

`libs/types/src/im/im.schema.ts`：
- `AgentRunStartSchema` / `DeviceQueryRequestSchema` / `AgentRunControlSchema` 的 `targetDeviceId` → `targetAgentId`（云端 agent id）。
- `AgentRunStartForwarded` / `AgentRunControlForwarded` / `DeviceQueryForwarded` **加 `localAgentId` 字段**（B 侧据此落到哪个本地 Agent）。`requesterDeviceId`/`requesterAgentId` 视需要（发起方标识，2b 保持 requester 现状——浏览器仍编码 `user:<socketId>`，设备仍 deviceId；这块 2c 再理）。

### 2.2 云端网关寻址与鉴权重写（`im.gateway.ts`）

- 三处 `devices.findById(body.targetDeviceId)`（`handleAgentRunStart:501` / `handleDeviceQueryRequest:430` / control）→ 查 `agent` 表拿到 agent 行。
- 鉴权：`device.userId === requesterUserId` → `agent.userId === requesterUserId` 且 `agent.deleted_at IS NULL`。
- 从 agent 行拿 `device_id` → 在线检查（presence）→ 仍 `emit` 到 **`device:<deviceId>` room**（连接层不变），payload 带 `localAgentId`。
- `agentRunRoutes` / `queryRoutes` 路由表键从 `targetDeviceId` → `targetAgentId`；回流帧校验（发送方 = 登记的目标）对齐到 agent→device。

### 2.3 B 侧二次门控（`remote-run-inbound.service.ts`，安全关键）

- 收到 `agent.run.start` 后**不信云端**：用 `forwarded.localAgentId` 查本地 `agents` 表。
- 必须 **`remote_enabled === true`** 且 agent 存在 → 才 `account.run` + 建会话（会话归这个 agent，替换现在恒 `ensureDefault()`）。
- 否则回 `agentRunEnd{reason:"error"}`（新增专门 reason `agent_not_remotable` 更清晰）。
- **补上现在的安全空白**：云端数据可能过期（设备离线时关了开关、尚未对账），本地是唯一真相。

### 2.4 presence key 改名

`agent:<deviceId>` → `device:<deviceId>`（`device-presence.service.ts` + web-main `agent-devices.ts`）。引入真 agent 后 `agent:<deviceId>` 会毒害代码库。

### 2.5 A 侧发起方（`remote-run.service.ts`）

并发守卫键 `(targetDeviceId, sessionId)` → `(targetAgentId, sessionId)`。

## 3. web-main 最小改

只到「能按 agentId 寻址」，IA 打磨留 2c：

- transport（`apps/web-main/src/lib/session-transport.ts`）上行 `targetDeviceId` → `targetAgentId`；`device-query-client`（web-common）、`use-remote-sessions`、`lib/device-query.ts` 同步。
- 路由 `apps/web-main/src/app/(shell)/assistant/[deviceId]/page.tsx` → `[agentId]`。
- **最小目标选择**：起手台（`launcher.tsx`）用一个「Agent 下拉」（数据来自 `GET /api/agents`）让用户选到一个 agentId 发起。功能可用即可——**不做** §4.5 的「设备列表 → 扁平 Agent 列表 + 在线态从宿主设备派生」打磨（2c）。设计上让这个下拉往 2c 平滑升级（同一份 `GET /api/agents` 数据）。
- 设备本身在设置页仍可见可管理，不再是会话入口（渐进，2c 收口）。

## 4. 风险

1. **寻址一刀切是破坏性的（最大发布风险）**：relay 帧 `targetDeviceId → targetAgentId`，**server-agent 与 server-main 必须同版本发布**。旧版 agent 连新版 main 会**静默**收不到 run 请求。
2. **云端 DDL 是 DBA 手动执行**：`agent` 表建表 SQL 需在 Postgres 上手动跑。dev 环境把 SQL 给用户手动执行。服务任何模式都不自动建表。
3. **二次门控是安全命门**：B 侧漏掉 `remote_enabled` 校验 = 任何注册过的 agent 都能被远程 kick。单测必须覆盖「remote_enabled=false 拒绝」。
4. **注册对账软删的时机**：全量列表少一个就软删——若同步时机错（启动时本地 agents 未加载完就推空列表）会把云端全软删。推送前必须保证本地数据已就绪（`ensureDefault` 之后、agents 查询成功之后）。
5. **A 侧 requester 语义未动**：2b 只改「目标」为 agentId，「发起方」（浏览器 `user:<socketId>` / 设备 deviceId）保持现状，2c 再理。别顺手改乱回流路由。

## 5. 测试

**单测**
- 云端 `AgentService.upsertBatch` 对账 diff：新增 / 改名 / 关开关（列表移除）→ 软删；重复注册幂等（`(device_id, local_agent_id)`）。
- **B 侧二次门控**：`remote_enabled=false` 时 `remote-run-inbound` 拒绝、回 `agent_not_remotable`；`remote_enabled=true` 放行且会话归该 agent。
- agentId 寻址鉴权：`agent.userId !== requesterUserId` → 打不通（404/拒绝）。
- `AgentCloudSyncService`：触发时机 + 全量列表构造（只含 remote_enabled=true）。

**E2E（server-main，含 Postgres）**
- `PUT /api/agent/agents` 注册对账 + `GET /api/agents` 列出 + `targetAgentId` 越权 404。

**DDL**
- 云端 `agent` 表建表 SQL 走 `ddl-migration` 技能（幂等、不可变、DBA 手动执行）。

**手工冒烟（交用户真机，跨设备）**
- web-agent 建 agent、开「允许远程」→ web-main 的 Agent 下拉看到它 → 发起会话 → 落到那台设备的**那个 agent**（不是默认 agent）。
- 关掉「允许远程」→ web-main 列表里消失、远程 kick 被拒（回 `agent_not_remotable`）。
- 跨设备：两台设备各自的 remote_enabled agent 都能在 web-main 看到并寻址。

## 关键文件清单

**云端轨（server-main）**
```
apps/server-main/migrations/<ts>-create-agent-table.sql   新建云端 agent 表 DDL
libs/main/src/entities/agent.entity.ts                    云端 Agent 实体
libs/main/src/services/agent.service.ts                   upsertBatch 对账 + listForUser
apps/server-main/src/rest/agent.controller.ts             PUT /api/agent/agents + GET /api/agents
apps/server-main/src/ws/im.gateway.ts                     寻址 targetAgentId + 鉴权查 agent 表 + presence 改名
libs/main/src/entities/device.entity.ts                   不改（仅关联参考）
```

**本地轨（server-agent）**
```
apps/server-agent/src/services/agent-cloud-sync.service.ts  新增：推送注册（照 model-config-sync 反向）
apps/server-agent/src/services/agent.service.ts             加 AGENT_EVENTS.changed 事件
apps/server-agent/src/controllers/agent.controller.ts       CRUD 后 emit 事件
apps/server-agent/src/services/remote-run-inbound.service.ts  二次门控 + 用 forwarded.localAgentId 建会话
apps/server-agent/src/cloud/remote-run.service.ts           并发守卫键 → targetAgentId
apps/server-agent/src/services/device-presence.service.ts   presence key 改名
```

**共享协议**
```
libs/types/src/im/im.schema.ts                            targetDeviceId → targetAgentId + forwarded 加 localAgentId
```

**web-agent**
```
apps/web-agent/src/components/agent/agent-editor-sheet.tsx  补「允许远程」开关
```

**web-main（最小改）**
```
apps/web-main/src/lib/session-transport.ts                上行 targetAgentId
apps/web-main/src/app/(shell)/assistant/[deviceId]/page.tsx → [agentId]
apps/web-main/src/components/assistant/launcher.tsx        最小 Agent 下拉（GET /api/agents）
apps/web-main/src/rest/agent-devices.ts                   presence key 改名对齐
packages/web-common/src/session/device-query-client.ts    targetAgentId 对齐
```

## 交付后的状态

- 本机 `remote_enabled=true` 的 Agent 元数据注册到云端，关开关/改名/删走全量对账。
- 云端寻址按 agentId：web-main 选一个远程 Agent 发起会话，落到那台设备的**那个 agent**。
- B 侧二次门控：只有 `remote_enabled=true` 的 agent 才能被远程 kick（补上安全空白）。

**不做**（2c）：web-main 起手台/侧栏「设备列表→扁平 Agent 列表 + 在线态从宿主设备派生」的 IA 打磨；web-agent 本机侧栏出现「同账号其他设备的远程 Agent」；双轨对等技能。
