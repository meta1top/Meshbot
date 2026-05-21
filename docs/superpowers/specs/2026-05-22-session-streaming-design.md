# 会话创建 + Agent 流式 run 设计

> 状态：设计已确认，待 plan
> 范围：本地轨（server-agent + web-agent + libs/agent + libs/types-agent）
> 日期：2026-05-22

## 1. 目标

打通「首页输入文字 → 创建会话 → 异步发起 Agent run → token 级流式输出 → 前端订阅实时显示」的完整链路。

用户故事：

1. 用户在首页 `ChatInput` 输入文字、点发送
2. 前端调 `POST /api/sessions` 创建会话，拿到 `sessionId`
3. 后端写入会话表 + 待处理用户消息表，立即返回；**异步**发起 Agent run 流式任务
4. 前端基于 `sessionId` 跳转到会话页，连 socket.io 订阅该会话的流式输出
5. 会话页逐 token 显示 assistant 回复
6. 用户在会话页可继续发送消息：若当前 run 在跑，新消息进入排队状态；run 结束后后端取出该会话**全部**未处理消息一起处理
7. 用户可中断当前 run

## 2. 架构概览

整个特性拆为 5 个职责单元，全部落在本地轨：

| 单元 | 位置 | 职责 |
|---|---|---|
| 数据模型 | `apps/server-agent/src/entities/` | `Session` / `PendingMessage` 两个 Entity |
| REST 接口 | `apps/server-agent/src/controllers/` + `services/` | `SessionController`（瘦）+ `SessionService`（Entity 归属 + 业务） |
| Run 执行器 | `apps/server-agent/src/services/` | `RunnerService`：进程内单例，内存 inflight + 消费循环，驱动流式 run |
| 实时通道 | `apps/server-agent/src/ws/` | `SessionGateway`：socket.io，复用 `libs/common` WS 框架 |
| 前端 | `apps/web-agent/src/` | 首页发送逻辑 + 会话页（静态导出 + query 参数） |

**关键架构决策：**

- **Run 执行载体**：server-agent 进程内 `RunnerService` + 内存队列。不引入 BullMQ —— 本地轨明确「单进程、不跑分布式基础设施」。run 不落独立任务表，仅靠 `PendingMessage.status` + 内存 inflight 驱动。
- **Run 逻辑不下沉 `libs/agent`**：`libs/agent` 是纯编排域，不应知道 socket.io / Entity / 队列状态。`RunnerService` 留在 server-agent。
- **Runner ↔ Gateway 解耦**：用 Nest `EventEmitter2`。`RunnerService` 产出 chunk 时 `emit` 事件，`SessionGateway` `@OnEvent` 监听后转发到 socket room。Runner 完全不依赖 socket.io，可独立单测。
- **标识体系**：无独立 `runId`。流式 assistant 消息用 **LangGraph `AIMessage.id`** 作为分组键，与 checkpointer 落库消息的 `id` 天然一致，前端补齐/去重无需映射。
- **assistant 回复持久化**：不进业务表，由 LangGraph SQLite checkpointer 按 `thread_id` 持有。`PendingMessage` 表只管「未处理用户消息排队」。

## 3. 数据模型

两张 SQLite 表，`synchronize: false` + 迁移文件，主键 UUID（本地轨约定）。逻辑外键，无 DB 约束。

### `Session`

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | uuid, PK | 同时作为 LangGraph `thread_id` 与 socket.io room id |
| `title` | varchar | 首条消息截断生成（前 30 字） |
| `status` | varchar | `idle` / `running` —— 当前是否有 run 在跑 |
| `created_at` | datetime | |
| `updated_at` | datetime | |

### `PendingMessage`（待处理用户消息表）

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | uuid, PK | |
| `session_id` | uuid | 逻辑外键，无 DB 约束 |
| `content` | text | 用户输入 |
| `status` | varchar | `pending`（排队中）/ `processing`（已取出正在处理）/ `processed`（已完成） |
| `created_at` | datetime | |
| `processed_at` | datetime, nullable | |

