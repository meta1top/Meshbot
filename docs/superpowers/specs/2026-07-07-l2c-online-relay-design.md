# L2c · 跨设备在线 relay 查看会话 设计 spec

**日期**:2026-07-07
**范围**:子项目 C(= L2 最后一块 L2c)。在 L2a 保留的底层 relay/`device:${id}` 房间/设备 presence 之上,新建**只读**「设备查询」请求-响应协议:A 设备的 web-agent 经本地 server-agent → 云端 relay → 在线的目标设备 B 的 server-agent → 查 B 本地会话 → 原路返回。目标离线不可查、不落云、不发消息(发消息/触发 run 属 L3)。

**origin**:细化并取代 `docs/superpowers/specs/2026-07-06-l2-cross-device-agent-sessions-design.md` 的 **Part D**(当时是高层轮廓;本 spec 用 L2a 移除后 + A(machineId)落地后的真实代码校验后定稿)。

---

## 1. 目标

L2b 已让助手侧栏两级列出该账号所有设备,展开本机 → 本地会话。C 把「其他设备(B/C)展开」的占位「远程会话查看即将支持」换成实的:**设备在线时**拉取该远程设备的会话列表,点某会话**只读**查看其历史消息。

---

## 2. 架构与数据流

```
[A 设备]                          [云端 server-main]                    [B 设备]
web-agent                          ImGateway (ws/im)                     server-agent
  │ HTTP GET /api/remote-devices/:id/sessions                              │
  ▼ (本地 server-agent)                                                    │
RemoteDeviceQueryService.query(targetDeviceId=B, kind, params)             │
  · 生成 correlationId,pending map + 超时(镜像 ConfirmationService)      │
  · relay socket.emit(deviceQueryRequest{correlationId,targetDeviceId,kind,params})
                          ──────────►  @SubscribeMessage(deviceQueryRequest)
                                       · requester = client.data.user(userId+deviceId)
                                       · 校验 target 设备 userId == requester userId(同账号)
                                       · devicePresence.isOnline(orgId, targetDeviceId)?
                                         离线 → 直接回 deviceQueryResponse{ok:false,reason:"offline"} 给 requester
                                       · 在线 → server.to(device:${targetDeviceId}).emit(
                                           deviceQueryRequest{correlationId,requesterDeviceId:A,kind,params})
                                                              ──────────►  relay socket.on(deviceQueryRequest)
                                                                            · account.run(该连接 cloudUserId):
                                                                              kind=sessions → SessionService.listAllSorted()
                                                                              kind=history  → SessionMessageService.listPage(sessionId, {before?,limit})
                                                                            · socket.emit(deviceQueryResponse{
                                                                                correlationId,requesterDeviceId:A,ok:true,data})
                                       @SubscribeMessage(deviceQueryResponse)  ◄──────────
                                       · server.to(device:${requesterDeviceId}).emit(deviceQueryResponse{...})
  relay socket.on(deviceQueryResponse) ◄──────────
  · pending.get(correlationId).resolve(data)  (超时/离线 → reject → HTTP 502/409)
  ▼
HTTP 响应 → web-agent 渲染(sessions 列表 / 只读 MessageList)
```

