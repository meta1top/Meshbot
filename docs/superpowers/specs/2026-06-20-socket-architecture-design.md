# Socket 架构梳理与规划 设计文档

> 日期：2026-06-20　范围：apps/web-agent · apps/server-agent · apps/server-main · libs（types-*/common）

## 目标（Goal）

把桌面端到 server-agent 的实时通道收敛为**两条职责清晰的 app 级常驻 WebSocket**：一条做 **agent 推理流式**，一条做 **全局事件总线**（IM + presence + 未读 + 会话/频道变更 + server-agent 本地事件如定时任务）。统一全局事件为「单一 `event` + 信封 `{type,payload,ts}`」，使新事件加一个 type 即可接入；并补齐两个缺口：跨窗口/端的**已读同步**、定时任务等**后台事件的全局推送**。

## 背景与现状（基线）

到 server-agent 现有**两条** socket.io 单例（均 app 级常驻、自动重连、握手带本地 JWT `auth.token`，`sub = cloudUserId`）：

- **`ws/session`**（`apps/server-agent/src/ws/session.gateway.ts`）：agent 推理流。前端 `getSessionSocket()`（`apps/web-agent/src/lib/socket.ts`）+ `useSessionStream`（`apps/web-agent/src/hooks/use-session-stream.ts`）。按 `sessionId` 发 `subscribe`/`unsubscribe` 加入/退出 room，下行 14 个 `run.*` 事件（reasoning/chunk/done/tool_call_*/compaction_*/usage/title_updated…）。`subscribe` 时 gateway 回推 inflight 快照（刷新/重连不丢半截输出）。助手会话页 `AssistantConversationBody` 与随手问 `AssistantDock` **共用这一条**，仅按 sessionId 区分 room。
- **`ws/im`**（`apps/server-agent/src/ws/im.gateway.ts`）：IM。前端 `getImSocket()`（`apps/web-agent/src/lib/im-socket.ts`）+ `useImRealtime`（挂在 `AppShellLayout`，常驻）。server-agent 经 `ImRelayClientService`（每账号一条云连接，`conns: Map<cloudUserId, …>`）relay 到 server-main `ws/im`；下行经 EventEmitter2 → ImGateway `@OnEvent` 按 `acct:<cloudUserId>` room 路由到浏览器。下行事件：`im.message` / `im.presence` / `im.conversation_created` / `im.conversation_removed`；上行 `im.send` / `im.read` / `im.ping`。

现状缺口：
1. **随手问隐藏即断流**：dock 受 `panelOpen && <AssistantDock/>` 控制，关面板会**卸载**组件 → `useSessionStream` 退订，后台跑的 quick 会话隐藏期间不再流。
2. **已读不跨端同步**：`markRead` 只更新 server-main 的 `last_read_at`，不广播；同账号另一窗口/设备未读不清。
3. **后台事件无全局推送**：定时任务（`ScheduleExecutorService`）触发后注入消息 + `kick` runner，靠 `ws/session` 的 `run.human` 驱动——**该 session 页没订阅就收不到**，无独立全局通知。

## 架构（Architecture）

两条 app 级常驻 WS（均到 server-agent）：

| 通道 | namespace | 性质 | 生命周期 | 路由 |
|------|-----------|------|----------|------|
| 流式 | `ws/session`（不变） | agent 推理 token 流，高频 | 常驻连接 + 按 sessionId 订阅 room | session room |
| 全局事件总线 | **`ws/events`**（由 `ws/im` 改名 + 泛化） | IM + 通知，低频 | 常驻，无需 room 订阅 | `acct:<cloudUserId>` room |

设计取舍（已确认）：
- **两条而非一条统一**：流式高频、session 作用域、需订阅/退订；事件低频、全局、广播。两者性质不同，分开更清晰，且是在现有两条上的渐进演进。
- **全局事件用通用总线（统一信封）而非具名事件**：可扩展、统一鉴权/日志/账号路由，加事件只动 type 与分发。
- **未读 = 已读事件广播 + 客端推算新增**：新消息客端本地 +1（快），`im.conversation_read` 跨端清零（服务端不必频繁算数）。
- **server-agent 本地事件初期仅 `schedule.fired`**：YAGNI，总线已为后续（后台 run 完成/出错/下载等）留口。