列名 snake_case（`SnakeNamingStrategy`）。两个 Entity 用 `TxTypeOrmModule.forFeature()` 注册，唯一归属 `SessionService`。

## 4. REST 接口

新建 `SessionController`（瘦 Controller，逻辑全在 `SessionService`）。四个接口都走全局 `JwtAuthGuard` + 统一响应 envelope。

### `POST /api/sessions` — 创建会话

- 入参：`{ content: string }`（首条消息）
- 处理：`@Transactional()` 跨表写入 —— 建 `Session`（`status: running`）+ 写 `PendingMessage`（`status: pending`）
- 返回：`{ sessionId: string }`
- 事务提交后，**异步**触发 `RunnerService.kick(sessionId)`（不 await，接口立即返回）

### `POST /api/sessions/:id/messages` — 追加消息

- 入参：`{ content: string }`
- 处理：写一条 `PendingMessage`（`status: pending`，单表写入，无需 `@Transactional`）
- 若 session 当前 `idle` → `kick` 启动 run；若 `running` → 仅入队，run 结束后自动消费
- 返回：`{ messageId: string, queued: boolean }`（`queued` = 入队时 session 是否 `running`）

### `GET /api/sessions/:id/history` — 已处理历史 + inflight

- `messages`：从 LangGraph checkpointer 取已处理消息（`GraphService.getHistory`），含 user + assistant，每条带 `id`
- `inflight`：当前未完成 assistant 消息快照（`RunnerService` 内存 buffer），形如 `{ messageId, content, status }`；无则 `null`
- 返回：`{ messages: Message[], inflight: InflightSnapshot | null }`

### `GET /api/sessions/:id/pending` — 排队中的用户消息

- `PendingMessage` 中 `status IN (pending, processing)` 的列表，按 `created_at` 升序
- 返回：`{ pending: PendingMessage[] }`

> 前端会话页加载时并发调 `history` + `pending`，拼出完整时间线：已处理消息 → 正在生成的 assistant（inflight）→ 排队中的 user 消息（pending）。

## 5. RunnerService — Run 执行模型

`RunnerService` 是 server-agent 进程内单例。

### 内存状态

```ts
inflight: Map<sessionId, {
  messageId?: string,      // = LangGraph AIMessage.id；首 chunk 到达前为 undefined
  content: string,         // 已累加的 assistant token
  status: 'streaming' | 'done' | 'interrupted',
  abort: AbortController,  // 用于中断
}>
```

### `kick(sessionId)` — 启动消费循环（fire-and-forget，不 await）

1. 若该 session 已有 inflight → 直接 return（防重入；run 结束会自动续跑）
2. 取该 session 全部 `pending` 消息 → 一把标记为 `processing`
3. 无 pending → 置 `Session.status = idle`，return
4. 把这批消息**拼成一次 LLM 输入**，建 `AbortController`，写入 `inflight`（`messageId` 暂为 `undefined`，`status: streaming`）
5. 调 `GraphService.streamMessage(threadId, input, signal)` 逐 token：
   - **首 chunk**：从 chunk 读出 `message.id`，补到 `inflight.messageId`
   - **每 chunk**：累加到 `inflight.content`，`emit('run.chunk', { sessionId, messageId, delta })`
   - **完成**：`emit('run.done', { sessionId, messageId, content })`，这批 `PendingMessage` → `processed`（写 `processed_at`）
   - **中断**：`emit('run.interrupted', { sessionId, messageId })`，消息保持 `processing`（语义：已交付但被打断，不重复消费）
   - **出错**：`emit('run.error', { sessionId, messageId?, error })`，消息回滚为 `pending`（可重试）
6. 清 `inflight`，**回到第 1 步**（`while` 循环），直到 `pending` 空 → `Session.status = idle`

### `interrupt(sessionId)`

调 `inflight.abort.abort()`，LLM 流停止。

### 进程重启恢复