**关键点**:machineId(A 特性)不参与——身份用现有 device token WS 鉴权得到的 `userId`。整链跨 pod 由 Redis adapter 自动覆盖([redis-io.adapter.ts](../../../apps/server-main/src/ws/redis-io.adapter.ts) + [main.ts:63-65](../../../apps/server-main/src/main.ts#L63-L65)),无需额外接线。

---

## 3. 事件契约(libs/types)

在 [im.events.ts:9-21](../../../libs/types/src/im/im.events.ts#L9-L21) 的 `IM_WS_EVENTS` 加两个事件名;结构用 **Zod**(request 需服务端校验),放 [im.schema.ts](../../../libs/types/src/im/im.schema.ts):

```ts
// IM_WS_EVENTS 内新增
deviceQueryRequest: "device.query.request",
deviceQueryResponse: "device.query.response",
```
```ts
// im.schema.ts 新增
export const DeviceQueryKindSchema = z.enum(["sessions", "history"]);
export const DeviceQueryRequestSchema = z.object({
  correlationId: z.string().min(1),
  targetDeviceId: z.string().min(1),
  kind: DeviceQueryKindSchema,
  params: z.object({
    sessionId: z.string().optional(),   // history 用
    before: z.string().optional(),      // history 游标
    limit: z.number().int().min(1).max(100).optional(),
  }).default({}),
});
// 网关下发给 B 时附 requesterDeviceId(不含在上行 schema,由网关注入)
export interface DeviceQueryForwarded extends DeviceQueryRequestInput { requesterDeviceId: string; }
export interface DeviceQueryResponse {
  correlationId: string;
  requesterDeviceId: string;
  ok: boolean;
  reason?: "offline" | "cross_account" | "error" | "timeout";
  data?: unknown;   // kind=sessions → SessionSummary[];kind=history → HistoryResponse(同构本地,便于复用 historyMessageToTimeline)
}
```
`SessionSummary`([libs/types-agent/src/session.ts:8-24](../../../libs/types-agent/src/session.ts#L8-L24))与 `HistoryResponse`([session.ts:222-229](../../../libs/types-agent/src/session.ts#L222-L229))是 agent 域类型;`data` 保持 `unknown`,由 A 侧按 kind 断言(避免 libs/types 反向依赖 types-agent)。

---

## 4. 各端组件

### 4.1 server-main 网关(路由 + 门控)
[im.gateway.ts](../../../apps/server-main/src/ws/im.gateway.ts) 新增两个 handler(照 `handleSend`/`handleRead` 模式,挂 `@UseGuards(WsAuthGuard)`):
- `@SubscribeMessage(deviceQueryRequest)` `handleDeviceQueryRequest(body: DeviceQueryRequestInput, client)`:
  - requester = `client.data.user`(`{userId, deviceId}`);非设备连接(无 deviceId)→ 拒。
  - 查 `targetDeviceId` 归属:`devices.findById(body.targetDeviceId)`,其 `userId !== requester.userId` → 回 `deviceQueryResponse{ok:false, reason:"cross_account"}` 定向给 `device:${requester.deviceId}`。
  - `devicePresence.isOnline(orgId, targetDeviceId)`([device-presence.service.ts:102](../../../libs/main/src/services/device-presence.service.ts#L102))为 false → 回 `{ok:false, reason:"offline"}`。
  - 在线 → `server.to(\`device:${targetDeviceId}\`).emit(deviceQueryRequest, { ...body, requesterDeviceId: requester.deviceId })`。
- `@SubscribeMessage(deviceQueryResponse)` `handleDeviceQueryResponse(body: DeviceQueryResponse, client)`:
  - 直接 `server.to(\`device:${body.requesterDeviceId}\`).emit(deviceQueryResponse, body)`(B 已在 body 里带 requesterDeviceId;网关只做路由,不信任 B 伪造他人 → 可选加「该响应的 correlationId 确由该 requester 发起」的校验,MVP 先信任同账号 relay)。

> `DeviceService.findById` 已存在([device.service.ts:93-95](../../../libs/main/src/services/device.service.ts#L93-L95))。orgId 由现有 `resolveOrgId`(设备连接用握手 payload.orgId)得到。

### 4.2 server-agent A 侧(出站查询)
- 新增 `RemoteDeviceQueryService`([apps/server-agent/src/cloud/](../../../apps/server-agent/src/cloud/)):镜像 [confirmation.service.ts:16-66](../../../apps/server-agent/src/services/confirmation.service.ts#L16-L66) —— `pending = Map<correlationId, {resolve, reject, timer}>`;`query(cloudUserId, targetDeviceId, kind, params, timeoutMs=8000): Promise<DeviceQueryResponse["data"]>`:生成 correlationId、`pending.set`、`setTimeout` 超时 reject(`AgentErrorCode` 新增 `REMOTE_QUERY_TIMEOUT`)、经 `ImRelayClientService` emit `deviceQueryRequest`。correlationId 生成用 `randomBytes`。
- `ImRelayClientService`([im-relay-client.service.ts](../../../apps/server-agent/src/cloud/im-relay-client.service.ts)):
  - 新增出站 `emitDeviceQuery(cloudUserId, payload)`(未连接抛 `IM_NOT_CONNECTED`,照 `send()` L244)。
  - 下行新增 `socket.on(deviceQueryResponse, p => …)`:`account.run` 内交给 `RemoteDeviceQueryService.resolve(correlationId, p)`(ok:false → reject 对应 reason)。
  - 下行新增 `socket.on(deviceQueryRequest, p => …)`(B 侧入站,见 4.3)。
- 新增 `RemoteDeviceController`([apps/server-agent/src/controllers/](../../../apps/server-agent/src/controllers/),`@Controller("api")`):
  - `@Get("remote-devices/:id/sessions")` → `RemoteDeviceQueryService.query(account, id, "sessions", {})` → `SessionSummary[]`。
  - `@Get("remote-devices/:id/sessions/:sessionId/history")`(query `before?`/`limit?`)→ `query(account, id, "history", {sessionId, before, limit})`。
  - 账号从现有 `AccountContextService` 得(与其他 controller 一致)。

### 4.3 server-agent B 侧(入站查询,只读查本地)
`ImRelayClientService` 收到 `deviceQueryRequest` 时(仅当 `forwarded.requesterDeviceId` 存在,即网关转发来的),在 `account.run(该连接 cloudUserId, async () => …)` 内:
- `kind==="sessions"` → `SessionService.listAllSorted()`([session.service.ts:396-406](../../../apps/server-agent/src/services/session.service.ts#L396-L406))
- `kind==="history"` → `SessionMessageService.listPage(params.sessionId, {before: params.before, limit: params.limit ?? 50})`([session-message.service.ts:226-273](../../../apps/server-agent/src/services/session-message.service.ts#L226-L273)),包装成 `HistoryResponse` 同构(messages 映射 + hasMore)。
- 查完 `socket.emit(deviceQueryResponse, {correlationId, requesterDeviceId, ok:true, data})`;查询抛错 → `{ok:false, reason:"error"}`。
- **注入**:relay service 目前不注入数据 service(纯传输层)。为不破坏其职责,入站查询经 `EventEmitter2` 发一个本地事件,由新增的一个薄 handler(注入 `SessionService`/`SessionMessageService`,在 `account.run` 上下文里)处理并回 emit——或直接给 relay service 增注入这两个 service。**决策**:给一个新增的 `RemoteQueryInboundService`(注入两个 session service)订阅本地事件处理,relay service 只负责收 socket 事件 → `account.run` + `emitter.emit(本地事件)` + 提供 `emitDeviceQueryResponse` 出口。保持 relay 传输层纯净(与现有下行桥一致)。

### 4.4 web-agent(只读 UI)
- 新增 `rest/remote-devices.ts`(照 [rest/devices.ts](../../../apps/web-agent/src/rest/devices.ts)):`fetchRemoteSessions(deviceId): Promise<SessionSummary[]>`、`fetchRemoteHistory(deviceId, sessionId, {before?,limit?}): Promise<HistoryResponse>`。走 `apiClient`(自动 token + envelope 解包)。
- 新增 atom `atoms/remote-sessions.ts`:`Map<deviceId, {status, sessions, error}>`(**不塞进本地 `sessionsAtom`**,避免污染本机会话与 `SessionHeader` 的 find);展开某远程设备时按需加载。
- 改 [device-node.tsx:68-72](../../../apps/web-agent/src/components/shell/device-node.tsx#L68-L72):其他设备展开时,在线 → 触发拉取该设备远程会话列表,渲染只读会话项(点击 → 打开只读历史视图);离线 → 保持置灰(现有 `canExpand` 逻辑)。展开瞬间**重新 `fetchDeviceOnline`** 一次(解决 §6 在线态陈旧,见下)。
- 只读历史视图:复用 `MessageList`([message-list.tsx:100](../../../apps/web-agent/src/components/session/message-list.tsx#L100))+ `historyMessageToTimeline`([use-session-stream.ts:47-70](../../../apps/web-agent/src/hooks/use-session-stream.ts#L47-L70) 纯函数);**不用** `useSessionStream`(耦合本地 session socket + send/interrupt)。给 `MessageList` 加 `readOnly` prop(或用现有 `nested`)关掉反馈/重试/重生成动作。远程只读用新路由/query(如 `/assistant?remoteDevice=<id>&id=<sid>`),该 query 存在时从 `rest/remote-devices` 拉 history 而非订阅本地流。输入框禁用 + 提示「远程会话,只读」。

---

## 5. 已定设计决策

- **① kind 二值**:`sessions`(列会话)+ `history`(某会话消息)。够覆盖只读浏览,YAGNI 不做搜索/分页外的花样。
- **② correlation + 超时(8s),镜像 ConfirmationService**,不用 socket.io 原生 ack(与既有全单向 emit 风格一致)。超时/离线/跨账号 → A 侧 reject → HTTP 409(offline/cross_account)/504(timeout)。
- **③ 在线判定的权威在服务端**:网关 `isOnline` 门控是正确性来源(离线直接 ok:false)。客户端在**展开远程设备节点时重新 `fetchDeviceOnline` 一次**取新鲜态。**不**在本轮把 WS device-presence 事件接进 `deviceOnlineAtom`(见 §6,列为非目标/后续)。
- **④ 只读**:输入框禁用、复用 MessageList 只读态;不发消息、不触发远程 run(L3)。
- **⑤ B 侧查询在 `account.run(cloudUserId)` 内**,ScopedRepository 自动按 cloud_user_id 隔离(server-main 的 userId == server-agent 的 cloudUserId,同一身份),天然只返回该账号在 B 上的会话。

---

## 6. 边界与非目标

- **在线态不实时刷新(已知,非目标)**:`deviceOnlineAtom`(keyed deviceId,一次性探测)与 WS `presenceAtom`(keyed userId)互不相通([atoms/devices.ts:32-43](../../../apps/web-agent/src/atoms/devices.ts#L32-L43) vs [atoms/im.ts:136](../../../apps/web-agent/src/atoms/im.ts#L136))。本轮靠「展开时重探 + 服务端 isOnline 门控」保证正确性;设备在线点随 WS 实时更新留作后续 polish。
- **不做云端会话同步 / 离线查看历史**(只在线 relay)。
- **不做远程发消息 / 触发 run**(L3)。
- **双设备验证难**:单机难模拟 A/B 两在线设备;以单测为主 + 手工双实例(dev + `pnpm run:local` 打包版,正是 A 落地能力)人工验证。

---

## 7. 安全

- 身份用现有 device token WS 鉴权(`client.data.user.{userId,deviceId}`),不新增信任面。
- 跨账号防护:网关校验 `targetDevice.userId === requester.userId`,否则 `cross_account` 拒。
- B 侧只读查询在 `account.run` scope 内,不可越账号读他人会话。
- 响应路由:B 回的 `requesterDeviceId` 由网关**转发时注入**(A 的 deviceId),B 原样回带;MVP 信任同账号 relay(可选加 correlationId 归属校验作为后续加固)。

---

## 8. 测试计划

- **server-main 网关单测**:`handleDeviceQueryRequest` —— 同账号在线 → 定向下发到 target room(附 requesterDeviceId);跨账号 → ok:false cross_account;离线 → ok:false offline。`handleDeviceQueryResponse` → 定向回 requester room。
- **server-agent A 侧单测**:`RemoteDeviceQueryService` correlation resolve、超时 reject、ok:false → reject 对应 reason(镜像 confirmation.service.spec 若有)。
- **server-agent B 侧单测**:入站 handler `kind=sessions/history` 在 `account.run` 内调对应 service、包装响应;抛错 → ok:false error。
- **e2e**:若 e2e 设施允许模拟两个设备 relay 连接(两个 device token 连同一测试网关),覆盖「A 查在线 B 的 sessions」链路;否则以网关 + service 单测为主(风险:双设备 e2e 难,见 §6)。
- **UI**:web-agent 无组件测试基建 → 目视:展开在线 B → 列远程会话;点击 → 只读历史(输入禁用);离线 B → 置灰。

---

## 9. 不做(YAGNI)

- 远程会话的实时流/订阅(只读快照,不订阅 B 的 session socket)。
- 远程改名/删除/发送(只读)。
- 会话搜索、跨设备聚合视图。
- WS device-presence → deviceOnlineAtom 实时联动(§6,后续 polish)。
