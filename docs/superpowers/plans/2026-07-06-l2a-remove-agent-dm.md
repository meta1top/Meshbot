# L2a · 移除 Agent-DM 实施 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 移除方向错误的「人↔设备 Agent 私聊(Agent-DM)+ 其反向通道」,保留普通 IM(人↔人 频道/私聊)与设备在线态基座。

**Architecture:** 按「保持每次提交可编译」的依赖顺序分层移除:web-main → server-agent → server-main(含共享 schema 的 agentDeviceId/senderType 字段)→ libs/types(事件/DTO 收尾)→ 云端 DDL。反向通道底层(`device:${id}` 房间 / relay 连接 / `DevicePresenceService` / `/api/devices/:id/online`)**保留**,供 L2c 复用。

**Tech Stack:** NestJS · TypeORM(SQLite 本地 / Postgres 云端)· socket.io(ws/im)· Next.js(web-main)· Jest · Biome。

## Global Constraints

- **保留、勿删**:普通 IM(`Conversation type channel|dm`、`Message`、`ImController` channels/dms/messages/members、`ws/im` message/presence/read、server-agent `CloudImController`/`CloudImService` 的 listConversations/createChannel/createDm/getMessages/members、`ImContextModule`/`ImSendModule`、`ImRelayClientService.send/read`);**设备在线态**(`DevicePresenceService`、`agent:${deviceId}` presence、`GET /api/devices/:id/online`、gateway 的 setOnline/setOffline/heartbeat/device-token 握手、`client.join(device:${id})`)。
- 每个任务末尾:`pnpm typecheck`(退出码 0)+ `pnpm test`(基线 = 全绿 + 1 skip)+ 相关 `pnpm check`(动 Entity/Service 归属需 `pnpm check:repo` 绿)+ Biome。
- 云端 schema 改动配套 DDL:纯 SQL、幂等(`IF EXISTS`)、DBA 手动执行、文件不可变(见 `ddl-migration`)。本地 SQLite 用 TypeORM 迁移(启动自动跑)。
- 提交:中文 conventional commits,结尾 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
- 移除是删代码,不套 TDD 写新测试;验收 = 全量 typecheck/test/check 保持绿 + 被删代码的旧 spec 同步删 + 新 Drop 迁移补 spec。

---

## 文件结构(移除/修改总览)

| 层 | 整块删 | 只改(与普通 IM/在线态共用) |
|---|---|---|
| web-main | `components/im/{agent-picker,im-sidebar,im-conversation}.tsx`、`app/(shell)/messages/**`、`rest/im.ts` 的 `useCreateAgentDm` | `components/shell/workspace-rail.tsx`(去 messages 项) |
| server-agent | `services/agent-inbox.service.ts`、`agent-inbox.module.ts`、`entities/im-agent-session.entity.ts`、`services/im-agent-session.service.ts`、`im-agent-session.module.ts`、2 个旧迁移 + 其 spec | `app.module.ts`(去注册)、`services/cloud-im.service.ts`(去 `listAgentConversations`)、`services/session.service.ts`(去 `createImAgentSession*`)、`entities/session.entity.ts`(kind 去 `im-agent`)、`cloud/im-relay-client.service.ts`(去 agentInbound 那行)、新增 Drop 迁移 |
| server-main | `rest/agent-device.controller.ts`、`ConversationService` 6 个 Agent-DM 方法、`dto/index.ts` 的 `CreateAgentDmDto`、`errors/main.error-codes.ts` 的 `AGENT_DEVICE_INVALID` | `entities/conversation.entity.ts`(去 agentDeviceId)、`entities/message.entity.ts`(去 senderType)、`ConversationService.toSummary`、`services/message.service.ts`、`rest/im.controller.ts`(去 createAgentDm)、`ws/im.gateway.ts`(去 device 分支/agentInbound)、`app.module.ts`(去 controller) |
| libs/types | `im/im.events.ts` 的 `agentInbound`/`ImAgentInboundEvent`、`im/im.schema.ts` 的 `CreateAgentDmSchema/Input` | `im/im.schema.ts` 的 `ConversationSummary.agentDeviceId`、`ImMessageSchema.senderType`;`index.ts` 导出 |
| 云端 DDL | 新增 drop 列 SQL | — |

