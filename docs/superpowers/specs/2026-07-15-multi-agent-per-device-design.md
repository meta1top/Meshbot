# 一设备多 Agent 设计（Multi-Agent per Device）

> 日期：2026-07-15
> 状态：设计已确认，待写实施计划

## 1. 背景与目标

当前代码里**不存在「agent」这个维度**。唯一的隔离轴是账号 `cloudUserId`：一个账号 = 一套 system prompt + 技能 + MCP + 记忆 + 工作区 + checkpointer。云端远程调度的寻址单位是 `deviceId`，一台设备等于一个 agent。

目标：**一个设备可以创建多个 Agent**，各自拥有不同的人格（system prompt）、技能、MCP、默认模型，做不同的事。每个 Agent 有独立的「允许远程」开关；打开后注册到云端，可被同账号的其他端远程调度。为将来的「本地多 Agent 编组」「跨设备 Agent 编组」留出数据模型空间。

### 本期范围

**做**：Agent 实体（增删改查、名字/头像/prompt/默认模型）、每个 Agent 独立的技能目录与 MCP 配置（不是共享池的子集，是各自安装）、会话绑定 Agent、本地切换 UI、「允许远程」开关与云端注册、云端寻址从 `deviceId` 改为 `agentId`、双轨对等开发规则技能。

**不做**：编组（Agent 之间互相调度）。数据模型不挡路即可。

### 已确认的关键决策

| 决策点 | 结论 |
|---|---|
| Agent 边界 | **完全独立体**：独立记忆 + 独立工作区 + 独立技能目录 + 独立 MCP 进程池 |
| 远程可见性 | **仅本人**（沿用同账号门控）；云端 DDL 预留 `visibility` 字段与 org 索引，UI 不暴露 |
| 存量数据 | **不管存量，直接重来**。无迁移脚本，开发机手工清 `~/.meshbot/accounts/` |
| 定义存储 | **混合**：DB 存元数据（含 system prompt），目录存内容（记忆/技能/MCP/工作区） |
| 本地 UI | **最左 agent 图标导航条** + 主侧栏展示当前 agent 的一切 |
| 云端记录 | **只读投影**。本地是唯一真相，云端不可编辑 |
| 「同步」附加需求 | **工程规则**（双轨功能对等的 `.claude` 技能），不是运行时双向数据同步 |

---

## 2. 数据模型

### 2.1 本地 SQLite（`main.db`）新增 `agents` 表

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | 雪花 PK | |
| `cloud_user_id` | text | 账号隔离，沿用现有唯一隔离轴 |
| `name` | text | 显示名 |
| `avatar` | text | emoji + 背景色（不做图片上传） |
| `description` | text nullable | 云端列表展示用 |
| `system_prompt` | text | Agent 人格正文 |
| `default_model_config_id` | text nullable | 指向 `model_configs` |
| `remote_enabled` | bool | 默认 **false**，即「允许远程」开关 |
| `visibility` | text | `'private' \| 'org'`，本期恒 `private` |
| `sort_order` | int | 导航条排序 |
| `created_at` / `updated_at` | | |

### 2.2 `sessions` 增加 `agent_id` 列（NOT NULL）

subagent 子会话继承父会话的 `agent_id`。做法照抄已有的 `1780800000000-AddSessionBackgroundAndModel.ts`（`model_config_id` 那次）。

### 2.3 目录布局下沉到 agent 级

```
~/.meshbot/accounts/<cloudUserId>/
├── main.db                    # 业务库（账号级，含 agents 表）
├── agent.db                   # checkpointer（账号级，不下沉 ← 硬不变量）
└── agents/<agentId>/
    ├── memory/{core.md, archival/}
    ├── skills/<name>/SKILL.md
    ├── mcp.json
    └── workspace/             # 该 agent 的文件根
```

**checkpointer 故意不下沉。** `thread_id` 就是 session id，天然隔离；且现有 subagent 图复用同一 checkpointer 是硬不变量（`libs/agent/src/graph/account-graph.provider.ts:101`），拆库会打破它。每 agent 一个 db 文件只增加句柄与 WAL 开销，换不到任何隔离收益。

### 2.4 云端 Postgres 新表 `agent`

列：`id`（云端雪花 PK）/ `device_id` / `user_id` / `org_id` / `local_agent_id` / `name` / `avatar` / `description` / `visibility` / `last_synced_at` / `deleted_at`。

唯一索引：`(device_id, local_agent_id) WHERE deleted_at IS NULL`。