inflight 内存丢失。启动时扫描：`PendingMessage` 中 `status = processing` 的全部回滚为 `pending`（简单且安全 —— 本地轨可接受重跑）。已 `processed` 的不受影响。

### `libs/agent` 改动：新增 `GraphService.streamMessage`

现有 `GraphService` 只有同步 `sendMessage`。新增基于 LangGraph `graph.stream(..., { streamMode: 'messages' })` 的异步迭代器版本，透传 `AbortSignal`。supervisor 节点接真实 LLM（用已配置的 `ModelConfig`）并启用 streaming。

`graph.stream` 在 `streamMode: 'messages'` 下流出的每个 chunk 带稳定 `message.id` —— 首 chunk 即可读出。

## 6. SessionGateway — socket.io 实时通道

server-agent 当前未装 socket.io。新增依赖：`@nestjs/platform-socket.io`、`@nestjs/websockets`、`socket.io`、`@nestjs/event-emitter`。

`SessionGateway`（`apps/server-agent/src/ws/session.gateway.ts`）：

- `@WebSocketGateway({ namespace: "ws/session", cors: true })`，继承 `libs/common` 的 `BaseWebSocketGateway`
- `jwtVerify` 复用 server-agent 的 `JwtService`（走 `BaseWebSocketGateway` 握手鉴权 + 未鉴权宽限回收）
- `@UseFilters(WsExceptionFilter)`，订阅消息挂 `@UseGuards(WsAuthGuard)`
- Gateway 不碰 Repository、不碰业务逻辑 —— 只做 socket 收发 + 转发 `RunnerService` 调用

### 客户端 → 服务端

| 事件 | 载荷 | 行为 |
|---|---|---|
| `session.subscribe` | `{ sessionId }` | `client.join(sessionId)`。加入后**立即回推 inflight 快照**（若有）：`{ messageId, content, status }` —— 保证刷新页面能拼完整 |
| `session.interrupt` | `{ sessionId }` | 调 `RunnerService.interrupt(sessionId)` |

### 服务端 → 客户端

`RunnerService` 经 `EventEmitter2` 发，`SessionGateway` `@OnEvent` 监听后 `server.to(sessionId).emit`：

| 事件 | 载荷 |
|---|---|
| `run.chunk` | `{ sessionId, messageId, delta }` |
| `run.done` | `{ sessionId, messageId, content }` |
| `run.interrupted` | `{ sessionId, messageId }` |
| `run.error` | `{ sessionId, messageId?, error }` |

room id 直接用 `sessionId`。server-agent `app.module` 需引入 `EventEmitterModule.forRoot()`。

## 7. 前端

### 首页 `page.tsx`

`ChatInput.onSend` 接真实逻辑（当前是 `console.log`）：

- 调 `POST /api/sessions { content }` → 拿 `sessionId` → `router.push('/session?id=' + sessionId)`
- 发送中 `ChatInput` 置 `isLoading`，失败 toast

### 会话页 `app/session/page.tsx`

**静态导出约束**：web-agent 最终 `next build` 静态导出（`output: "export"`），产物有两个消费方 —— Electron 桌面壳、以及 server-agent 自身经 `StaticModule`（`ServeStaticModule`）托管。静态托管只能映射物理文件，**不能有动态路由段 `[id]`**。

- 路由用静态页 `app/session/page.tsx`，会话 id 经 query 传：`/session?id=<sessionId>`
- 页内用 `useSearchParams()` 读 `id`（`next/navigation`），组件需包在 `<Suspense>` 边界内（静态导出要求）
- `id` 缺失 → 空态或跳回首页
- **实施检查点**：确认 server-agent `StaticModule` 对 `/session` 路径有 SPA fallback（未匹配物理文件时回退到对应 HTML），否则刷新带 query 路径仍可能 404

**加载时序：**