## §1 流式 WS 生命周期

- **连接**：首次打开 app 建立、常驻、自动重连（现状不变）。
- **助手会话页（`AssistantConversationBody`）**：打开订阅该 sessionId、离开退订（active-view，现状不变）。离开后若该会话在后台跑（如定时任务），由**全局事件总线**通知「有新活动」，回到该会话再看实时流。
- **随手问 dock（`AssistantDock`）**：改为**常驻挂载**——`AppShellLayout` 中由 `panelOpen && <AssistantDock/>` 改为「始终挂载、用 CSS（`hidden`/`display`）控制显隐」，使 `useSessionStream` 订阅在隐藏期间不退订；quick 会话首次有 sessionId 后订阅保持，后台继续流、重开即时、内存状态不丢。
  - 可选增强（本期可做可不做）：✦ 顶栏入口在 dock 的 quick 会话 `running` 时显示「运行中」小徽标（读 dock 的 stream 运行态）。
- **不变量**：`subscribe` 时 gateway 回推 inflight 快照，保证刷新/重连/重开不丢半截输出。

## §2 全局事件总线（`ws/events`）

### 信封（envelope）

下行**单一事件名** `event`，载荷统一为：

```ts
// libs/types/src/events/（新增）
interface GlobalEventEnvelope {
  type: string;      // 事件类型，见下方目录
  payload: unknown;  // 按 type 的具体 schema（各 type 单独 Zod 定义并在前端分发处校验）
  ts: number;        // 事件时间戳（毫秒）
}
```

前端只 `socket.on("event", env => dispatch(env.type, env.payload))`，一个 handler 按 type 分发。

**命名约定**：`type` 字符串 = 事件常量值；网关只把事件**包成信封**，不做名字翻译。IM 域沿用现有 `im.*`（`IM_WS_EVENTS`），新增项保持同域前缀。

### 初期事件目录

来自云端 relay（server-main → server-agent → 浏览器）：

| type | payload | 说明 |
|------|---------|------|
| `im.message` | `ImMessage` | 新消息（客端据此本地 +1 未读，自己发的/当前会话不计） |
| `im.presence` | `{ userId, online }` | 上下线 |
| `im.conversation_created` | `ConversationSummary` | 新会话 / 新频道 |
| `im.conversation_removed` | `{ conversationId }` | 会话移除（退出私有频道等） |
| `im.conversation_read` | `{ conversationId, lastReadAt }` | **新增**：某用户某会话已读，广播给该用户全部连接 → 各端清该会话未读 |

来自 server-agent 本地：

| type | payload | 说明 |
|------|---------|------|
| `schedule.fired` | `{ sessionId, jobId, title }` | **新增**：定时任务触发 |

### 路由

沿用现有 `acct:<cloudUserId>` room 隔离（`im.gateway` 已实现）：浏览器 socket 握手后按 JWT `sub` 入 `acct:<sub>` room；下行只发该账号 room，避免多账号串号/重复。relay 下行经 `AccountContextService.run(cloudUserId, …)`（EventEmitter2 同步触发）使 gateway 取到当前账号。

### 后端改动

**server-main**（`apps/server-main/src/ws/im.gateway.ts` + `libs/main`）：
- `handleRead` 调 `markRead` 成功后，向**该用户的在线连接**广播 `im.conversation_read`（`{ conversationId, lastReadAt }`）。实现：按 `org` room `fetchSockets()` 过滤 `s.data.user.userId === userId`（与 `onConversationCreated` 同模式），或维护 `user:<userId>` room 后 emit。
- 其余 IM 下行事件**不变**：relay 内部（agent↔main）仍用具名 `im.*` 事件；**信封是浏览器侧契约**，由 server-agent 网关翻译，server-main 不引入信封。