---

## Task 1: web-main 移除 Agent-DM UI + /messages

**Files:**
- Delete: `apps/web-main/src/components/im/agent-picker.tsx`、`apps/web-main/src/components/im/im-sidebar.tsx`、`apps/web-main/src/components/im/im-conversation.tsx`
- Delete: `apps/web-main/src/app/(shell)/messages/layout.tsx`、`apps/web-main/src/app/(shell)/messages/page.tsx`、`apps/web-main/src/app/(shell)/messages/[conversationId]/page.tsx`(整个 `app/(shell)/messages/` 目录)
- Modify: `apps/web-main/src/rest/im.ts`(删 `useCreateAgentDm` + `CreateAgentDmInput` import;若 `useConversations`/`fetchMessages` 在删掉上面组件后无其它引用者,一并删)
- Modify: `apps/web-main/src/components/shell/workspace-rail.tsx`(删指向 `/messages` 的 rail 项)
- Keep: `apps/web-main/src/rest/{devices,agent-devices}.ts`、`app/(shell)/settings/devices/page.tsx`(设备列表 + 在线态,L2b/L2c 要用)

**Interfaces:**
- Produces: web-main 不再有 `/messages` 路由与 Agent-DM UI;`rest/im.ts` 不再导出 `useCreateAgentDm`。

- [ ] **Step 1: 删组件与路由**

```bash
cd /Users/grant/Meta1/meshbot
git rm apps/web-main/src/components/im/agent-picker.tsx \
       apps/web-main/src/components/im/im-sidebar.tsx \
       apps/web-main/src/components/im/im-conversation.tsx
git rm -r "apps/web-main/src/app/(shell)/messages"
```

- [ ] **Step 2: 改 rest/im.ts**

删除 `useCreateAgentDm` 函数与 `CreateAgentDmInput` 的 import。用 grep 确认 `useConversations`/`fetchMessages` 是否还有引用者:
```bash
grep -rn "useConversations\|fetchMessages" apps/web-main/src --include=*.tsx --include=*.ts | grep -v "rest/im.ts"
```
若无输出 → 这两个也删(随 Agent-DM 一起,web-main 暂无普通 IM 消费);若有 → 保留。

- [ ] **Step 3: 改 workspace-rail.tsx**

删除 rail 中指向 `/messages` 的项(约 `workspace-rail.tsx:40-43`,`messages` 那条)。

- [ ] **Step 4: 校验**

Run:
```bash
npx tsc --noEmit -p apps/web-main/tsconfig.json
grep -rn "agent-picker\|im-sidebar\|im-conversation\|useCreateAgentDm\|/messages" apps/web-main/src || echo "无残留引用"
```
Expected: tsc 退出码 0;无残留引用(rail 已去 messages)。

- [ ] **Step 5: Biome + 提交**