**云端另发自己的 id**，不复用本地雪花——本地 id 由设备自行生成，跨设备/重装可能重复。`(device_id, local_agent_id)` 唯一约束让重复注册天然幂等。前端寻址用云端 id；网关下发到 `device:<deviceId>` room 时在 payload 里带上 `local_agent_id`，本地拿到直接可用。

**`device` 表一个字段不改**。`uq_device_user_machine`（一机一账号一行）保持原样，agent 挂在 device 之下。

DDL 走 `ddl-migration` 技能那套：纯 SQL 文件、幂等（`IF NOT EXISTS`）、文件不可变、DBA 手动执行。

---

## 3. 本地运行时改造（libs/agent + server-agent）

### 3.1 ALS 增加 agent 维度

`AccountContext` 的 ALS 目前只有 `cloudUserId`，新增 `agentId`。由 `RunnerService` 在开 run 时从 `session.agentId` 读出并压栈，写法照抄 `ModelRunContext`：**必须包住「建流 + for-await 整段」**（`apps/server-agent/src/services/runner.service.ts:474-479` 有血泪注释：async generator 的 `next()` 跑在调用方上下文，包不全会串台）。

所有下游（路径 getter、技能扫描、MCP、工具过滤）从 ALS 取 `agentId`，**不改函数签名**。

### 3.2 人格注入改为「每轮刷新」——全案最大的坑

现状：system prompt 只在会话首轮 push 进 checkpointer（`libs/agent/src/graph/graph-runner.service.ts:281-287`），之后永不刷新。多 agent 下，改了 prompt 或换了 agent，旧会话仍带旧人格，**且静默不报错**。

改法：人格做成稳定 id 的 `system:persona` 消息，走 `system:ctx` 那套 reducer 原地替换（`libs/agent/src/graph/graph.builder.ts:47-82`）。

### 3.3 路径 getter 全部下沉

`MeshbotConfigService` 的账号级 getter（memory / skills / mcp.json / workspace）改成从 ALS 取 `agentId`，拼 `agents/<agentId>/...`。

`PromptService` 不再负责人格（人格进了 DB），只保留 session-title / next-action-suggestions 两个模板，仍是账号级。

### 3.4 MCP：按 agent 隔离进程池 + 懒加载

`McpService.perAccount` 的 key 加 agent 维度。

但现状是**登录时一次性起全部 MCP**（`apps/server-agent/src/account/account-runtime.registry.ts:37-45`）——5 个 agent × 3 个 stdio server = 登录就拉 15 个子进程。改成：

- **agent 首次被使用时才 init 它的 MCP 池**
- **闲置超时（30 分钟）回收**；回收前必须确认该 agent 无正在运行的 run
- 登出仍整账号 teardown

### 3.5 工具过滤（白送）

图里绑的是惰性 provider，`ToolRegistry.asLangChainBindable()` 每轮重新求值（`libs/agent/src/graph/supervisor.node.ts:33`）。加 agent 维度只需在 `accountEntries` 的 key 上带 `agentId`，**图一行不改**。

### 3.6 图缓存 key

`AccountGraphProvider` 的两个 Map（`graphsByAccount` / `subGraphsByAccount`）key 从 `cloudUserId` 变成 `${cloudUserId}:${agentId}`，subagent 变体同理。**checkpointer 仍按账号取**（见 2.3）。

### 3.7 模型解析优先级

`session.modelConfigId` > `agent.defaultModelConfigId` > 账号 enabled 首行。现有 `ModelResolver.resolveModel()`（`libs/agent/src/graph/model-resolver.service.ts:102-137`）只有首尾两级，中间插一层。

### 3.8 QuickAssistant 收编

`quick_assistant_name` Setting 废弃，名字统一由 `agent.name` 提供。`rename_quick_assistant` 工具改成「重命名当前 agent」。快捷会话（`kind='quick'`）归属**当前选中的 agent**。

---

## 4. 云端注册与寻址

### 4.1 注册 = 单向推送 + 全量对账

本地新增 `AgentRegistrySyncService`。触发时机照抄 `model-config-sync.service.ts` 的四个入口（启动 / 登录 / relay 连接 / 本地变更），但方向相反（推，不是拉）：

- `PUT /api/agent/agents`（device token 鉴权）
- body = **当前所有 `remote_enabled = true` 的 agent 元数据全量列表**
- 云端按 `(device_id, local_agent_id)` upsert；**列表里未出现的一律软删**

