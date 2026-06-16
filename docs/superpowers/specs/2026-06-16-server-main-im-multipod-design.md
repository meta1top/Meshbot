# server-main IM 多 pod 化设计（Socket.IO Redis adapter + websocket-only）

> 状态：已与产品对齐，待实施
> 日期：2026-06-16

## 0. 背景与范围

server-main 的 IM WebSocket 网关当前用 socket.io **默认内存 adapter**（`main.ts` 未 `useWebSocketAdapter`，未装 `@socket.io/redis-adapter`）。后果：room 广播 / `fetchSockets()` / 远程 socket 操作仅在**单进程内**有效。k8s 起 ≥2 pod 时 IM 会坏：

- 发消息 `server.to('conv:X').emit` 只送达与发送者**同 pod**的成员；
- 建频道/拉人/退出（REST → EventEmitter2 `@OnEvent` → `fetchSockets` + `join`/`emit`）只影响同 pod 的 socket；
- presence 在线**广播**不跨 pod（状态本身已存 Redis，跨 pod 共享）。

REST/HTTP 层无状态 + Postgres，本就可水平扩展；**唯一缺口是 WebSocket/IM 实时层的跨进程 fan-out**。本设计补这个缺口，使 server-main 可多 pod 部署。

### 做
- 引入 **Socket.IO Redis adapter**（`@socket.io/redis-adapter`，经典 pub/sub），经自定义 NestJS `IoAdapter` 接入，使 room 广播 / `fetchSockets()` / 远程 `RemoteSocket.join()/.emit()/.leave()` **跨 pod 透明生效**。
- 服务端强制 **websocket-only** 传输（免 k8s ingress 会话粘性）。
- server-agent relay 客户端补 `transports: ['websocket']`。
- **门控**：配了 Redis → 启 Redis adapter（多 pod）；未配 → 回退默认内存 adapter（单 pod，本地 dev 无需 Redis）。启动日志标明当前模式。

### 不做（YAGNI）
- 不改 ImGateway 业务逻辑、不改 EventEmitter2 事件流（adapter 下自动跨 pod，见 §4）。
- 不引入 streams adapter；不做 ingress 会话粘性（已选 websocket-only）。
- Redis 高可用（集群/哨兵）属运维侧，不在本设计代码范围。
- web-agent 浏览器 socket 已是 websocket-only（`lib/im-socket.ts` / `lib/socket.ts`），无需改。

## 1. 已确认决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 连接粘性 | **websocket-only** | 单条 ws 连接固定在一个 pod，adapter 负责跨 pod fan-out；免 ingress 粘性配置 |
| adapter 门控 | **有 Redis 才启** | dev 无 Redis → 内存 adapter 单 pod；与 presence 内存兜底自洽 |
| adapter 实现 | `@socket.io/redis-adapter`（pub/sub） | 成熟、低延迟、文档全；streams adapter 过重 |

## 2. 架构

```
浏览器/desktop ──ws──┐
server-agent relay ──ws──┤   (websocket-only)
                         ▼
              ┌─ pod A ─┐ ┌─ pod B ─┐ ┌─ pod C ─┐ ┌─ pod D ─┐
              │ ImGateway│ │ ImGateway│ │  ...    │ │  ...    │
              │  socket.io 各自持本地 socket            │
              └────┬─────┘ └────┬────┘ └────┬────┘ └────┬────┘
                   └───── @socket.io/redis-adapter (pub/sub) ─────┘
                                    │
                                 Redis（与 presence/lock/cache 同一实例）
```

room 广播 / `fetchSockets` 经 adapter 通过 Redis pub/sub 在所有 pod 间分发。

## 3. 组件

### 3.1 `RedisIoAdapter`（新）`apps/server-main/src/ws/redis-io.adapter.ts`
继承 `@nestjs/platform-socket.io` 的 `IoAdapter`：

- `async connectToRedis(redisConfig: RedisConfig | undefined): Promise<void>`
  - `redisConfig` 为空 → 置 `clustered=false`，直接返回（单 pod 模式）。
  - 否则按 `config.redis`（`{host,port,db,password}`，与 `buildRedis` 同形）`new Redis(...)` dup 出 **pubClient** 与 **subClient**（两条独立连接；sub 连接专用）。各自挂 `'error'` 监听（仅 log，依赖 ioredis 自动重连，绝不让 Redis 抖动崩进程，与现有 `buildRedis` 一致）。`this.adapterConstructor = createAdapter(pubClient, subClient)`；置 `clustered=true`。
- `createIOServer(port, options?): Server`（重写）
  - `const server = super.createIOServer(port, { ...options, transports: ["websocket"] })`（**始终** websocket-only）。
  - `if (this.clustered) server.adapter(this.adapterConstructor)`。
  - 返回 server。
- `isClustered(): boolean` getter（供启动日志）。
- 关闭：暴露 `async close()` 关闭 pub/sub 连接；在 app shutdown 钩子调用（或 main.ts `app.enableShutdownHooks()` 路径接入）。