1. 路由拿 `sessionId`
2. **并发**调 `GET /history` + `GET /pending`，渲染初始时间线：已处理 `messages` → 排队中 `pending` 用户气泡
3. `history.inflight` 非空 → 渲染一个正在流式的 assistant 气泡（以 `inflight.messageId` + `content` 为起点；`messageId` 可能尚为 `null`，此时显示 loading 占位）
4. 连 `ws/session` namespace（socket.io，握手带 JWT token）→ `emit('session.subscribe', { sessionId })`
5. 收到订阅回推的 inflight 快照 → 与第 3 步对齐（同 `messageId` 则覆盖，确保最新）

**实时渲染（socket 事件）：**

- `run.chunk`：按 `messageId` 找 assistant 气泡，无则新建，`delta` 累加
- `run.done`：该气泡定稿；对应 `pending` 用户气泡标记为已处理
- `run.interrupted` / `run.error`：气泡显示中断/错误态
- run 结束后若 `pending` 仍有 → 后端自动续跑，前端继续收到新 `messageId` 的 `run.chunk`

**会话页继续发送：**

- `ChatInput.onSend` → `POST /:id/messages` → 该用户消息立即作为 `pending` 气泡插入时间线（UI 显示「排队中」）
- 输入框**不禁用** —— run 进行中仍可继续输入并发送（排队）
- `ChatInput.onInterrupt`（Stop 按钮）→ `emit('session.interrupt', { sessionId })`

**socket 重连**：`socket.io-client` 默认自动重连；重连成功重新 `emit('session.subscribe')`，后端再次回推 inflight 快照补齐。

### 新增前端模块

- `apps/web-agent/src/rest/session.ts` —— 4 个接口的 axios 封装（对齐现有 `rest/model-config.ts` 风格）
- `apps/web-agent/src/lib/socket.ts` —— socket.io-client 单例，带 JWT。新增依赖 `socket.io-client`
- 会话页相关组件（消息气泡、时间线容器）

### 共享类型

`Session` / `PendingMessage` / socket 事件载荷 / REST 入参出参的 Zod schema 放 `libs/types-agent`（前后端共用）。后端用 `createZodDto` 转 NestJS DTO。`libs/types-agent` 不依赖 NestJS / TypeORM。

## 8. 错误处理

| 场景 | 处理 |
|---|---|
| 创建会话事务失败 | `@Transactional()` 回滚，接口返回 envelope `success:false` |
| run 出错 | `emit('run.error')`，`PendingMessage` 回滚 `pending` 可重试，前端气泡显示错误态 |
| run 被中断 | `emit('run.interrupted')`，消息保持 `processing` 不重复消费 |
| 进程重启 | 启动扫描 `processing` → 回滚 `pending` 重跑 |
| socket 未鉴权连接 | `BaseWebSocketGateway` 宽限期回收 |
| socket 断线 | 客户端自动重连 + 重新 subscribe + inflight 快照补齐 |
| 订阅前 run 已开始输出 | 订阅时回推 inflight 快照；会话页加载并发拉 history（含 inflight）兜底 |

## 9. 测试

- `SessionService`：创建会话事务、追加消息、history/pending 查询 —— Jest 单测
- `RunnerService`：消费循环（单条 / 批量 / 自动续跑）、中断、出错回滚、重启恢复 —— Jest 单测，`GraphService` mock，`EventEmitter2` 断言事件
- `GraphService.streamMessage`：异步迭代器 + AbortSignal —— libs/agent 单测（vitest，沿用该 lib 历史）
- `SessionGateway`：subscribe / interrupt / 事件转发 —— Jest 单测
- 静态围栏：`pnpm check`（check:repo 校验 Entity 归属、check:tx 校验事务、check:naming 校验事务方法命名）

## 10. 静态围栏注意点

- `Session` / `PendingMessage` 唯一归属 `SessionService`；`SessionController` / `SessionGateway` 禁止注入 Repository
- `POST /api/sessions` 的跨表写入方法挂 `@Transactional()`，私有事务方法命名走 `*InDb` / `*InTx` / `persist*` 约定
- 单表写入（追加消息、状态更新）不挂 `@Transactional()`
