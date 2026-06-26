# GraphService 上帝类拆分设计（按职责拆成 5 单元 + 直接注入）

**日期：** 2026-06-26
**状态：** 待实施

## 背景与目标

`libs/agent/src/graph/graph.service.ts` 已膨胀到 **1071 行 / 42KB**，是整个 Agent 引擎的单一故障点。它在一个类里同时承担：流式编排、checkpoint 读写/修复、上下文消息组装、模型解析/缓存、压缩摘要。趁它还没到 80KB 拆开，比以后便宜。

**目标**：按职责拆成多个单一职责单元，**零行为变更**，每步可独立验证。终态采用**直接注入**——外部消费者各注入所需聚焦服务，`GraphService` 删除。

**非目标**：不改任何外部可观察行为；不修那 3 个预存在的 LangChain mock 测试红（属基线，另案）；不引入新功能。

### 关键决策（来自 brainstorm）

| 维度 | 决策 |
|------|------|
| 消费者策略 | **直接注入**：6 个消费者改注入聚焦服务，GraphService 删除 |
| context-builder | **独立文件**（组装逻辑单独可测） |
| summarize | 归 **model-resolver**（本质是 model.invoke + 超时，与模型同类） |
| 迁移方式 | **迁移期临时 facade** 逐步空心化，自底向上，每个 commit 都绿，终态删 facade |

---

## 现状：职责与外部消费者

`GraphService` 被 `@meshbot/agent` 导出，注入进 6 个 server-agent 服务：

| 消费者 | 用到的方法 |
|--------|-----------|
| `runner.service` | `streamMessage` / `resumeStream` |
| `context-compactor.service` | `getMessagesSnapshot` / `summarize` / `applyCompaction` |
| `session-title.service` | `getTitleModel` |
| `suggestion.service` | `getTitleModel` |
| `session.service` | `cutMessagesAfter` |
| `checkpointer-cleanup.service` | `clearThread` |

`getHistory` / `startSession` 当前主要被测试与会话创建路径用，亦属公共 API。

### 硬耦合（决定拆分形态）

- **`accountGraph()`**：按账号缓存 `{graph, checkpointer}`，几乎每个方法都经它 → 必须有共享底座。
- **`resolveMessageId`/`msgIdMap`**：supervisor 节点（写 checkpointer）与 `runGraphStream`（发事件）共用**同一实例**，保证 id 三处收口。
- **`modelMeta`**：`resolveModel()` 当副作用 set、`runGraphStream` 事后读以标注 usage（隐式时序耦合）。

---

## 目标架构：5 单元 + 内部底座

```
libs/agent/src/graph/
├── account-graph.provider.ts   【新·内部底座，不对外】
│     graphsByAccount / accountGraph() / msgIdMap + resolveMessageId
│     唯一调用 buildSupervisorGraph + createSqliteCheckpointer 之处
├── model-resolver.service.ts   resolveModel / getTitleModel / modelCache
│                                / modelMeta + getMeta() / summarize
├── thread-state.service.ts     clearThread / sanitizeOrphanToolCalls / cutMessagesAfter
│                                / getMessagesSnapshot / getHistory / applyCompaction
├── context-builder.ts          buildContextMessage / buildSkillsMessage / buildMemorySection
│                                （+ 模块级 buildSkillsBlock 迁来）
├── graph-runner.service.ts     streamMessage / resumeStream / streamMessageImpl
│                                / runGraphStream / startSession
│                                （+ 模块级 extractToolCallArgDeltas / resolveToolCallId 迁来）
├── graph.types.ts              【新】AgentConfig / Message / ThreadId / StreamChunk 类型落脚
└── graph.service.ts            最终删除
```

### 依赖方向（单向无环）

- `graph-runner` → `account-graph` + `model-resolver` + `context-builder` + `thread-state`
- `thread-state` → `account-graph`
- `model-resolver` → 独立（DB 读配置 + createChatModel）
- `context-builder` → prompt / memory / skills / runtimeContext / account
- `account-graph` → checkpoint factory + graph builder（叶子底座）

### 消费者重映射（终态）

| 消费者 | 注入 | 取 |
|--------|------|----|
| `runner.service` | `GraphRunner` | streamMessage / resumeStream |
| `context-compactor` | `ThreadStateService` + `ModelResolver` | getMessagesSnapshot / applyCompaction；summarize |
| `session-title` | `ModelResolver` | getTitleModel |
| `suggestion` | `ModelResolver` | getTitleModel |
| `session.service` | `ThreadStateService` | cutMessagesAfter |
| `checkpointer-cleanup` | `ThreadStateService` | clearThread |

---

## 两个耦合的显式处理

1. **modelMeta 时序**：`ModelResolver` 独占 `modelMeta`，`resolveModel()` 内部仍 set 它，对外暴露 `getMeta(): {providerType, model}`。`GraphRunner.runGraphStream` 标注 usage 时调 `modelResolver.getMeta()` 而非读字段。`account-graph` 建图传入的 `modelProvider` 仍是 `() => modelResolver.resolveModel()`，时序等价但耦合变显式。