> 不在 NestJS DI 容器内（IoAdapter 在 NestFactory 之后、`useWebSocketAdapter` 时手动 new），故直接用 `config.redis` 构造连接，不经 `REDIS_CLIENT` provider。

### 3.2 `main.ts` 接线
在 `app = await NestFactory.create(...)` 之后、`app.listen` 之前：
```ts
const ioAdapter = new RedisIoAdapter(app);
await ioAdapter.connectToRedis(config.redis);
app.useWebSocketAdapter(ioAdapter);
new Logger("IM").log(
  ioAdapter.isClustered()
    ? "IM WebSocket: 多 pod 模式（Redis adapter）"
    : "IM WebSocket: 单 pod 模式（内存 adapter，未配置 Redis）",
);
```
`config` 已由 `loadAppConfig` 在 NestFactory 前加载，`config.redis` 直接可用。

### 3.3 依赖
`apps/server-main/package.json` 新增 `"@socket.io/redis-adapter": "^8"`（与 socket.io v4 / ioredis v5 兼容）。`ioredis` / `socket.io` 已有。

### 3.4 server-agent relay 客户端
`apps/server-agent/src/cloud/im-relay-client.service.ts` 的 `io(url, {...})` 增加 `transports: ["websocket"]`（服务端将强制 ws-only，relay 必须匹配）。

### 3.5 web-agent
浏览器 `lib/im-socket.ts` / `lib/socket.ts` 已是 `transports: ["websocket"]`，**无需改动**。

## 4. 为什么网关/事件逻辑零改动

`@socket.io/redis-adapter` 使下列操作集群级透明：

- `this.server.to(room).emit(...)` → fan-out 到所有 pod 上该 room 的 socket（覆盖 `handleSend` 发消息、presence 广播）。
- `this.server.in(room).fetchSockets()` → 返回**全集群** `RemoteSocket[]`；`RemoteSocket.join()/.leave()/.emit()` 经 adapter 转发到属主 pod（覆盖 `conversationCreated`/`conversationRemoved` 的 `@OnEvent` 处理：REST 命中某 pod、emit EventEmitter2、该 pod handler 用集群级 `fetchSockets` + 远程 `join/emit` 触达全集群成员）。

故 `ImGateway`、`ImController`、EventEmitter2 事件流**均不改**。

## 5. presence 自洽
门控天然一致：
- 有 Redis → Redis adapter（多 pod）+ PresenceService 用 Redis（跨 pod 状态）→ 全链路多 pod 安全。
- 无 Redis → 内存 adapter（单 pod）+ PresenceService 内存兜底（单 pod）→ 自洽。

启动日志已标明模式；多 pod 却误删 Redis 时退化为单 pod 内存模式（消息/presence 不跨 pod），日志可见、不静默崩溃。

## 6. 错误处理
- pub/sub 连接 `'error'` 仅 log，ioredis 自动重连（同 `buildRedis` 既有策略）。
- Redis 短暂不可达：adapter 暂停跨 pod fan-out（同 pod 内仍工作），恢复后自动续上；不崩进程。
- `connectToRedis` 在 `config.redis` 配了但连不上时：沿用 ioredis `lazyConnect:false` + fail-fast 语义（启动期连不上让 server fail-fast，与现有 `buildRedis` 一致），避免多 pod 部署悄悄退化。

## 7. 测试
- **单测**（Jest）：`RedisIoAdapter`
  - 无 redisConfig → `isClustered()===false`，`createIOServer` 返回的 server `transports` 仅 `["websocket"]`、未挂 redis adapter。
  - 有 redisConfig（用 ioredis 连本地测试 Redis，或注入伪 pub/sub）→ `isClustered()===true`，`server.adapter` 被设为 redis adapter。
- **跨实例集成测试**（可选，需 Redis；无则 skip，沿用 e2e harness 的 reachable-skip 模式）：起 2 个 Nest 实例共享同一 Redis adapter，客户端各连一个；在实例 A 的房间 `emit`，断言连在实例 B 的客户端收到 → 验证跨 pod fan-out。
- **手验**：部署 ≥2 pod，两浏览器分别落不同 pod，互发消息 / 拉人 / presence 实时可达。

## 8. 配置与部署
- k8s：**无需** ingress 会话粘性（websocket-only）；ingress/proxy 需支持 WebSocket（一般默认支持）。
- Redis：复用现有共享实例（presence/lock/cache 同一套）；多 pod 生产务必配 `config.redis`。
- Redis HA（集群/哨兵）由运维保障；adapter 依赖其 pub/sub 可用性。

## 9. 验收
- 配 Redis 起 ≥2 pod：连在不同 pod 的两用户，A 发消息 B 实时收到;A 建私有频道拉 B，B（不同 pod）实时出现频道;B 退出实时移除;presence 跨 pod 实时。
- 不配 Redis 单 pod：行为与现状一致（启动日志为"单 pod 模式"）。
- 全量 typecheck + 静态围栏通过。
