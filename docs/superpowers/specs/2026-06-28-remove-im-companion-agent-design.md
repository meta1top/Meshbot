# 彻底删除 IM 伴生 Agent（companion）功能 设计

> 状态：已通过 brainstorm，待评审 → writing-plans
> 日期：2026-06-28
> 关联：[[2026-06-17-phase3-im-companion-agent-design]]（被删功能的原始设计）、[[2026-06-27-im-send-message-hitl-design]]（助手发 IM 走的是另一条 HITL 路径，与本功能无关）

## 1. 背景与目标

「IM 伴生 Agent」让频道/私聊里 agent 自动代答：relay 收到入站 IM 消息 → `ImAgentService.onImMessage` → 建/找一个 `kind='im'` 伴生 session → 按 `[我]/[对端]` 摄入 → `shouldTriggerCompanion`（私信对端 / 频道 @ 自己）→ `runner.kick` 自动跑 LLM（回复只存本地伴生会话、不发回 IM）。

**现状问题**：该功能产品上已下线，但只下线了「前端入口」——而前端入口其实从来没接上（`rest/im-agent.ts`、`agent-toggle.tsx` 全仓零导入，是死代码）。**后端 `ImAgentService` 仍在运行**，且 `findOrCreateImCompanion` 默认 `agentEnabled: true`，导致任意 IM 会话只要对端发消息就**静默自动跑一轮 LLM**（消耗 token、产生用户意外的 trace）。

**目标**：彻底删除该功能——后端编排 + entity 伴生字段 + 数据库迁移清理 + 前端死代码 + 已有伴生数据。让「频道/私聊 agent 自动代答」从代码、schema、数据三个层面都不复存在。

## 2. 非目标 / 明确保留（不能删）

- **relay 入站订阅 + emit `IM_WS_EVENTS.message`**（`ImRelayClientService`）：`EventsGateway.onMessage` 仍消费它下行给浏览器（消息列表实时刷新），**保留**。删 `ImAgentService` 只是少一个消费者。
- **IM 浏览功能**：`CloudImService`（列会话/读消息/成员）、`CloudImController`、`SidebarController`、`EventsGateway` —— 与伴生无关，**保留**。
- **`kind` 枚举的 `user` / `quick`**：普通会话/随手问，保留；只去掉 `im`。
- **`SessionService.listAllSorted` 的 `kind='user'` 过滤**：仍要排除 quick，**保留**（删 im 后不影响）。
- **checkpointer（每账号独立 SQLite 库）里伴生 thread 的 `n`/`writes` 行**：迁移（跑在主库 agent.db）够不到；不再被引用、无害，**留着**（不为此引入运行时按账号清理，YAGNI）。
- **不做** 助手发 IM（那是 `im_send_message` HITL，独立功能）。

## 3. 删除清单

### 3.1 后端代码

**整删 6 个文件**（经 audit 确认只服务伴生、无其它引用）：
- `apps/server-agent/src/services/im-agent.service.ts`（+ `im-agent.service.spec.ts`）
- `apps/server-agent/src/services/im-agent.trigger.ts`（+ `im-agent.trigger.spec.ts`）
- `apps/server-agent/src/controllers/im-agent.controller.ts`
- `apps/server-agent/src/dto/im-agent.dto.ts`

**改 `apps/server-agent/src/services/session.service.ts`**：删三个伴生方法 `findOrCreateImCompanion` / `getImCompanion` / `setCompanionAgentEnabled` 及其在 `session.service.spec.ts` 里的用例。`listAllSorted` 的 `kind='user'` 过滤保留。

**改 `apps/server-agent/src/im.module.ts`**：移除 `ImAgentService` / `ImAgentController` 的 import 与 `providers`/`controllers` 注册。

**改 `libs/types`（im schema）**：删伴生专属 schema/类型（`SetAgentEnabledSchema` 及前端 `AgentSession` 接口等）。实现时先 `rg` 确认全仓无其它引用再删；若发现被共享则保留并在 plan 注明。

### 3.2 Session entity（`apps/server-agent/src/entities/session.entity.ts`）

- 删字段：`imConversationId`、`imConvType`、`agentEnabled`。
- 删 `@Index("uq_sessions_im_companion", …, { unique, where: "kind = 'im'" })`。
- `kind` 改 `"user" | "quick"`（去掉 `"im"`）。

### 3.3 数据库迁移

