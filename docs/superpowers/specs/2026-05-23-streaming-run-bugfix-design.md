# 流式 run 冒烟暴露的两个 bug 修复 + 重试 设计

> 状态：设计已确认，待 plan
> 范围：本地轨（server-agent + libs/agent + libs/types-agent + web-agent）
> 日期：2026-05-23

## 1. 问题

会话流式特性手动冒烟暴露两个 bug：

**Bug 1 —— `Cannot find module '@langchain/deepseek'`**
配置的模型 `providerType = deepseek`。`libs/agent` 的 `llm.factory.ts` 用 LangChain `initChatModel` 构造 chat model，`initChatModel` 按 `modelProvider` 字符串**懒加载**对应的 `@langchain/<provider>` 集成包。但 `node_modules/@langchain/` 下一个 provider 集成包都没装（只装了 `@langchain/core` / `langgraph` 等核心包）。run 一发起就 `MODULE_NOT_FOUND` → `run.error` → 消息回滚。

**Bug 2 —— 页面显示两个 "hi"，数据库只有一条**
db 实证：`pending_messages` 只有 1 行（`pending`，run 出错回滚后的状态）；但 LangGraph `writes` 表里该 thread 有一条 `channel: messages` 的写入 —— 用户的 `HumanMessage` 已被写进 checkpointer。所以同一条用户消息：`GET /history`（读 checkpointer）返回 1 条、`GET /pending`（读 pending 表）返回 1 条 → 前端两个气泡。

根因：`streamMessage` 在 run 开始就把 `HumanMessage` 写进 checkpointer；run 出错时消息又被回滚为 `pending`。同一条消息在 checkpointer 和 pending 表两边各存一份，且 id 不同 —— 前端无法识别是同一条。

## 2. 修复总览 + 关键决策

| 单元 | 位置 | 职责 |
|---|---|---|
| 供应商集成包 | `libs/agent/package.json` | 安装 PROVIDERS 列出的全部 `@langchain/*` 集成包 |
| id 对齐 + failed 状态 | `libs/types-agent` + `libs/agent` + server-agent | PendingMessage.id ↔ HumanMessage.id；新增 `failed` 状态；出错不回滚、标 failed |
| 前端去重分区渲染 | `apps/web-agent` 会话页 | history / pending 按 id 去重；pending 区独立在输入框上方 |
| 重试 | server-agent + libs/agent + web-agent | `POST /api/sessions/:id/retry`；resume run 不重写 HumanMessage |

**关键决策：**

- **HumanMessage 进 checkpointer 后不撤销**。出错时 HumanMessage 留在 checkpointer（它确实是会话的一部分）。
- **PendingMessage.id 即 HumanMessage.id**。`RunnerService` 喂消息时给 `HumanMessage` 显式指定 `id = PendingMessage.id`，让两边可对齐去重。
- **新增 `failed` 状态**。run 出错时消息标 `failed`（不回滚 `pending`）。`failed` = HumanMessage 已入会话、但 agent 回复失败、可重试。
- **批次保留消息边界**。现有 `runOnce` 把一批 pending 消息 `join("\n")` 成一个字符串，丢失了「一条 pending ↔ 一条 HumanMessage」的对应。改为每条 pending 消息变成一条独立的、带自己 id 的 `HumanMessage`，一批一起作为本轮输入。
- **重试 = 重新跦请 agent 回复**，不重写 HumanMessage。`failed` 消息的 HumanMessage 已是会话最后一条；重试只触发 graph 从现有 checkpointer 状态重跑。

## 3. Bug 1 —— 安装供应商集成包

`PROVIDERS`（`libs/types-agent/src/ai/providers.ts`）列出 6 种 `type`：`openai` / `anthropic` / `google` / `deepseek` / `ollama` / `openai-compatible`。

把对应的 LangChain 集成包装进 `libs/agent`：

- `openai` → `@langchain/openai`
- `anthropic` → `@langchain/anthropic`
- `google` → `@langchain/google-genai`
- `deepseek` → `@langchain/deepseek`
- `ollama` → `@langchain/ollama`
- `openai-compatible` → 复用 `@langchain/openai`（OpenAI 兼容接口走 ChatOpenAI + baseUrl，无独立包）

`initChatModel` 的 `modelProvider` 字符串需与这些包对应的 provider 名一致。**实施检查点**：`initChatModel` 对每个 provider 期望的 `modelProvider` 值要核对（如 google 对应的 modelProvider 可能是 `google-genai` 而非 `google`）—— 装完后用 deepseek 实测一次确认 `createChatModel` 能成功加载。若某 provider 的 `ModelConfig.providerType` 字符串与 `initChatModel` 期望的 `modelProvider` 不一致，在 `llm.factory.ts` 做一层映射。

## 4. Bug 2 —— id 对齐 + failed 状态（数据层）

### 4.1 PendingMessageStatus 新增 failed