```bash
npx biome check --write apps/web-main/src
git add -A apps/web-main
git commit -m "refactor(web-main): 移除 Agent-DM UI 与 /messages 页(方向错误)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: server-agent 移除 Agent 反向通道 + ImAgentSession

**Files:**
- Delete: `apps/server-agent/src/services/agent-inbox.service.ts`、`apps/server-agent/src/agent-inbox.module.ts`、`apps/server-agent/src/entities/im-agent-session.entity.ts`、`apps/server-agent/src/services/im-agent-session.service.ts`、`apps/server-agent/src/im-agent-session.module.ts`
- Delete: `apps/server-agent/src/migrations/1780900000000-ImAgentSession.ts`、`apps/server-agent/src/migrations/1781000000000-AddImAgentSessionAppendedCursor.ts`、`apps/server-agent/src/migrations/__tests__/im-agent-session-migration.spec.ts`、`apps/server-agent/src/migrations/__tests__/add-im-agent-session-appended-cursor.spec.ts`
- Create: `apps/server-agent/src/migrations/<新时间戳>-DropImAgentSession.ts`
- Modify: `apps/server-agent/src/app.module.ts`(去 `AgentInboxModule`(import 30 / imports 132)、`ImAgentSessionModule`(import 33 / imports 134)、`ImAgentSession` entity(import 51 / entities 数组 103))
- Modify: `apps/server-agent/src/services/cloud-im.service.ts`(删 `listAgentConversations` 方法 ~114-123)
- Modify: `apps/server-agent/src/services/session.service.ts`(删 `createImAgentSession`(~110-115)+ `createImAgentSessionInTx`(~117-131))
- Modify: `apps/server-agent/src/entities/session.entity.ts:24`(kind 联合去 `"im-agent"`)
- Modify: `apps/server-agent/src/cloud/im-relay-client.service.ts`(下行 for-loop 里 `IM_WS_EVENTS.agentInbound` 那一项删,~121;`send`/`read` 保留)

**Interfaces:**
- Consumes: `IM_WS_EVENTS.agentInbound`(仍存于 libs/types,Task 4 才删)。
- Produces: server-agent 不再有 AgentInbox/ImAgentSession/im-agent 会话种类;relay 不再监听 agentInbound。

- [ ] **Step 1: 删整块文件 + 旧迁移及其 spec**

```bash
cd /Users/grant/Meta1/meshbot
git rm apps/server-agent/src/services/agent-inbox.service.ts \
       apps/server-agent/src/agent-inbox.module.ts \
       apps/server-agent/src/entities/im-agent-session.entity.ts \
       apps/server-agent/src/services/im-agent-session.service.ts \
       apps/server-agent/src/im-agent-session.module.ts \
       apps/server-agent/src/migrations/1780900000000-ImAgentSession.ts \
       apps/server-agent/src/migrations/1781000000000-AddImAgentSessionAppendedCursor.ts \
       apps/server-agent/src/migrations/__tests__/im-agent-session-migration.spec.ts \
       apps/server-agent/src/migrations/__tests__/add-im-agent-session-appended-cursor.spec.ts
```

- [ ] **Step 2: 从 app.module.ts 移除注册**

删这些行:`import { AgentInboxModule } from "./agent-inbox.module";`(30)、`import { ImAgentSessionModule } from "./im-agent-session.module";`(33)、`import { ImAgentSession } from "./entities/im-agent-session.entity";`(51);`entities` 数组里的 `ImAgentSession,`(103);`imports` 里的 `AgentInboxModule,`(132)、`ImAgentSessionModule,`(134)。

- [ ] **Step 3: 删 cloud-im.service.ts 的 listAgentConversations、session.service.ts 的 createImAgentSession*、session.entity.ts 的 im-agent**

- `cloud-im.service.ts`:删 `listAgentConversations()`(~114-123,调 `/api/agent/conversations` 的方法)。其余方法保留。
- `session.service.ts`:删 `createImAgentSession`(公开)与 `createImAgentSessionInTx`(私有,`kind:"im-agent"`)。
- `session.entity.ts:24`:`kind!: "user" | "quick" | "subagent" | "im-agent";` → `kind!: "user" | "quick" | "subagent";`

- [ ] **Step 4: 删 im-relay-client.service.ts 的 agentInbound 订阅项**

在下行事件 for-loop(~121)里删掉 `IM_WS_EVENTS.agentInbound` 那一个事件项(循环本体与其它事件、`send`/`read` 全部保留)。

- [ ] **Step 5: 新增 Drop 迁移**

仿 `apps/server-agent/src/migrations/1780600000000-DropSessionImCompanionFields.ts` 的写法,新建 `apps/server-agent/src/migrations/<比现有最大时间戳更大的时间戳>-DropImAgentSession.ts`:
```ts
import type { MigrationInterface, QueryRunner } from "typeorm";

