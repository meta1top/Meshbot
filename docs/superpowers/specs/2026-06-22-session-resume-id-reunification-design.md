# 会话续传 id 收口（雪花贯穿 checkpointer / 表 / 事件）设计文档

**日期：** 2026-06-22
**状态：** 待实施
**关联：**
- [2026-05-28 刷新/切换会话「续上」保真度修复](./2026-05-28-refresh-resume-fidelity-design.md)
- [2026-06-18 Snowflake Primary Keys](./2026-06-18-snowflake-primary-keys-design.md)

---

## 背景与现象

agent 会话刷新续传出现回归（用户截图）：

- 一条 assistant 已**思考完毕**、开始执行一个**耗时很长的工具**；
- 此时**刷新页面**，时间线上出现**两条内容相同**的 assistant：
  - 一条来自历史：reasoning 折叠为「思考过程」+ 工具 running（正确）；
  - 一条来自 inflight：reasoning 展开为「思考中 35.0s」并**一直计时**（错误，重复）。

复现条件固定为：思考完成 → 工具开始执行 → 工具执行很久 → 刷新。

## 根因（两层，缺一不可）

### 第一层：id 空间割裂（回归来源）

- 全链路真正流通的 canonical id 是 **UUID**：
  - human = 前端生成的 UUID（[session.service.ts:113](../../../apps/server-agent/src/services/session.service.ts#L113) 注释「messageId 由调用方生成（前端 UUID）」）；
  - assistant = 模型在流式中生成的 UUID（`AIMessageChunk.id`）。
  - 这个 UUID 同时存在于：checkpointer 消息 id、所有 `run.*` WS 事件的 `messageId`、`session_messages.langgraph_id` 列。
- 但 `session_messages.id` 是 [insertWithSeq](../../../apps/server-agent/src/services/session-message.service.ts#L106) **另铸的雪花**，只在历史接口对外暴露。
- 历史接口 [GET /history](../../../apps/server-agent/src/controllers/session.controller.ts#L82) 返回 `messages[].id = 雪花`，而 `inflight.messageId = run.messageId = UUID`。
- 前端去重 [use-session-stream.ts:203-207](../../../apps/web-agent/src/hooks/use-session-stream.ts#L203) 用 `!historyIds.has(inflight.messageId)` 判断是否推 inflight 气泡。雪花集合永远不含 UUID → **去重恒成立 → 永远多推一条**。

**这是 2026-06-18 雪花 PK 迁移引入的回归。** 2026-05-28 resume 设计（line 169）的核心不变量是「history 拉回的是稳定数据，WS/inflight 只追加增量，靠同一 id 合并不冲突」；该不变量在 id == langgraphId 时成立，雪花迁移把二者脱钩后被打破。

### 第二层：已落库的轮次仍被当作「活的 partial」

- graph 在 supervisor 节点返回时（**工具执行之前**）就 flush 了 `assistant_done`（[graph.service.ts:575-588](../../../libs/agent/src/graph/graph.service.ts#L575)，注释「避免慢 tool 几十秒空窗，刷新页面看不到」），runner 据此 `recordAssistant` 落库。
- 但 `RunnerService` 没有「当前轮 assistant 已落库」的追踪，[getInflight](../../../apps/server-agent/src/services/runner.service.ts#L109) 仍把这条已落库消息的 `reasoning / content / reasoningStartedAt` 当 inflight partial 吐出。
- 前端拿到该 partial 后推气泡，且 inflight 推送硬编码 `streaming: true`（[use-session-stream.ts:215](../../../apps/web-agent/src/hooks/use-session-stream.ts#L215)）。`ReasoningBlock` 的 `isThinking = streaming === true || ...`（[message-list.tsx:244](../../../apps/web-agent/src/components/session/message-list.tsx#L244)，2026-05-28「前端 2」刻意为「reasoning 流式中刷新」加的强制信号）→ 已完成的思考被强制判为「思考中」并启动 100ms 计时器。

> 2026-05-28 resume 设计表格 #5/#6 本就**期望**「工具执行/完成时新轮 inflight 为空」。第二层正是缺了「该轮已落库 → inflight 不再吐 partial」的实现。

## 目标

让**雪花成为一条逻辑消息在 checkpointer / `session_messages` / WS 事件三处唯一一致的 id**（演进 2026-06-18 的「脱钩」为「收口」），并补上「已落库轮不再作为活 partial」的语义，使任何时机刷新都与刷新前视觉一致、不重复、不误计时。

非目标：跨设备协同、compaction 刷新（已有机制）、run error/interrupted 页面态（另议）。

---

## 方案总览（三块）

| 块 | 作用 | 层 |
|----|------|----|
| **A. id 收口** | 雪花作为 canonical id 贯穿 checkpointer + 表 + 事件，根治 id 空间割裂 | libs/agent graph、runner、session-message.service、web-agent 发送侧 |
| **B. partial 抑制** | 当前轮 assistant 已落库后，`getInflight` 不再吐活 partial（`messageId:null`，status 仍 streaming），handleSubscribe 不回放 | runner、session.gateway |
| **C. 回放幂等（可选硬化）** | WS subscribe 回放改 SET 语义，根治 push+replay / 断线重连的文本翻倍（非持久化轮的既有竞态隐患） | session.gateway、types-agent、web-agent |

- **直接修复截图 bug 的最小集是 A + B**：A 让去重命中、B 让已落库轮不再被推成「思考中」。
- 单独 A：会把重复**气泡**消掉，但 handleSubscribe 仍回放已落库轮的 reasoning → 文本**翻倍**，故必须配 B。
- 单独 B：也能修好截图 bug（已落库轮 `messageId:null` → 不推不回放），但不收口 id，其余刷新时机（如工具结束态 tool result 实时更新、流中切回）仍受 id 割裂困扰。
- C 处理「非持久化轮」push 与 replay 叠加的既有竞态翻倍隐患，标为可选硬化，可在 A+B 落地并测试后单独决策。

---

## A. id 收口：雪花贯穿全链路

### A1. assistant —— 服务端铸雪花，注入 supervisor 节点 + 事件流

**关键可行性：无需 checkpointer 改写手术。** [supervisor.node.ts:61-69](../../../libs/agent/src/graph/nodes/supervisor.node.ts#L61) 本就重新 `new AIMessage({ ... id: accumulated.id ... })`，这是天然注入点：把 `id` 设为雪花，checkpointer 直接存雪花。reducer 按 id append、`routeAfterSupervisor` 看 `tool_calls`、tool 关联看 `tool_call_id`，均不受消息改名影响。

机制：`GraphService` 持有一个「模型UUID → 雪花」解析器，**同时注入 supervisor 节点与 `runGraphStream`**，保证两边对同一条 AIMessage 解析出同一个雪花。

```ts
// GraphService（新增）
private readonly msgIdMap = new Map<string, string>(); // 模型UUID -> 雪花
private resolveMessageId = (modelId: string): string => {
  let s = this.msgIdMap.get(modelId);
  if (!s) { s = generateSnowflakeId(); this.msgIdMap.set(modelId, s); }
  return s;
};
```

- `generateSnowflakeId` 来自 `@meshbot/common`（依赖方向合法：agent → common）。
- 注入：`buildSupervisorGraph(...)`（[graph.service.ts:148](../../../libs/agent/src/graph/graph.service.ts#L148)）增加形参，透传给 `createSupervisorNode`；node 内 `clean.id = resolveMessageId(accumulated.id)`。
- `runGraphStream`（[graph.service.ts:485](../../../libs/agent/src/graph/graph.service.ts#L485)）：每轮首个 chunk 处 `const sid = resolveMessageId(msg.id)`，本轮**所有** yield（reasoning / chunk / reasoning_done / tool_calls / assistant_done / usage）改用 `sid` 作 `messageId`。
- 顺序保证：streamMode "messages" 的 chunk 在 node 返回前到达 → `runGraphStream` 先 `resolveMessageId(UUID)` 建雪花，node 返回时 `resolveMessageId(UUID)` 命中缓存拿同一雪花。get-or-create 两序皆安全。
- map 增长：模型 UUID 全局唯一，仅缓慢增长；`runGraphStream` 结束时清理本 run 见过的 UUID（或按需 LRU）。本地轨单用户，量级可忽略。
- 风险点（实现时验证）：`accumulated.id` 必须等于流出的 `msg.id`（同一条 AIMessage 跨 chunk id 稳定）；若模型不给 id（`msg.id` 缺失），保留每轮兜底生成一个雪花并贯穿本轮。

### A2. human —— 前端生成雪花，落库用同一 id

- 前端发送侧把乐观插入用的 `messageId` 从 UUID 改为**雪花**（本地轨单节点，客户端雪花无碰撞顾虑）。保留「前端先拿到最终 id」以避免 `run.human` 早于 POST 200 的竞态（[session.service.ts:112-116](../../../apps/server-agent/src/services/session.service.ts#L112)）。
- 该 id 原样流入：`pending_messages.id` → checkpointer `HumanMessage.id`（[graph.service.ts:285](../../../libs/agent/src/graph/graph.service.ts#L285) 已传 `id: input.id`）→ `run.human` 事件 → `recordUser`。
- 前端雪花生成器：复用/移植 `libs/common` 雪花算法到 web 侧（`packages/web-common` 或 web-agent lib）。worker 段可固定/随机，单节点免冲突。

### A3. 落库用 langgraphId 作主键 id（收口表侧）

- [insertWithSeq](../../../apps/server-agent/src/services/session-message.service.ts#L99) 把 `id: generateSnowflakeId()` 改为 `id: row.langgraphId`（=贯穿全链路的雪花）。
- `recordUser` / `recordAssistant` / `recordToolResult` / `recordCompactionPlaceholder` 传入的 `langgraphId = input.id` 现在就是雪花 → `session_messages.id == langgraph_id == 事件 messageId == checkpointer 消息 id`。
- 排序仍由 `seq` 列负责（[session-message.entity.ts:21](../../../apps/server-agent/src/entities/session-message.entity.ts#L21)），与 id 取值无关，分页不受影响。
- `langgraph_id` 列暂保留（现在恒等于 id；llm_calls 关联的 `idByLanggraph` 退化为恒等映射，行为不变）。后续可单独清理，本次不动 schema。
- **无需新迁移**：列结构不变，仅改写入值；本地 dev 库可清空重建（沿用 2026-06-18 前提）。

### A4. 收口后去重自动正确

历史 `messages[].id` 与 `inflight.messageId` 同为雪花 → `historyIds.has(inflight.messageId)` 命中 → 已落库轮不再被推（配合 B 更彻底）；流式中切回 / WS 增量按同一 id 合并，不再生成「UUID 气泡 vs 雪花气泡」的双份。

---

## B. partial 抑制：已落库轮不再作为活 partial

`RunnerService`：

- `InflightRun` 增字段 `partialPersisted: boolean`（init `false`）。
- reasoning / chunk handler 中「轮切换」分支（[runner.service.ts:465-469](../../../apps/server-agent/src/services/runner.service.ts#L465) 与 [509-513](../../../apps/server-agent/src/services/runner.service.ts#L509)）置 `partialPersisted = false`（与现有重置 content/reasoning/startedAt 并列）。
- `assistant_done` handler（`recordAssistant` 之后，[runner.service.ts:523-547](../../../apps/server-agent/src/services/runner.service.ts#L523)）置 `partialPersisted = true`。
- `getInflight`（[runner.service.ts:109](../../../apps/server-agent/src/services/runner.service.ts#L109)）：当 `partialPersisted` 为真时返回
  `{ messageId: null, content: "", reasoning: "", reasoningStartedAt: null, status: run.status }`。
  status 仍为 `streaming` → 前端 `setRunning(true)`（停止按钮、输入态不变）；`messageId:null` → 不推气泡、handleSubscribe 跳过回放。
- **不动 `run.messageId`**：它在 `run.done`/`run.error`/`run.interrupted`（[runner.service.ts:308/397/403](../../../apps/server-agent/src/services/runner.service.ts#L308)）标识最终消息，清空会破坏 live 收尾。用独立标志位区分「本轮已落库」与「无消息」。

刷新落在工具执行/工具完成（resume 设计 #5/#6）时：`getInflight` 不吐 partial → 仅历史那条 assistant 渲染（reasoning「思考过程」+ 工具 running/done）→ 截图 bug 消除。

下一轮 reasoning/chunk 到达 → 轮切换重置 `partialPersisted=false` → 新轮 live 流式正常。

---

## C. 回放幂等（可选硬化）

问题：非持久化轮（resume #2/#3/#7），HTTP inflight push 已 seed 全量 reasoning/content，handleSubscribe 又 `run.reasoning/run.chunk` 回放全量、前端 handler **append** → 竞态下（回放晚于 history 合并）文本翻倍；断线重连重订阅（无 history 重拉）也会 append 翻倍。此为 id 割裂之外的既有隐患，A+B 不触发截图 bug，但建议硬化。

方案：subscribe 回放改 **SET 语义**。新增 `run.snapshot` 事件（`{ messageId, reasoning, content, reasoningStartedAt }`，types-agent 定义），handleSubscribe 仅在 `getInflight().messageId` 非空时 emit 一次；前端 handler 按 messageId **SET**（覆盖，不累加）reasoning/content，缺失则建气泡。HTTP push 与 snapshot 互为幂等（SET 到同值）。可同时移除 `run.reasoning/run.chunk` 的回放复用。

> C 落地后 reasoning 计时还可顺带精确化：snapshot 携带 `reasoningDurationMs`，让「content 流式中刷新」时 reasoning 显示「已思考」而非「思考中」（当前 streaming 强制信号下的小瑕疵）。本次可不做，记为后续。

---

## 测试策略

TDD，先写失败用例。沿用各包既有测试栈（server-agent: Jest；libs/agent: vitest）。

**A（id 收口）**
- `graph.service`（vitest）：mock supervisor 出一条带 reasoning + tool_calls 的 AIMessage（模型 UUID 固定），断言 `runGraphStream` yield 的 reasoning/chunk/tool_calls/assistant_done 的 `messageId` 均为同一雪花（非模型 UUID）；断言 supervisor 节点返回的 AIMessage `id` == 该雪花。
- `session-message.service`（Jest）：`recordAssistant({ id: <雪花> })` 后 `listPage` 返回行 `id === <雪花>`。
- 回归：history 端 `idByLanggraph` 恒等映射下 usage 投影仍命中。

**B（partial 抑制）**
- `runner.service`（Jest）：fake graph 出「reasoning → tool_calls → assistant_done（带 reasoning）」后**停住**（模拟工具执行中），断言 `getInflight()` 返回 `messageId === null` 且 `status === "streaming"`；下一轮 chunk 到达后 `getInflight().messageId` 重新为新雪花。

**C（回放幂等，若做）**
- `session.gateway`（Jest）：persisted 轮 subscribe 不 emit snapshot；非 persisted 轮 emit 一次 snapshot 全量。
- web-agent（如有 hook 测试）：push + snapshot 同 messageId → reasoning/content 不翻倍。

**集成冒烟**
- 跑触发 ReAct 多轮 + 长工具的 prompt，在工具执行中刷新：单条 assistant（思考过程折叠 + 工具 running），无「思考中」计时、无重复气泡；工具结束后续接正常。
- 围栏：`pnpm check` 全过、`pnpm typecheck` 干净。

## 风险与边界

- **resolveMessageId 一致性**：node 与 stream 必须解析同一雪花（依赖 `accumulated.id == msg.id`）。实现首步用单测钉死。
- **前端雪花生成器**：需可在浏览器运行（不依赖 NestJS infra）；本地轨单节点免 worker 冲突。
- **2026-05-28「前端 2」机制保留**：`streaming → 思考中` 仅对**非持久化**的真·reasoning 流式轮生效（B 已让持久化轮不推 partial），语义不冲突。
- **langgraph_id 冗余**：本次保留恒等列，避免连带改 llm_calls 关联与迁移；清理另立任务。
- **map 内存**：按 run 清理见过的 UUID，避免长进程累积。

## 不做

- 不改 schema（不加列、不删 langgraph_id）。
- 不持久化 reasoning 中间 token（沿用 inflight 内存 + 推送）。
- 不动 compaction / error / interrupted 刷新路径。
- C 块未定则不引入新事件类型。