所以「关掉开关 / 改名 / 删 agent」全走同一条路，不需要单独的下线接口。

**只上元数据**：`name` / `avatar` / `description`。prompt、技能、MCP 配置**不出本地**。

### 4.2 寻址从 deviceId 换成 agentId

`AgentRunStartInput.targetDeviceId` → `targetAgentId`（云端 id）。网关（`apps/server-main/src/ws/im.gateway.ts:501-503`）收到后：

1. 查 agent 行
2. 校验 `agent.userId === requesterUserId` 且 `deleted_at IS NULL`
3. 拿到 `deviceId`，做在线检查
4. `emit` 到 `device:<deviceId>` room，payload 带 `localAgentId`

**Socket 连接数不变**：relay 仍是「一台设备一条 socket」，agent 只是 payload 里的一个字段。

L2c 只读查询通道（`device.query.*`）同构改：会话归属 agent，查询也要带 `targetAgentId`。

### 4.3 本地二次门控（安全关键）

B 侧 `RemoteRunInboundService`（`apps/server-agent/src/services/remote-run-inbound.service.ts:109`）收到请求后**不信云端**：本地查 `agents` 表，确认该 agent 存在且 `remote_enabled = true`，否则拒绝。

云端数据可能过期（设备离线时关了开关、尚未对账），**本地是唯一真相**。这条同时补上了现状的空白——今天只要设备在线且同账号，任何端都能远程 kick 它跑 agent，没有任何开关。

### 4.4 顺带改掉一个命名地雷

现有 presence key 前缀是 `agent:<deviceId>`（`device-presence.service.ts` + `apps/web-main/src/rest/agent-devices.ts:13`）。引入真 agent 后这个名字会毒害整个代码库，重命名为 `device:<deviceId>`。

### 4.5 web-main

- 路由 `/assistant/[deviceId]` → `/assistant/[agentId]`
- 启动台（`launcher.tsx`）与侧栏（`assistant-sidebar.tsx`）从「设备列表」变成**扁平 agent 列表**：每个 agent 显示宿主设备名 + 在线点，**在线态从宿主设备派生**
- 设备本身仍在设置页可见可管理，但不再是会话入口

---

## 5. 本地 UI（web-agent）

**最左 agent 图标导航条**（约 56px）：圆形头像（emoji + 背景色）、运行中脉冲点、hover 出名字、底部 `+` 新建、当前选中高亮。

**主侧栏 = 当前 agent 的一切**：会话列表 + 技能 / 记忆 / MCP / 设置入口。这几个页面今天是账号级的，全部降级为 agent 级。技能页装的技能只进当前 agent 的目录；MCP 页编辑当前 agent 的 `mcp.json`——**顺带补上 MCP 的 UI，今天它没有任何界面**，只能手改文件。

**Agent 编辑抽屉**：名字 / emoji + 背景色 / 描述 / system prompt（大文本域）/ 默认模型 / **允许远程开关**。开关旁必须写清后果：「打开后，你在其他设备或网页上可以远程调度这个 Agent」。

**新建**：空白新建 + 「从现有 Agent 复制配置」。不做模板市场。

**首次启动引导**：`sessions.agent_id` 是 NOT NULL，必须保证至少一个 agent 存在。启动时若账号下零 agent，自动建一个默认 agent（名字沿用今天的 `"M"`）。

**已知坑**：前端全局 atom 必须按 agent 隔离。本仓库在 usage atom 上栽过——全局单例 atom 在并发上下文里串台，当时靠 `atomFamily(sessionId)` 修的。切 agent 同理。

所有新文案走 next-intl（`i18n-page` 技能）。

---

## 6. 附加：双轨对等开发规则

新建技能 `.claude/skills/dual-track-parity/SKILL.md`。

**这做不成静态围栏。** 「本地有、云端忘了做」是语义级缺失，`pnpm check:*` 那套 AST 扫描抓不到。它是**规则文档 + 对等矩阵 + 提交前自查清单**，靠 skill 在改动相关文件时触发提醒，不靠脚本卡。写个假围栏只会制造安全感。

技能三块内容：