/** 移除 Agent-DM 反向通道:删 im_agent_session 表(幂等)。 */
export class DropImAgentSession<TIMESTAMP> implements MigrationInterface {
  name = "DropImAgentSession<TIMESTAMP>";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "im_agent_session"`);
  }

  public async down(): Promise<void> {
    // 单向移除,不恢复
  }
}
```
(把 `<TIMESTAMP>` 换成实际时间戳数字;类名与 `name` 一致。)

- [ ] **Step 6: 校验**

Run:
```bash
grep -rn "AgentInbox\|ImAgentSession\|im-agent\|agentInbound\|createImAgentSession\|listAgentConversations" apps/server-agent/src || echo "server-agent 无残留"
npx tsc --noEmit -p apps/server-agent/tsconfig.json
pnpm test 2>&1 | tail -5
```
Expected: server-agent 无残留(除 libs/types 里 Task 4 才删的 agentInbound 定义);tsc 0;测试全绿(被删迁移的 spec 已删,启动跑新 Drop 迁移)。

- [ ] **Step 7: 提交**

```bash
npx biome check --write apps/server-agent/src
git add -A apps/server-agent
git commit -m "refactor(server-agent): 移除 Agent 反向通道(AgentInbox/ImAgentSession/im-agent 会话)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: server-main 移除 Agent-DM(含共享 schema 的 agentDeviceId / senderType 字段)

**Files:**
- Delete: `apps/server-main/src/rest/agent-device.controller.ts`
- Modify: `apps/server-main/src/app.module.ts`(去 `import { AgentDeviceController }`(49)与 controllers 里 `AgentDeviceController,`(215))
- Modify: `libs/main/src/services/conversation.service.ts`(删 6 个 Agent-DM 方法 214-298:`findOrCreateAgentDm`/`findOrCreateAgentDmLocked`/`persistAgentDmInTx`/`listAgentDmsForDevice`/`getAgentDmOrThrow`/`findAgentDevice`;`toSummary` 删 494-501 的 agent 分支 + 523 的 `agentDeviceId` 字段;删构造器对 `DeviceService`(14 import / 48 注入)的依赖——确认删上述方法后 toSummary 不再用 `this.devices`,若确不再用则移除注入)
- Modify: `libs/main/src/entities/conversation.entity.ts`(删 27 `agentDeviceId!` + 26 的 `@Column`)
- Modify: `libs/main/src/entities/message.entity.ts`(删 18 `senderType!` + 17 的 `@Column`)
- Modify: `libs/main/src/services/message.service.ts`(`persistMessage` ~26-40 去 senderType 参数;`toImMessage` ~101-109 去 senderType 字段)
- Modify: `apps/server-main/src/rest/im.controller.ts`(删 `createAgentDm`(127-138)+ `CreateAgentDmDto` import(5);**保留** `deviceOnline` + `DevicePresenceService`)
- Modify: `apps/server-main/src/ws/im.gateway.ts`(删 `handleSend` device 分支(229-246)、尾部 agentInbound 定向下发(264-276)、`ImAgentInboundEvent` import(21);**保留** presence/device-token/`client.join`)
- Modify: `libs/main/src/dto/index.ts`(删 `CreateAgentDmDto` + `CreateAgentDmSchema/Input` import,5-6/101-102)
- Modify: `libs/main/src/errors/main.error-codes.ts`(删 `AGENT_DEVICE_INVALID`,115)
- Modify: `libs/types/src/im/im.schema.ts`(删 `ConversationSummary.agentDeviceId`(35)、`ImMessageSchema.senderType`(11))

**Interfaces:**
- Consumes: 无(Task 2 后 server-agent 不再用这些;web-main 已删)。
- Produces: 云端不再有 agent-dms/agentInbound 下发;`Conversation` 无 agentDeviceId、`Message` 无 senderType;`ConversationSummary`/`ImMessageSchema` 去掉对应字段。

- [ ] **Step 1: 删 agent-device.controller + app.module 注册**

```bash
cd /Users/grant/Meta1/meshbot
git rm apps/server-main/src/rest/agent-device.controller.ts
```
删 `app.module.ts:49` 的 import 与 `:215` 的 `AgentDeviceController,`。

- [ ] **Step 2: 删 ConversationService 的 Agent-DM 方法 + toSummary agent 分支**

删 `conversation.service.ts` 的 6 个方法(214-298);`toSummary`(475-532)删 494-501 的 `if (conv.type === "dm" && conv.agentDeviceId) {...}` 分支与 523 的 `agentDeviceId: conv.agentDeviceId ?? null,`;确认 `this.devices` 不再被引用后,删构造器注入 `private readonly devices: DeviceService`(48)与 import(14)。
```bash
grep -n "this.devices" libs/main/src/services/conversation.service.ts || echo "devices 已无引用,可删注入"
```

- [ ] **Step 3: 删 entity 列 + message.service senderType + im.schema 字段**

- `conversation.entity.ts`:删 26-27(`@Column(...) agentDeviceId!: string | null;`)。
- `message.entity.ts`:删 17-18(`@Column(...) senderType!: "user" | "agent";`)。
- `message.service.ts`:`persistMessage` 去掉 `senderType` 入参与写入;`toImMessage` 去掉 `senderType` 字段。
- `im.schema.ts`:删 `ConversationSummary` 的 `agentDeviceId`(35)、`ImMessageSchema` 的 `senderType`(11)。

- [ ] **Step 4: 删 im.controller.createAgentDm + gateway device 分支/agentInbound + dto + error code**

- `im.controller.ts`:删 `createAgentDm`(127-138)+ `CreateAgentDmDto` import(5)。
- `im.gateway.ts`:删 `handleSend` 的 `if (payload.deviceId) {...}` device 分支(229-246)、尾部 `findAgentDevice`→emit `agentInbound`(264-276)、`ImAgentInboundEvent` import(21)。handleSend 只剩用户分支(可见性校验→persistMessage→广播 conv 房间)。
- `dto/index.ts`:删 `CreateAgentDmDto`(101-102)+ import(5-6)。
- `main.error-codes.ts`:删 `AGENT_DEVICE_INVALID`(115)。

- [ ] **Step 5: 校验**

Run:
```bash
grep -rn "agentDeviceId\|AgentDm\|agent-dms\|createAgentDm\|senderType\|AGENT_DEVICE_INVALID\|findAgentDevice" apps/server-main/src libs/main/src || echo "server-main/libs-main 无残留"
npx tsc --noEmit -p apps/server-main/tsconfig.json
pnpm test 2>&1 | tail -5
pnpm check:repo
```
Expected: 无残留;tsc 0;测试全绿;check:repo 绿(ConversationService 去 DeviceService 注入后归属不变)。

- [ ] **Step 6: 提交**

```bash
npx biome check --write apps/server-main/src libs/main/src libs/types/src
git add -A apps/server-main libs/main libs/types
git commit -m "refactor(server-main): 移除 Agent-DM(agent-dms/agentInbound 下发/agentDeviceId/senderType)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: libs/types 收尾(agentInbound 事件 + CreateAgentDm DTO)

**Files:**
- Modify: `libs/types/src/im/im.events.ts`(删 `agentInbound: "im.agent_inbound"`(16)与 `ImAgentInboundEvent` 接口(45-51))
- Modify: `libs/types/src/im/im.schema.ts`(删 `CreateAgentDmSchema`/`CreateAgentDmInput`(64-67))
- Modify: `libs/types/src/index.ts`(删 `ImAgentInboundEvent`(29)、`CreateAgentDmInput`(43)、`CreateAgentDmSchema`(44) 导出)

**Interfaces:**
- Consumes: 无(Task 2/3 后全仓库不再引用这些)。
- Produces: libs/types 不再含任何 Agent-DM 契约。

- [ ] **Step 1: 删事件 + DTO + 导出**

按上述行删除。

- [ ] **Step 2: 全仓校验(确认无任何引用)**

Run:
```bash
grep -rn "agentInbound\|agent_inbound\|ImAgentInboundEvent\|CreateAgentDm" apps libs packages --include=*.ts --include=*.tsx | grep -v node_modules || echo "全仓无 Agent-DM 残留"
pnpm typecheck
pnpm test 2>&1 | tail -5
```
Expected: 全仓无残留;typecheck 全绿;test 全绿 + 1 skip。

- [ ] **Step 3: 提交**

```bash
npx biome check --write libs/types/src
git add -A libs/types
git commit -m "refactor(types): 移除 Agent-DM 契约(agentInbound 事件 + CreateAgentDm DTO)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: 云端 DDL(drop agent_device_id / sender_type)

**Files:**
- Create: `apps/server-main/migrations/<YYYYMMDDHHmm>-drop-agent-dm-columns.sql`

**Interfaces:**
- Produces: 云端 Postgres 删 `conversation.agent_device_id`(+index)、`message.sender_type`。DBA 手动执行,服务不自动跑。

- [ ] **Step 1: 写 DDL**

新建 `apps/server-main/migrations/<按约定的 YYYYMMDDHHmm>-drop-agent-dm-columns.sql`:
```sql
-- 移除 Agent-DM:conversation.agent_device_id + message.sender_type(幂等,DBA 手动执行)
DROP INDEX IF EXISTS ix_conversation_agent_device;
ALTER TABLE conversation DROP COLUMN IF EXISTS agent_device_id;
ALTER TABLE message DROP COLUMN IF EXISTS sender_type;
```
(index 名以现网实际为准;若 `202607041000-agent-dm-columns.sql` 建的 index 名不同,对齐之。)

- [ ] **Step 2: 校验(不执行,仅静态)**

Run:
```bash
pnpm check 2>&1 | tail -5
```
Expected: 静态围栏全绿(DDL 文件不参与运行,服务任何模式不自动建/改表)。

- [ ] **Step 3: 提交 + 交接 DBA**

```bash
git add apps/server-main/migrations
git commit -m "chore(server-main): 加移除 Agent-DM 列的 DDL(agent_device_id/sender_type,DBA 手动执行)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
提醒:该 DDL 需 DBA 在部署环境手动执行;应用侧 Entity 已在 Task 3 去列,读写不再涉及该列,先合代码不阻塞(列残留不影响)。

---

## Self-Review(作者已过一遍)

- **Spec 覆盖(Part A)**:web-main /messages → Task 1;server-agent AgentInbox/ImAgentSession/im-agent/relay → Task 2;server-main agent-dms/gateway/entity 列/senderType → Task 3;types 事件/DTO → Task 4;云端 DDL → Task 5。保留清单(普通 IM + 设备在线态)在 Global Constraints 明列。
- **占位扫描**:无 TBD;`<TIMESTAMP>`/`<YYYYMMDDHHmm>` 是迁移/DDL 命名约定占位,已注明如何取值。删除步给了精确文件 + 方法名 + 行号 + 反注册点。
- **顺序可编译**:web-main(自足)→ server-agent(仍引用 types.agentInbound,合法)→ server-main(同任务改共享 schema 的 agentDeviceId/senderType)→ types(此时全仓无引用才删事件/DTO)→ DDL。每任务末 typecheck + test 卡关。
- **类型一致**:`agentDeviceId`(entity/ConversationSummary/toSummary)同在 Task 3 处理;`senderType`(entity/message.service/ImMessageSchema)同在 Task 3;`agentInbound`(server-agent Task2、server-main Task3 去引用,types Task4 删定义)顺序不倒挂。
- **测试基建**:无新单测(删代码);删迁移的旧 spec 同步删;新 Drop 迁移仿现有 Drop 迁移可选补 spec。验收靠全量 typecheck/test/check:repo 保持绿。
</content>