**铁律：迁移文件不可变** → **不改** `1780500000000-SnowflakePrimaryKeys.ts`（它仍 CREATE 含伴生字段的 sessions 表）。**新建** `apps/server-agent/src/migrations/1780600000000-DropSessionImCompanionFields.ts`，`up()` 按顺序：

1. `DROP INDEX IF EXISTS "uq_sessions_im_companion"`（DROP COLUMN 前必须先删引用该列的索引）。
2. 清主库伴生数据（SQLite 无 FK 级联，手动按 session 删关联）：
   - `DELETE FROM "session_messages" WHERE "session_id" IN (SELECT "id" FROM "sessions" WHERE "kind" = 'im')`
   - 同样 `DELETE FROM "pending_messages" …`、`DELETE FROM "llm_calls" …`
   - `DELETE FROM "sessions" WHERE "kind" = 'im'`
3. 删列（SQLite 3.53 支持 `ALTER TABLE DROP COLUMN`）：
   - `ALTER TABLE "sessions" DROP COLUMN "agent_enabled"`
   - `ALTER TABLE "sessions" DROP COLUMN "im_conv_type"`
   - `ALTER TABLE "sessions" DROP COLUMN "im_conversation_id"`

`down()` 写反向（加回列/索引；可不还原已删数据）——与同目录既有迁移风格一致。

最终：新装机器跑完 1780500000000（建含伴生字段表）→ 1780600000000（删）= 干净 schema；已有机器启动自动跑 1780600000000，清掉伴生数据与列。

### 3.4 前端死代码（`apps/web-agent`）

- 整删 `src/rest/im-agent.ts`、`src/components/im/agent-toggle.tsx`（均零导入）。
- 删 i18n orphan keys：`messages/en.json` + `messages/zh.json` 里 `agentPanelTitle` / `agentSuggestion` / `agentSendToConversation` / `agentNoCandidate` / `agentInputPlaceholder` / `agentEmptyHint` / `agentDisabledHint`（含各自的空值/fallback 副本）。删后跑 `pnpm sync:locales`（或等价）确认无残留、键对齐。
- `src/hooks/use-session-stream.ts` 第 58 行附近注释：去掉「供侧栏在伴生会话未就绪时安全挂载」的伴生措辞，改为通用「sessionId 为 null 时惰性 inert」描述。hook 逻辑不动。

## 4. 不变量 / 边界

- 删后 `IM_WS_EVENTS.message` 仍被 `EventsGateway.onMessage` 消费，浏览器 IM 实时刷新不受影响。
- `sessions` 表删伴生列后，`session.entity` 与 schema 一致（boot 时 `synchronize:false` + 迁移已对齐）。
- `kind` 仅剩 `user`/`quick`；DB 中不再有 `kind='im'` 行。
- 账号作用域、IM 浏览、随手问、普通会话、`im_send_message` HITL 等其它功能不受影响。

## 5. 测试与验证

- 删伴生专属 spec（im-agent.service.spec / im-agent.trigger.spec）；`session.service.spec` 删伴生用例。
- **新增迁移单测**（`apps/server-agent/src/migrations/__tests__/`，仿既有迁移测试）：构造含 `kind='im'` 行 + 伴生列的库，跑 `1780600000000` 后断言：① 伴生列不存在（`PRAGMA table_info(sessions)` 无 im_conversation_id 等）② `uq_sessions_im_companion` 索引不存在 ③ `kind='im'` 行及其关联 session_messages/pending/llm_calls 已清。迁移是高风险点。
- **boot 验证（必做）**：真启 `pnpm dev:server-agent`，确认 ① 无 Nest DI 报错（删 provider/controller）② 迁移自动跑成功（`migrationsRun:true`）③ 启动到监听 3100。
- 常规：全包 typecheck、jest 全量（基线不新增失败）、libs/agent vitest 基线、`pnpm check` 围栏。

## 6. 涉及文件（汇总）

**删**：im-agent.service.ts(+spec)、im-agent.trigger.ts(+spec)、im-agent.controller.ts、im-agent.dto.ts、web-agent rest/im-agent.ts、web-agent components/im/agent-toggle.tsx。
**改**：session.service.ts(+spec)、session.entity.ts、im.module.ts、libs/types im schema、web-agent use-session-stream.ts、web-agent messages/{en,zh}.json。
**新建**：migrations/1780600000000-DropSessionImCompanionFields.ts（+ __tests__ 迁移单测）。