**server-agent**（把 `ws/im` 改名/泛化为 `ws/events`）：
- namespace 常量 `IM_WS_NAMESPACE` → 新增/改为 `EVENTS_WS_NAMESPACE = "ws/events"`（保留 IM 相关上行事件名）。Gateway 重命名为 `EventsGateway`（原 `ImGateway`）。
- `@OnEvent` 监听：①relay 来的云事件（`im.message`/`im.presence`/`im.conversation_created`/`im.conversation_removed`/**`im.conversation_read`**）；②本地 EventEmitter2 事件（`schedule.fired`）。统一包成信封 `{type,payload,ts}` → `this.server.to('acct:'+account.get()).emit('event', env)`（无账号上下文降级全量广播，保不丢）。
- 上行：`im.send` / `im.read` / `im.ping` 保留（仍 relay 到 server-main）。
- `ImRelayClientService`：下行监听列表增加 `im.conversation_read`，转发到本地 EventEmitter2（沿用现有 `account.run` 包裹）。
- `ScheduleExecutorService.fire(...)`：触发时 `this.emitter.emit("schedule.fired", { sessionId, jobId, title })`（在 `account.run(job.cloudUserId, …)` 上下文内，保证账号路由正确）。

### 前端改动

- `getImSocket()` → 接 `ws/events`（namespace 改 `ws/events`；函数可改名 `getEventsSocket()`，文件 `lib/events-socket.ts`）。
- `useImRealtime` → **`useGlobalEvents`**（仍挂 `AppShellLayout` 常驻）：`socket.on("event", …)` 一个 handler，按 `type` 分发：
  - `im.message` → `applyIncomingMessageAtom`
  - `im.presence` → `setPresenceAtom`
  - `im.conversation_created` → `upsertConversationAtom`
  - `im.conversation_removed` → `removeConversationAtom`
  - `im.conversation_read` → `markConversationReadAtom`（清该会话未读）
  - `schedule.fired` → toast/红点（+可选在助手列表标「有新活动」），点击跳 `/messages?kind=assistant&id=<sessionId>`
- dock 常驻挂载改造（见 §1）。

## §3 不在本期范围（Out of scope）

总线已留口，后续加 type 即可：
- 后台 run 完成 / 出错 / 需关注通知、下载完成等 server-agent 本地事件。
- 服务端权威未读数推送（本期用「客端推算 + `im.conversation_read` 广播」足够）。
- 跨物理机/多 server-agent 实例的同账号 presence 汇聚（属云端 presence 议题）。
- 把 `ws/session` 也并入总线（明确保持两条）。

## §4 错误处理与边界

- **账号上下文缺失**：`EventsGateway` emit 时若 `account.get()` 为 null（理论不应发生），降级 `this.server.emit('event', env)` 全量广播，保证不丢（与现有 `emitToAccount` 一致）。
- **relay 未连接**：上行 `read`/`send` 现状 best-effort/抛 `IM_NOT_CONNECTED` 不变；`im.conversation_read` 下行依赖云连接，断线期间漏发由重连后下次 `markRead`/拉 sidebar 兜底。
- **未读一致性**：客端 `im.message` +1 与 `im.conversation_read` 清零均为幂等 patch；权威值仍以拉 sidebar（server 计算，已排除自己发的消息）为准。
- **dock 常驻**：隐藏用 CSS 而非卸载；注意不要因常驻导致首屏（未开过面板）就建立 quick 会话——保持「首条消息惰性建 quick 会话」不变，未建会话前不订阅。

## §5 测试

- `EventsGateway`（server-agent）：①按账号 room 路由（现有思路）②信封封装 `{type,payload,ts}` ③`schedule.fired` 本地事件入总线 ④无账号上下文降级广播。
- server-main `ImGateway`：`markRead` 成功后广播 `im.conversation_read` 给该用户连接（按 userId 过滤）。
- 前端 `useGlobalEvents`：按 type 分发到对应 atom（含 `im.conversation_read` → 清零、`schedule.fired` → 通知）。
- 流式生命周期：dock 常驻隐藏不退订；助手页 active-view 离开退订。
- 回归：多账号下一条消息收件方未读 +1（不 +2，沿用 `acct` 路由）。

## §6 迁移与命名

- `ws/im` → `ws/events`：改 namespace 常量、gateway 类名、前端 socket 工厂与 hook 名。上行事件名 `im.send`/`im.read`/`im.ping` 与 IM 业务下行 type（`im.message` 等）保留（仍属 IM 语义）。
- 纯前端 + 本地后端（server-agent）改动 → 改完需重启 `pnpm dev:server-agent`；`im.conversation_read` 涉及 server-main → 需重启 `pnpm dev:server-main`。无 DB schema 变更、无 DDL。