1. **规则**：任何 Agent 能力变更，必须回答「云端轨要不要对等落地」。默认答案是**要**；不做要在矩阵里写明理由。
2. **对等矩阵**：每行一个能力（会话流式 / 工具确认 HITL / 技能列表 / 记忆 / 文件预览 / todo 面板 …），三列：本地轨状态、云端轨状态、判定（`对等` / `仅本地` / `仅云端`）。
3. **例外白名单**（写死，改它要有明确理由）：
   - **仅本地**：本地文件系统读写、MCP stdio 子进程、桌面壳能力、`mcp.json` 编辑
   - **仅云端**：组织 / 成员 / 邀请、计费、模型网关厂商 key、跨设备设备管理

触发条件：`apps/web-agent/**` 与 `apps/server-agent/**` 变更时激活。

---

## 7. 测试策略

**单测（Jest）**

- `agents` CRUD
- 注册对账的 diff 逻辑（新增 / 改名 / 关开关 → 软删）
- **本地二次门控**：`remote_enabled = false` 时拒绝远程 run
- **ALS agent 隔离**：并发两个 agent 跑 run，技能集与 MCP 工具不串
- 模型解析三级优先级
- **`system:persona` 每轮刷新**：改 prompt 后，后续轮的 system 消息确实变了（防 3.2 的静默错误）

**E2E（server-main）**：注册端点 + `targetAgentId` 鉴权（打不通别人的 agent）。

**迁移**：SQLite migration（新表 + `sessions.agent_id`）；Postgres DDL 文件走 `ddl-migration` 技能。

**手工冒烟（自动化覆盖不到，必须做）**

- 两个 agent 各挂不同 MCP，确认工具不串
- 跨设备远程调度一个 agent，确认 HITL 确认卡回到发起方

---

## 8. 风险

1. **`targetDeviceId → targetAgentId` 一刀切**：relay 帧不兼容，本地端与云端端**必须同版本发布**。旧版 server-agent 连新版 server-main 会**静默收不到** run 请求。本次最大发布风险。
2. **`system:persona` 忘走 reducer 原地替换**：换 agent 后旧会话仍是旧人格，**静默不报错**。单测必须覆盖。
3. **MCP 子进程膨胀**：靠懒加载 + 闲置回收压住。回收本身是新代码，有 run 在跑时误回收会炸——回收前必须检查活跃 run。
4. **存量直接重来**：开发机现有 `~/.meshbot/accounts/` 需手工清掉。不做兼容，`sessions.agent_id` NOT NULL 会让老会话跑不起来。**实施计划里要写成显式一步。**

---

## 9. 关键文件清单

**本地轨**

```
libs/agent/src/graph/graph-runner.service.ts        人格注入（3.2 核心改造点）
libs/agent/src/graph/account-graph.provider.ts      图缓存 key / checkpointer 不变量
libs/agent/src/graph/graph.builder.ts               reducer 原地替换机制
libs/agent/src/graph/context-builder.ts             system:ctx / system:skills 组装
libs/agent/src/graph/model-resolver.service.ts      模型解析三级优先级
libs/agent/src/graph/model-run-context.ts           ALS 范本
libs/agent/src/prompt/prompt.service.ts             人格移出后只剩模板
libs/agent/src/config/meshbot-config.service.ts     所有路径 getter 下沉
libs/agent/src/tools/tool-registry.ts               accountEntries key 加 agent
libs/agent/src/mcp/mcp.service.ts                   perAccount → perAgent + 懒加载
libs/agent/src/skills/skill.service.ts              技能扫描路径
libs/agent/src/account/account-context.service.ts   ALS 底座，加 agentId
apps/server-agent/src/entities/session.entity.ts    加 agent_id 列
apps/server-agent/src/services/runner.service.ts    run 编排，压 agentId 入 ALS
apps/server-agent/src/services/remote-run-inbound.service.ts  本地二次门控
apps/server-agent/src/services/quick-assistant.service.ts     收编到 agent.name
apps/server-agent/src/account/account-runtime.registry.ts     MCP 懒加载时机
```

**云端轨**

```
libs/main/src/entities/device.entity.ts             不改（仅参考唯一索引）
apps/server-main/src/ws/im.gateway.ts               寻址 targetAgentId + presence 改名
apps/server-main/src/rest/agent-config.controller.ts  注册端点邻居
apps/web-main/src/components/assistant/launcher.tsx        设备列表 → agent 列表
apps/web-main/src/components/assistant/assistant-sidebar.tsx
apps/web-main/src/app/(shell)/assistant/[deviceId]/page.tsx  → [agentId]
apps/web-main/src/rest/agent-devices.ts             presence key 改名
libs/types/src/im/im.schema.ts                      targetDeviceId → targetAgentId
```