`libs/types-agent/src/session.ts` 的 `PendingMessageStatus` 从 `["pending","processing","processed"]` 扩展为 `["pending","processing","processed","failed"]`。

状态语义：
- `pending` —— 排队中，HumanMessage 尚未进 checkpointer
- `processing` —— 正在处理，HumanMessage 已进 checkpointer
- `processed` —— agent 已成功回复
- `failed` —— HumanMessage 已进 checkpointer，但 agent 回复失败，可重试

> SQLite 列是 TEXT，无需迁移改 schema —— `failed` 只是多一个合法字符串值。`pending_messages.status` 列保持 TEXT。

### 4.2 streamMessage 接受带 id 的 HumanMessage 批次

当前 `GraphService.streamMessage(threadId, message: string, signal)` 接受单个字符串。改为接受一批 `{ id, content }`，内部为每条构造带 `id` 的 `HumanMessage`（LangChain `HumanMessage` 构造支持显式 `id`），一起作为本轮 graph 输入。

新签名（示意）：`streamMessage(threadId, inputs: { id: string; content: string }[], signal)`。系统提示首轮注入逻辑（Task 5 已有）保留。

### 4.3 RunnerService.runOnce 传 id

`runOnce` 当前 `const input = batch.map(m => m.content).join("\n")` 改为把整个 `batch`（每项 `{ id, content }`）传给 `streamMessage` —— 每条 pending 消息对应一条带自己 id 的 `HumanMessage`。这样 checkpointer 里每条 user 消息的 id 与 `pending_messages` 表对得上。

### 4.4 出错标 failed，不回滚

`runOnce` 的错误分支当前 `rollbackToPending(ids)`。改为 `markFailed(ids)` —— `SessionService` 新增 `markFailed(ids)` 把消息标 `failed`。HumanMessage 留在 checkpointer。中断分支（`run.interrupted`）行为不变（消息保持 `processing`，语义「已交付但被打断」—— 与现状一致）。

### 4.5 SessionService 调整

- `claimPending` 不变（仍只取 `pending` 状态的消息发起新 run）。
- 新增 `markFailed(ids: string[])` —— 标 `failed`。
- `listActivePending` / `GET /pending` 的查询范围从 `pending + processing` 扩为 `pending + processing + failed`（见第 5 节）。
- `rollbackProcessingToPending`（启动恢复）保持 —— 重启时遗留 `processing` 回滚 `pending` 重跑（这些消息的 HumanMessage 可能已进 checkpointer，重跑会再写一次 → 见 9 节「已知取舍」）。

## 5. 前端去重 + 分区渲染

会话页（`apps/web-agent/src/app/session/page.tsx`）分两个视觉区域：

1. **主时间线区**（中间，可滚动）—— 来自 `GET /history`（checkpointer）：已进会话的 user 消息 + assistant 回复 + 流式 inflight assistant。
2. **pending 区**（输入框正上方，贴着 `ChatInput`）—— 只显示**还没被 agent 处理**的用户消息。

### 5.1 GET /pending 范围

`GET /api/sessions/:id/pending` 返回 `status IN (pending, processing, failed)` 的消息（当前是 `pending + processing`）。`processed` 不返回。

### 5.2 分区规则（按 id 去重）

对每条 `GET /pending` 返回的消息，看其 id 是否已在 `history.messages` 中：

- **id 不在 history**（纯 `pending`，还没进 run / 没进 checkpointer）→ 显示在 **pending 区**，标「排队中」。
- **id 已在 history**（`processing`：HumanMessage 已进 checkpointer 正跑；`failed`：已进会话但回复失败）→ **不在 pending 区显示**。它已作为主时间线的 user 气泡存在。`failed` 状态叠加到那条主时间线气泡（显示「失败」+「重试」按钮）；`processing` 正常显示（assistant 回复流式中）。
- `processed` → `GET /pending` 不返回 → 不在 pending 区，只在主时间线。

净效果：排队中、还没轮到的 → pending 区（输入框上方）；一旦被处理（processing/processed/failed）→ 从 pending 区消失，进主时间线。

### 5.3 TimelineMessage 状态

`TimelineMessage`（`components/session/message-list.tsx`）的状态维度区分：`queued`（排队中）/ `failed`（失败）/ 正常 / `streaming`。渲染时按「是否在 history」分流到两个区。`failed` 气泡显示「失败」+「重试」按钮。

### 5.4 socket 事件衔接

- `run.error`（来自 `RunnerService`，第 4.4 节）→ 前端按 `messageId` 找对应主时间线 user 气泡，切 `failed` 态。
- `run.done` → 该消息 checkpointer 里有了 assistant 回复，pending 表标 `processed` → 下次 `GET /pending` 不再返回它。

## 6. 重试 —— POST /api/sessions/:id/retry

`failed` 消息的 `HumanMessage` 已在 checkpointer（会话最后一条）。重试 ≠ 重发消息，= 让 agent 基于现有会话状态重新跑。

