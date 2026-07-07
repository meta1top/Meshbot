# L3 · 跨设备远程 agent 交互 设计 spec

**日期**:2026-07-07
**范围**:子项目 L3(L2 系列最后、最深一块)。把「本地会话的发消息 + run + 流式 + 工具确认/提问 + 中断」经 relay 隧道化到远程设备:A 设备给 B 设备的 agent 发消息 → B 用自己的环境(账号/模型/文件/checkpointer)跑 → 流式回 A,**与本地会话完全对等**(含远程工具确认/提问、中断)。

**origin**:L2 设计 spec 里预留的「L3 在线远程发消息 + 相同交互」。建立在 L2c(只读 relay 查看远程会话)之上。

---

## 1. 目标与核心洞察

**目标**:两个入口都支持——
- **起手台开新会话**:选 agent = B → 发消息 → B 上新建会话、远程驱动。
- **续聊现有会话**:在 L2c 远程会话视图里发消息 → 接 B 那个会话的上下文继续。

**核心洞察(据 Explore 摸底)**:B 上的 run **完全复用现有本地逻辑**——`session.controller` 的 `appendMessage`/`create` + `RunnerService.kick`([session.controller.ts:73/61](../../../apps/server-agent/src/controllers/session.controller.ts#L73),[runner.service.ts:97](../../../apps/server-agent/src/services/runner.service.ts#L97)),零改动。run 在 B 的账号 scope([runner.service.ts:163](../../../apps/server-agent/src/services/runner.service.ts#L163) `account.run(owner)`)+ B 的 ModelConfig + B 的 SQLite checkpointer 上跑,天然「就在 B 上」;A/B 同 cloudUserId(L2c 网关已校验同账号),不搬凭证。

**所以 L3 = 隧道化三件事**:①触发(A→B)②流式产出(B→A 多帧)③运行中控制(A→B:确认/提问/中断)。run 本体不动。

---

## 2. 架构与数据流

```
[A 设备]                                  [云 server-main]              [B 设备]
web-agent(复用会话 UI)
  │ 起手台选 B 发 / L2c 远程视图发
  ▼ HTTP → A server-agent
RemoteRunService(A 侧:streamId 长活订阅表,取代 L2c 一次性 pending)
  │ relay emit agent.run.start{streamId,targetDeviceId,sessionId?,content,mode}
  │                          ──────►  ImGateway.handleAgentRunStart
  │                                   (同账号校验 + isOnline 门控 + 定向下发 device:B
  │                                    + 记 streamId↔{requesterDevice:A, target:B})
  │                                                        ──────►  RemoteRunInboundService(B 侧)
  │                                                                  account.run(cloudUserId):
  │                                                                   mode=create → SessionService.create
  │                                                                   mode=append → appendMessage(sessionId)
  │                                                                   → RunnerService.kick(复用本地全套)
  │                                                                  订阅该 session 的 SESSION_WS_EVENTS.*
  │  A 前端 ◄── 重新 emit 到 A 本地事件 ◄── relay agent.run.frame{streamId,seq,event,payload}
  │            (影子渲染,见 §4.1)          ◄──────  (B→A 多帧,把 SESSION_WS_EVENTS 透传)
  │
  │ A 前端点确认卡/提问/中断
  ▼ relay emit agent.run.control{streamId,kind:confirm|answer|interrupt,sessionId,toolCallId?,payload}
                             ──────►  ImGateway.handleAgentRunControl(按 streamId 路由回 device:B)
                                                        ──────►  B: RemoteRunControlService
                                                                  confirm/answer → ConfirmationService.resolve(key)
                                                                  interrupt → RunnerService.interrupt(sessionId)
  │  A 前端 ◄── agent.run.end{streamId,reason:done|error|interrupted|offline} ◄── 流终止
```

**要点**:云网关对 `agent.run.*` 与 L2c 的 `device.query.*` 同构(定向 emit + 同账号校验),但需**额外维护 streamId ↔ (A,B) 路由态**(control 帧要回到正确的 B;frame 帧要回到正确的 A)。

---

## 3. 协议(libs/types)

在 [im.events.ts](../../../libs/types/src/im/im.events.ts) `IM_WS_EVENTS` 加事件名 + [im.schema.ts](../../../libs/types/src/im/im.schema.ts) 加 schema。

```ts
// 事件名
agentRunStart:   "agent.run.start",    // A→云→B
agentRunFrame:   "agent.run.frame",    // B→云→A(多帧)
agentRunControl: "agent.run.control",  // A→云→B(运行中)
agentRunEnd:     "agent.run.end",      // B→云→A(流终止)
```
```ts
export const AgentRunStartSchema = z.object({
  streamId: z.string().min(1),
  targetDeviceId: z.string().min(1),
  mode: z.enum(["create", "append"]),
  sessionId: z.string().optional(),   // append 必填;create 由 B 新建后经首帧回报
  content: z.string(),                // 发给 agent 的消息
});
// 网关转发给 B 时附 requesterDeviceId(同 L2c DeviceQueryForwarded 模式)
export interface AgentRunStartForwarded extends AgentRunStartInput { requesterDeviceId: string; }

export const AgentRunControlSchema = z.object({
  streamId: z.string().min(1),
  targetDeviceId: z.string().min(1),
  sessionId: z.string().min(1),
  kind: z.enum(["confirm", "answer", "interrupt"]),
  toolCallId: z.string().optional(),  // confirm/answer 用
  decision: z.enum(["send", "cancel"]).optional(),  // confirm 用
  content: z.string().optional(),     // confirm 改写文案
  answers: z.array(z.string()).optional(),  // answer 用
});
export interface AgentRunControlForwarded extends AgentRunControlInput { requesterDeviceId: string; }

// B→A 帧(透传 SESSION_WS_EVENTS.* payload;event 用其常量字符串)
export interface AgentRunFrame {
  streamId: string;
  requesterDeviceId: string;   // 回给哪台发起设备(A)
  seq: number;                 // 单调序号(乱序/调试)
  sessionId: string;           // B 上的会话 id(create 模式首帧起带回,让 A 拿到新会话 id)
  event: string;               // SESSION_WS_EVENTS.* 名
  payload: unknown;            // 对应事件 payload(见 session.ts:496-519)
}
export interface AgentRunEnd {
  streamId: string;
  requesterDeviceId: string;
  reason: "done" | "error" | "interrupted" | "offline";
}
```
`SESSION_WS_EVENTS` 定义在 [libs/types-agent/src/session.ts:496-519](../../../libs/types-agent/src/session.ts#L496); `AgentRunFrame.payload` 保持 `unknown`(A 侧按 `event` 断言),避免 `libs/types` 反向依赖 `types-agent`。

---

## 4. 各端组件

### 4.1 A 侧(发起 + 影子渲染)
- **新增 `RemoteRunService`**(`apps/server-agent/src/cloud/`):streamId → 订阅态 的**长活表**(取代 `RemoteDeviceQueryService` 的一次性 pending)。`startRun(cloudUserId, targetDeviceId, mode, sessionId?, content): { streamId }`:生成 streamId、登记订阅、经 relay emit `agentRunStart`;收到 `agentRunFrame` → **把 `frame.event`+`frame.payload` 重新 `emitter.emit` 到 A 本地进程事件总线**;收 `agentRunEnd` → 清理订阅。控制出口 `sendControl(streamId, ...)`。idle/离线超时清理(替换 L2c 单次 8s)。
- **影子渲染(关键决策,见 §5①)**:A 侧收帧后重发到本地 `SESSION_WS_EVENTS` 总线 → A 的 `SessionGateway`([session.gateway.ts](../../../apps/server-agent/src/ws/session.gateway.ts))照常转发到 room=sessionId → A 前端**像看本地会话一样**渲染远程流(复用现有 `useSessionStream` 的组装逻辑,无需重写)。A 前端订阅的 room 就是 **B 上的 sessionId**(会话属 B,A 用同 id 引用)。首屏历史仍走 L2c `fetchRemoteHistory`(远程会话不在 A 本地 DB);之后的实时帧走本影子通道。
- **relay 接线**([im-relay-client.service.ts](../../../apps/server-agent/src/cloud/im-relay-client.service.ts)):加 `emitAgentRunStart/Control`(出站)+ `agentRunFrame/agentRunEnd` 下行订阅(桥给 `RemoteRunService`)。
- **HTTP/触发入口**:起手台发送 + L2c 远程视图发送 → A server-agent 端点(如 `POST /api/remote-devices/:id/run`)→ `RemoteRunService.startRun`。

### 4.2 B 侧(触发 + 流式回传 + 控制消费)
- **新增 `RemoteRunInboundService`**:`@OnEvent(agentRunRequest 本地事件)`(relay 收到 `agentRunStart` 后 `account.run` 内转发)→ mode=create 则 `SessionService.create`、append 则 `appendMessage(sessionId)` → `RunnerService.kick`(**复用本地全套,零改**)。同时**订阅该 sessionId 的 `SESSION_WS_EVENTS.*`**,按 sessionId **精确过滤**(B 上可能多会话并行,防串台)打包成 `agentRunFrame` 经 relay 回 A;`run.done`/`run.error`/`run.interrupted` 后发 `agentRunEnd` 并退订。
- **新增 `RemoteRunControlService`**:relay 收到 `agentRunControl` → `account.run` 内:confirm/answer → 构造 key `ConfirmationService.key(cloudUserId, sessionId, toolCallId)` 调 `resolve`([confirmation.service.ts:59](../../../apps/server-agent/src/services/confirmation.service.ts#L59));interrupt → `RunnerService.interrupt(sessionId)`([runner.service.ts:145](../../../apps/server-agent/src/services/runner.service.ts#L145))。**key 的 cloudUserId 在 B 上正确**(run 在 B 跑),sessionId/toolCallId 由 A 端到端透传对齐。

### 4.3 云网关(server-main)
[im.gateway.ts](../../../apps/server-main/src/ws/im.gateway.ts) 加 `@SubscribeMessage` handlers,抄 `handleDeviceQueryRequest/Response` 的定向 emit + 同账号校验([:311](../../../apps/server-main/src/ws/im.gateway.ts#L311))+ isOnline 门控:
- `agentRunStart`:校验同账号 + B 在线 → 记 `streamId → {requesterDeviceId, targetDeviceId}` → 定向下发 `device:B`(附 requesterDeviceId)。
- `agentRunFrame`/`agentRunEnd`:按 frame.requesterDeviceId 定向回 `device:A`。
- `agentRunControl`:按 streamId 映射取 targetDeviceId → 定向下发 `device:B`(校验发起方就是该 streamId 的 requester,防越权控别人的 run)。
- streamId 路由态需清理(run 结束/设备掉线)。

### 4.4 web-agent UI
- 起手台 composer:选中远程 agent(B)时发送 → 调远程 run 入口(而非本地);mode=create。
- L2c 远程会话视图:从**只读**升级为**可交互**——输入框放开;发送 → mode=append(带该会话 id);渲染从「L2c 只读快照」升级为「首屏 L2c 历史 + 实时影子帧」。
- 确认卡 / 提问卡 / 中断:远程会话里,这些动作走 **relay 控制帧**(`agentRunControl`)而非本地 REST/WS。前端需知道「本会话是远程」→ 路由到远程控制。
- 复用 `useSessionStream` 的流组装(经影子渲染,§4.1),尽量少改前端。

---

## 5. 已定设计决策

- **① A 侧影子渲染**:B 的帧重发到 A 本地 `SESSION_WS_EVENTS` 总线,复用 A 的 `SessionGateway` + 前端 `useSessionStream`,不重写远程流渲染。代价:A 前端首屏历史走 L2c 远程查询、实时走影子帧,两者拼接。
- **② run 本体零改**:B 上 `appendMessage + kick` 完全复用;L3 只加「入站触发 + 出站帧 + 控制消费」三个薄 service,不碰 runner/graph。
- **③ HITL 跨进程桥接**:confirm/answer/interrupt 经 control 帧到 B 进程内命中 `ConfirmationService.pending` / `runner.inflight`;key 的 cloudUserId 在 B 正确,sessionId/toolCallId 透传对齐。
- **④ 分两阶段实现**(目标仍完整):
  - **Phase A 骨架**:协议 + A 触发/影子渲染 + B 触发/帧回传 + 网关路由 + **中断**(便宜)+ 起手台/远程视图接入。跑通「A 发→B 流式→A 看→能停」。
  - **Phase B 控制**:远程 **confirm/answer**(跨进程 HITL,最硬),前端确认/提问卡走 relay。

---

## 6. 边界与非目标

- **B 中途离线**:A 流报错 → `agentRunEnd{reason:offline}`;B 的 run 在 B 上继续(孤儿,A 可事后 L2c 只读回看)。网关检测目标掉线 → 通知 A。
- **超时竞态(Phase B)**:B 的 `waitForDecision` 120s vs relay 往返 vs A 操作;A 侧 UI 乐观置停/等待,B 超时 fail-safe 后 A 迟到的 confirm 要 no-op(`resolve` 未知 key 返 false,天然幂等)。
- **并发**:A 可并行驱动 B 上多个会话(各 streamId);B 侧订阅按 sessionId 隔离。
- **不做**:离线远程 run(必须在线);跨账号(网关同账号校验);把远程会话落 A 本地 DB(A 只影子渲染 + L2c 历史)。

---

## 7. 安全

- 所有 `agent.run.*` 经网关同账号校验(`target.userId === requester.userId`),与 L2c 一致。
- 控制帧额外校验:发起方必须是该 streamId 登记的 requester(防跨设备越权 confirm/interrupt 他人的 run)。
- run 在 B 的账号 scope 内([account.run](../../../apps/server-agent/src/services/runner.service.ts#L163)),ScopedRepository 隔离,不越账号。

---

## 8. 测试计划

- **协议 schema 单测**(libs/types):AgentRunStart/Control schema parse/reject。
- **A 侧 `RemoteRunService` 单测**:streamId 订阅登记、收帧重发到本地总线、收 end 清理、离线/idle 超时清理、control 出站。
- **B 侧 `RemoteRunInboundService` 单测**:create/append 分支调对应 service + kick(mock runner)、按 sessionId 过滤订阅回帧、run 终止发 end。
- **B 侧 `RemoteRunControlService` 单测**:confirm/answer 命中 `ConfirmationService.resolve`(mock)、interrupt 命中 `runner.interrupt`(mock)、未知 streamId/越权 no-op。
- **网关单测**(im.gateway.spec):agentRunStart 同账号+在线→定向下发;frame/end→定向回 requester;control→按 streamId 路由;越权/离线拒。
- **e2e**:双设备 relay 模拟(若设施允许)覆盖「A 触发→B run→帧回→A 收」+「confirm 往返」;否则以各端单测 + 手工双实例(dev + run:local)为主。
- **UI**:web-agent 无组件测试基建 → 目视 + typecheck/build。

---

## 9. 分阶段交付

本 spec 覆盖完整 L3。**plan 按 Phase A(骨架:trigger+流式+影子+中断)→ Phase B(远程 confirm/answer)排期**,各阶段独立可测。Phase A 跑通即可手工验证「A 远程驱动 B、看流、能停」;Phase B 补齐 HITL 对等。双设备端到端与前序一样靠 dev + `run:local` 手工联测。