2. **resolveMessageId 单实例**：`AccountGraphProvider` 持有 `msgIdMap` + `resolveMessageId`；`accountGraph()` 建图时把 `resolveMessageId` 注入 supervisor 节点；`GraphRunner` 通过 `accountGraphProvider.resolveMessageId(...)` 取同一映射 → 三处 id 收口不破。

---

## 迁移策略：临时 facade，自底向上，每步绿

`GraphService` 在迁移期当**过渡脚手架**逐步空心化；终态随它一起删除（不是永久 facade）。

1. 抽 `AccountGraphProvider`（底座）；GraphService 内部持有它，`accountGraph`/`resolveMessageId` 委派过去。绿。
2. 抽 `ModelResolver`；GraphService 委派 `resolveModel`/`getTitleModel`/`summarize`。绿。
3. 抽 `ContextBuilder`；GraphService 委派 `buildContextMessage`/`buildSkillsMessage`/`buildMemorySection`。绿。
4. 抽 `ThreadStateService`；GraphService 委派 6 个 checkpoint 方法。绿。
5. 抽 `GraphRunner`；GraphService 委派 `streamMessage`/`resumeStream`/`startSession`。此时 GraphService 是纯薄壳。绿。
6. **翻消费者**：6 个服务改注入聚焦服务，同步改其单测/构造。绿。
7. **删 GraphService**：把 `graph.service.test.ts` 按服务拆成 `graph-runner` / `context-builder` / `thread-state` / `model-resolver` 各自单测；更新 `agent.module.ts` providers/exports 与 `index.ts` barrel。绿。

每步独立 commit、独立可回滚。

---

## 必须守住的不变量（"零行为变更"的具体含义）

- **resolveMessageId 单实例** → id 三处收口（checkpointer / session_messages / WS 事件）。
- **checkpointer 每账号一条常驻连接、从不关闭**；`clearThread` 仍复用 `checkpointer.db` 同一 better-sqlite3 连接（不另开、不与 SqliteSaver 争锁）。
- **账号隔离**：所有路径仍走 `account.getOrThrow()`。
- **system:ctx / system:skills 稳定 id 原地刷新**（reducer 按 id 更新、不累积）。
- **`sanitizeOrphanToolCalls` 在 stream/resume 前跑**。
- **modelMeta 行为等价**（改显式 getMeta()，不改语义）。
- **StreamChunk 事件序列与字段不变**；`extractToolCallArgDeltas`/`resolveToolCallId`/`buildSkillsBlock` 逻辑原样迁移。
- **barrel 兼容**：`@meshbot/agent` 仍导出 `AgentConfig`/`Message`/`StreamChunk`/`ThreadId`（从 `graph.types`）；移除 `GraphService`，新增 `GraphRunner`/`ModelResolver`/`ThreadStateService`；`ModelProvider`/`COMPACTION_SYSTEM_PROMPT` 不变。

---

## 测试策略

- **安全网**：现有**通过**的测试必须保持通过；`pnpm --filter @meshbot/agent typecheck`、根 `pnpm check` 全绿；server-agent typecheck 绿。
- **拆测试**：`graph.service.test.ts`（streamMessage / getHistory / resumeStream / buildContextMessage / buildMemorySection / system:ctx 刷新）按新服务边界拆到对应 `*.test.ts`，断言不变。
- **基线红保持**：3 个预存在 LangChain mock 失败（graph.service.test 里 streamMessage/resumeStream 相关）拆分后归位、**保持同样的红**，不在本次"顺手修"。判回归用 diff 失败集合的方法（对比拆分前后 libs/agent vitest 的失败清单，而非看总数）。
- **端到端兜底**：runner / context-compactor 集成 + agent.module 集成（后者本就属基线红）覆盖跨服务装配。
- **消费者侧**：6 个服务的单测随注入变更同步更新，断言其调用委派到正确的新服务。

---

## 交付清单

**新增**
- `libs/agent/src/graph/account-graph.provider.ts`
- `libs/agent/src/graph/model-resolver.service.ts`
- `libs/agent/src/graph/thread-state.service.ts`
- `libs/agent/src/graph/context-builder.ts`
- `libs/agent/src/graph/graph-runner.service.ts`
- `libs/agent/src/graph/graph.types.ts`
- 对应 `tests/unit/*.test.ts`（由 graph.service.test.ts 拆分而来）

**改动**
- `libs/agent/src/agent.module.ts`（providers：移除 GraphService，加入 5 服务；exports 同步）
- `libs/agent/src/index.ts`（barrel：类型改从 graph.types 导出，服务换名）
- 6 个 server-agent 消费者服务（注入变更）+ 它们的单测
- `libs/agent/src/graph/nodes/supervisor.node.ts`（如建图入参签名因 resolveMessageId 归属调整，按需微调）

**删除**
- `libs/agent/src/graph/graph.service.ts`
- `libs/agent/tests/unit/graph.service.test.ts`（内容拆分迁出后）