### 6.1 端点

`SessionController` 新增 `@Post(":id/retry")`（瘦 Controller，走全局 `JwtAuthGuard`）：
- 找该 session 所有 `failed` 的 `PendingMessage`。
- 标回 `processing`（不是 `pending` —— HumanMessage 已在 checkpointer，无需重写）。
- 触发 `RunnerService` 重跑。
- 返回 `{ retried: boolean }`。

### 6.2 GraphService.resumeStream

`GraphService` 新增 `resumeStream(threadId, signal)` —— 不传任何新 `HumanMessage`，`graph.stream(null, ...)`（或 LangGraph 等价的「从现有 checkpoint 继续」调用）让 graph 从 checkpointer 的现有状态（最后一条是那个 user 消息）继续跑，流式产出 assistant 回复。

> 实施检查点：LangGraph 用 `graph.stream(null, config)` 表示「从 checkpoint 恢复、不加新输入」。验证 `@langchain/langgraph@0.2` 的实际 API —— 若 `null` 不行，用其等价机制（如不带 messages 的空 input）。supervisor 节点会基于 checkpointer 里已有的消息历史跑。

### 6.3 RunnerService 重试路径

`RunnerService` 区分两种 run：
- **新消息 run** —— `claimPending` 拿到 `pending` 消息 → 第 4.3 节流程（传带 id 的新 HumanMessage）。
- **重试 run** —— `/retry` 端点把 `failed`→`processing` 后触发 → 调 `resumeStream`（不传新消息）。

实现方式（取最简洁、不破坏现有「新消息」路径）：`RunnerService` 新增 `kickRetry(sessionId)`，或在消费循环里：取该 session `processing` 状态消息（无 `pending`）时走 `resumeStream` 路径。`/retry` 端点把 failed→processing 后调 `kickRetry`。重试成功 → 这批 `processing` → `processed`；重试再失败 → 回 `failed`。

### 6.4 前端重试按钮

`failed` 气泡的「重试」按钮 → `POST /api/sessions/:id/retry` → 该 session failed 消息重跑 → socket 照常推 `run.chunk`/`run.done`。前端发起后该气泡切回 streaming 态。

## 7. 共享类型

`libs/types-agent/src/session.ts`：
- `PendingMessageStatus` 加 `failed`。
- 新增 retry 端点的返回类型 `RetryResponse { retried: boolean }`（或直接 `{ retried }`）。

## 8. 错误处理

| 场景 | 处理 |
|---|---|
| provider 包未装 | 第 3 节装全；装完仍缺某包 → `createChatModel` 抛错 → run.error → 消息 failed |
| run 出错 | `markFailed`，HumanMessage 留 checkpointer，前端 failed 气泡 + 重试按钮 |
| 重试再失败 | 消息回 `failed`，可再次重试 |
| 重启遗留 processing | `rollbackProcessingToPending` 回滚 pending 重跑（见 9 节取舍）|
| run 中断 | `run.interrupted`，消息保持 `processing`（不变）|

## 9. 已知取舍

- **重启恢复的重复风险**：`rollbackProcessingToPending` 把遗留 `processing` 回滚 `pending` 重跑。若该消息的 HumanMessage 已进 checkpointer，重跑（走新消息路径）会再写一条相同 content 的 HumanMessage（新 id）→ checkpointer 里出现重复 user 消息。本地轨单进程、重启少见，本期接受此取舍；彻底解决需重启恢复也走 resume 路径（判断 HumanMessage 是否已在 checkpointer）—— 留待后续。
- **批次内多条 pending**：一批多条 pending 消息各自成独立 HumanMessage，一轮 run 一起喂给 agent，agent 产出一条 assistant 回复。这批多条 user 消息 + 一条 assistant 回复，id 各自对齐 —— 符合「run 结束后取全部未处理消息一起处理」语义。

## 10. 测试

- **Bug 1**：装包后 `createChatModel` 对 deepseek 能成功加载（实测 / 集成测试）。
- **id 对齐**：`RunnerService.runOnce` 传给 `streamMessage` 的 HumanMessage id = PendingMessage id —— 单测断言。
- **failed 状态**：run 出错 → `markFailed` 被调、消息状态 `failed`、不回滚 pending —— `RunnerService` 单测。
- **去重**：前端会话页 history/pending 同 id 去重 —— 构建 + 手动冒烟。
- **重试**：`POST /retry` 把 failed→processing→触发 resume run —— `SessionService` / `RunnerService` 单测 + e2e。
- **回归**：`pnpm typecheck` / `build` / `test` / `pnpm --filter @meshbot/agent test` / `pnpm check`。
- **端到端冒烟**：deepseek 配置下，首页发送 → 流式回复成功（Bug 1 修复）；页面无重复气泡（Bug 2 修复）；失败消息能重试。
