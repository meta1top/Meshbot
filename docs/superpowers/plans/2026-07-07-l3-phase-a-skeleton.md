# L3 Phase A(骨架)实施 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development(推荐)或 superpowers:executing-plans。步骤用 checkbox(`- [ ]`)。

**Goal:** L3 骨架 —— A 设备发消息 → B 设备 agent 跑(复用本地 run,零改)→ 流式回 A(A 影子渲染,体验同本地)→ 能从 A 中断 B 的 run。**不含**远程工具确认/提问(Phase B)。

**Architecture:** 在 L2c relay(`device.query.*`)之上新增 `agent.run.*` 隧道:A 侧 `RemoteRunService`(streamId 长活订阅,取代 L2c 一次性 pending)→ 云网关定向路由 → B 侧 `RemoteRunInboundService`(`appendMessage`+`runner.kick` 复用本地)+ 订阅该 session 的 `SESSION_WS_EVENTS.*` 打包回帧。A 收帧**重发到本地 SESSION_WS_EVENTS 总线**→ 复用 A 的 `SessionGateway`+`useSessionStream` 渲染。中断经 `agent.run.control{kind:interrupt}`。

**Tech Stack:** NestJS / socket.io / Zod / Jest / jotai。设计真相源:`docs/superpowers/specs/2026-07-07-l3-remote-agent-interaction-design.md`。

## Global Constraints
- 事件名前缀 `agent.run.`;跨域 schema 放 `libs/types`(禁依赖 NestJS/TypeORM/types-agent);`AgentRunFrame.payload: unknown`(A 侧按 event 断言,不反向依赖 types-agent)。
- **B 上 run 本体零改**:复用 `session.controller`/`RunnerService` 现有逻辑([session.controller.ts:61/73](../../../apps/server-agent/src/controllers/session.controller.ts#L61),[runner.service.ts:97/145](../../../apps/server-agent/src/services/runner.service.ts#L97))。
- relay 传输层保持纯净:新逻辑在独立 service,经 EventEmitter2 `@OnEvent` 桥(镜像 L2c `RemoteDeviceQueryService`/`RemoteQueryInboundService`)。
- 同账号校验(网关 `target.userId===requester.userId`)+ 在线门控,与 L2c `handleDeviceQueryRequest` 一致;控制帧额外校验发起方=streamId 登记的 requester。
- B 侧执行在 `account.run(cloudUserId)` scope 内;按 sessionId 精确过滤事件订阅(防多会话串台)。
- 跑单 jest 从仓库根 `pnpm exec jest <path>`(勿 --filter)。typecheck `pnpm --filter @meshbot/<pkg> exec tsc --noEmit`。
- 中文 JSDoc;新错误码走 `defineErrorCode` 过 `check:error-code`;commit 中文 conventional + Co-Authored-By trailer;每 Task 结束 `pnpm check` + 相关测试;只 commit 不 push。

## 依赖顺序
Task 1(协议)→ Task 2(网关)→ Task 3(A 侧)/ Task 4(B 侧触发)/ Task 5(B 侧中断)→ Task 6(UI)。

---

### Task 1: 协议(libs/types)

**Files:** Modify `libs/types/src/im/im.events.ts`、`libs/types/src/im/im.schema.ts`;Test `libs/types/src/im/agent-run.schema.spec.ts`(新)。

**Interfaces — Produces:** `IM_WS_EVENTS.agentRun{Start,Frame,Control,End}` + `AgentRunStartSchema/Input`、`AgentRunStartForwarded`、`AgentRunControlSchema/Input`、`AgentRunControlForwarded`、`AgentRunFrame`、`AgentRunEnd`。供 Task 2/3/4/5/6 共用。

- [ ] **Step 1: 写失败 schema 单测** `agent-run.schema.spec.ts`:
```ts
import { AgentRunStartSchema, AgentRunControlSchema } from "./im.schema";

describe("AgentRunStartSchema", () => {
  it("create 模式可无 sessionId", () => {
    const r = AgentRunStartSchema.parse({ streamId: "s1", targetDeviceId: "dB", mode: "create", content: "hi" });
    expect(r.mode).toBe("create");
  });
  it("append 模式带 sessionId", () => {
    const r = AgentRunStartSchema.parse({ streamId: "s1", targetDeviceId: "dB", mode: "append", sessionId: "sess1", content: "hi" });
    expect(r.sessionId).toBe("sess1");
  });
  it("拒绝非法 mode", () => {
    expect(() => AgentRunStartSchema.parse({ streamId: "s1", targetDeviceId: "dB", mode: "x", content: "hi" })).toThrow();
  });
});
describe("AgentRunControlSchema", () => {
  it("interrupt 控制帧", () => {
    const r = AgentRunControlSchema.parse({ streamId: "s1", targetDeviceId: "dB", sessionId: "sess1", kind: "interrupt" });
    expect(r.kind).toBe("interrupt");
  });
  it("confirm 带 toolCallId+decision", () => {
    const r = AgentRunControlSchema.parse({ streamId: "s1", targetDeviceId: "dB", sessionId: "sess1", kind: "confirm", toolCallId: "t1", decision: "send" });
    expect(r.decision).toBe("send");
  });
});
```

- [ ] **Step 2: 跑失败** `pnpm exec jest libs/types/src/im/agent-run.schema.spec.ts` → FAIL(schema 不存在)。

- [ ] **Step 3: 加事件名**(`im.events.ts` 的 `IM_WS_EVENTS` 内,device.query 之后):
```ts
  agentRunStart: "agent.run.start",
  agentRunFrame: "agent.run.frame",
  agentRunControl: "agent.run.control",
  agentRunEnd: "agent.run.end",
```

- [ ] **Step 4: 加 schema/类型**(`im.schema.ts` 末尾,确认已 `import { z } from "zod"`):
```ts
/** L3:A→B 触发远程 run。create 由 B 新建会话并经首帧回报 sessionId;append 带 B 上会话 id。 */
export const AgentRunStartSchema = z.object({
  streamId: z.string().min(1),
  targetDeviceId: z.string().min(1),
  mode: z.enum(["create", "append"]),
  sessionId: z.string().optional(),
  content: z.string(),
});
export type AgentRunStartInput = z.infer<typeof AgentRunStartSchema>;
export interface AgentRunStartForwarded extends AgentRunStartInput { requesterDeviceId: string; }

/** L3:A→B 运行中控制(confirm/answer/interrupt)。 */
export const AgentRunControlSchema = z.object({
  streamId: z.string().min(1),
  targetDeviceId: z.string().min(1),
  sessionId: z.string().min(1),
  kind: z.enum(["confirm", "answer", "interrupt"]),
  toolCallId: z.string().optional(),
  decision: z.enum(["send", "cancel"]).optional(),
  content: z.string().optional(),
  answers: z.array(z.string()).optional(),
});
export type AgentRunControlInput = z.infer<typeof AgentRunControlSchema>;
export interface AgentRunControlForwarded extends AgentRunControlInput { requesterDeviceId: string; }

/** L3:B→A 运行帧(透传 SESSION_WS_EVENTS.* payload;event 用其常量字符串)。 */
export interface AgentRunFrame {
  streamId: string;
  requesterDeviceId: string;
  seq: number;
  sessionId: string;
  event: string;
  payload: unknown;
}
/** L3:B→A 流终止。 */
export interface AgentRunEnd {
  streamId: string;
  requesterDeviceId: string;
  reason: "done" | "error" | "interrupted" | "offline";
}
```

- [ ] **Step 5: 跑通 + typecheck + barrel**:`pnpm exec jest libs/types/src/im/agent-run.schema.spec.ts` PASS;`pnpm --filter @meshbot/types exec tsc --noEmit` 无错;确认 `libs/types/src/index.ts` 导出上述新符号(参照 L2c device.query 符号的导出;缺则补)。

- [ ] **Step 6: commit** `feat(types): 加 agent.run.* 远程 run 隧道协议(L3 Phase A)`

---

### Task 2: 云网关路由(server-main)

**Files:** Modify `apps/server-main/src/ws/im.gateway.ts`;Test `apps/server-main/src/ws/im.gateway.spec.ts`。

**Interfaces — Consumes:** Task 1 类型。**Produces:** 四个 `@SubscribeMessage` + streamId 路由表。

**镜像基准**:`handleDeviceQueryRequest`([im.gateway.ts:287](../../../apps/server-main/src/ws/im.gateway.ts#L287))/ `handleDeviceQueryResponse`(:334)—— 同账号校验、`devicePresence.isOnline`、定向 emit 到 `device:<id>` 的模式照抄。

- [ ] **Step 1: 写失败测试**(扩展 im.gateway.spec,参照 handleDeviceQueryRequest 用例):
  - `handleAgentRunStart`:同账号+在线 → 定向下发 `device:B`(附 requesterDeviceId);跨账号 → 不下发;离线 → 不下发。并断言 streamId 路由被登记(可暴露一个只读 getter 或用后续 control 路由验证)。
  - `handleAgentRunFrame`/`handleAgentRunEnd`:按 `body.requesterDeviceId` 定向回 `device:A`。
  - `handleAgentRunControl`:已登记 streamId → 定向下发到该 streamId 的 targetDevice;发起方≠登记 requester → 不下发(越权拒)。

- [ ] **Step 2: 跑失败** `pnpm exec jest apps/server-main/src/ws/im.gateway.spec.ts` → FAIL。

- [ ] **Step 3: 实现**(类内加私有路由表 `private agentRunRoutes = new Map<string, { requesterDeviceId: string; targetDeviceId: string }>()` + 四 handler,均 `@UseGuards(WsAuthGuard)`):
```ts
@SubscribeMessage(IM_WS_EVENTS.agentRunStart)
@UseGuards(WsAuthGuard)
async handleAgentRunStart(@MessageBody() body: AgentRunStartInput, @ConnectedSocket() client: Socket): Promise<void> {
  const requester = client.data.user as { userId?: string; deviceId?: string };
  if (!requester?.deviceId) return;
  const target = await this.devices.findById(body.targetDeviceId);
  if (!target || target.userId !== requester.userId) return;  // 静默拒(A 侧超时兜底)
  if (!(await this.devicePresence.isOnline(target.orgId ?? "", target.id))) {
    this.server.to(`device:${requester.deviceId}`).emit(IM_WS_EVENTS.agentRunEnd, {
      streamId: body.streamId, requesterDeviceId: requester.deviceId, reason: "offline",
    } satisfies AgentRunEnd);
    return;
  }
  this.agentRunRoutes.set(body.streamId, { requesterDeviceId: requester.deviceId, targetDeviceId: target.id });
  this.server.to(`device:${target.id}`).emit(IM_WS_EVENTS.agentRunStart, { ...body, requesterDeviceId: requester.deviceId });
}

@SubscribeMessage(IM_WS_EVENTS.agentRunFrame)
@UseGuards(WsAuthGuard)
async handleAgentRunFrame(@MessageBody() body: AgentRunFrame): Promise<void> {
  this.server.to(`device:${body.requesterDeviceId}`).emit(IM_WS_EVENTS.agentRunFrame, body);
}

@SubscribeMessage(IM_WS_EVENTS.agentRunEnd)
@UseGuards(WsAuthGuard)
async handleAgentRunEnd(@MessageBody() body: AgentRunEnd): Promise<void> {
  this.agentRunRoutes.delete(body.streamId);
  this.server.to(`device:${body.requesterDeviceId}`).emit(IM_WS_EVENTS.agentRunEnd, body);
}

@SubscribeMessage(IM_WS_EVENTS.agentRunControl)
@UseGuards(WsAuthGuard)
async handleAgentRunControl(@MessageBody() body: AgentRunControlInput, @ConnectedSocket() client: Socket): Promise<void> {
  const requester = client.data.user as { deviceId?: string };
  const route = this.agentRunRoutes.get(body.streamId);
  if (!route || route.requesterDeviceId !== requester?.deviceId) return;  // 越权/未知拒
  this.server.to(`device:${route.targetDeviceId}`).emit(IM_WS_EVENTS.agentRunControl, {
    ...body, requesterDeviceId: requester.deviceId,
  });
}
```
(import `AgentRunStartInput/AgentRunControlInput/AgentRunFrame/AgentRunEnd` from `@meshbot/types`;`devices`/`devicePresence` 已注入,见 L2c。)

- [ ] **Step 4: 跑通 + typecheck** `pnpm exec jest apps/server-main/src/ws/im.gateway.spec.ts` PASS(原有 + 新增全绿);`pnpm --filter @meshbot/server-main exec tsc --noEmit`。

- [ ] **Step 5: commit** `feat(server-main): 网关 agent.run.* 路由 + streamId 路由表(L3 Phase A)`

---

### Task 3: A 侧发起 + 影子渲染(server-agent)

**Files:** Create `apps/server-agent/src/cloud/remote-run.service.ts` + `.spec.ts`;Modify `apps/server-agent/src/cloud/im-relay-client.service.ts`、`im-relay.events.ts`、`apps/server-agent/src/controllers/remote-device.controller.ts`、`apps/server-agent/src/auth.module.ts`。

**Interfaces — Produces:** `RemoteRunService.startRun(cloudUserId, targetDeviceId, mode, sessionId|null, content): { streamId }`、`sendControl(cloudUserId, control)`;HTTP `POST /api/remote-devices/:id/run`、`POST /api/remote-devices/:id/run/interrupt`。**Consumes:** relay 下行 `agentRunFrame/agentRunEnd`;`EventEmitter2`(重发本地 SESSION_WS_EVENTS)。

**镜像基准**:`RemoteDeviceQueryService`(pending → 改为 streamId 长活订阅)。

- [ ] **Step 1: im-relay.events.ts 加本地事件**:`agentRunRequest: "im.relay.agent_run_request"`(B 侧入站,Task4 消费)、`agentRunControlInbound: "im.relay.agent_run_control"`(B 侧控制入站,Task5 消费)、`agentRunFrame: "im.relay.agent_run_frame"`、`agentRunEnd: "im.relay.agent_run_end"`(A 侧回流,本 Task 消费)。+ 对应 `@public-api` 负载接口 `ImRelayAgentRunRequestEvent {cloudUserId; forwarded: AgentRunStartForwarded}`、`ImRelayAgentRunControlEvent {cloudUserId; forwarded: AgentRunControlForwarded}`。

- [ ] **Step 2: relay client 接线**(im-relay-client.service.ts,镜像 emitDeviceQuery + 下行订阅):
  - 出站:`emitAgentRunStart(cloudUserId, payload: AgentRunStartInput)`(未连抛 IM_NOT_CONNECTED)、`emitAgentRunControl(cloudUserId, payload)`、`emitAgentRunFrame(cloudUserId, payload)`(best-effort)、`emitAgentRunEnd(cloudUserId, payload)`(best-effort)。
  - 下行订阅(`connect()` 内):`agentRunStart` → `account.run` 内 emit 本地 `agentRunRequest{cloudUserId, forwarded}`;`agentRunControl` → 本地 `agentRunControlInbound{cloudUserId, forwarded}`;`agentRunFrame`→本地 `agentRunFrame`;`agentRunEnd`→本地 `agentRunEnd`。

- [ ] **Step 3: 写失败的 RemoteRunService 单测**(`remote-run.service.spec.ts`,fake relay + fake emitter):
  - `startRun` → 生成 streamId、登记订阅、调 `relay.emitAgentRunStart`。
  - 收 `agentRunFrame`(经 `onFrame`)→ 若 streamId 已登记 → 调 `emitter.emit(frame.event, frame.payload)`(重发本地总线)。未知 streamId → 忽略。
  - 收 `agentRunEnd`(`onEnd`)→ 清理订阅。
  - `sendControl` → 调 `relay.emitAgentRunControl`。
  - idle 超时 → 清理 + 可选发本地 error 事件。

- [ ] **Step 4: 实现 RemoteRunService**:
```ts
@Injectable()
export class RemoteRunService {
  private readonly streams = new Map<string, { sessionId: string | null; timer: NodeJS.Timeout }>();
  constructor(private readonly relay: ImRelayClientService, private readonly emitter: EventEmitter2) {}

  startRun(cloudUserId: string, targetDeviceId: string, mode: "create" | "append", sessionId: string | null, content: string): { streamId: string } {
    const streamId = randomBytes(16).toString("hex");
    this.register(streamId, sessionId);
    this.relay.emitAgentRunStart(cloudUserId, { streamId, targetDeviceId, mode, sessionId: sessionId ?? undefined, content });
    return { streamId };
  }
  sendControl(cloudUserId: string, control: AgentRunControlInput): void { this.relay.emitAgentRunControl(cloudUserId, control); }

  @OnEvent(IM_RELAY_EVENTS.agentRunFrame)
  onFrame(frame: AgentRunFrame): void {
    const s = this.streams.get(frame.streamId);
    if (!s) return;
    s.sessionId = frame.sessionId;  // create 模式:首帧起记住 B 的会话 id
    this.bumpIdle(frame.streamId);
    // 影子渲染:重发到本地 SESSION_WS_EVENTS 总线 → A 的 SessionGateway 转发给 A 前端(room=sessionId)
    this.emitter.emit(frame.event, frame.payload);
  }
  @OnEvent(IM_RELAY_EVENTS.agentRunEnd)
  onEnd(end: AgentRunEnd): void { this.clear(end.streamId); }
  // register/bumpIdle/clear:登记 + idle 超时(如 90s 无帧)清理;超时可 emitter.emit(run.error) 让 A 前端收尾。
}
```
> **影子渲染要点**:`frame.payload` 已是 `SESSION_WS_EVENTS.*` 的完整 payload(含 sessionId),直接 `emitter.emit(frame.event, payload)` → A 的 `SessionGateway`([session.gateway.ts](../../../apps/server-agent/src/ws/session.gateway.ts) `@OnEvent(SESSION_WS_EVENTS.*)`)照常转发到 room=`payload.sessionId`。A 前端订阅该 sessionId 即收到。**A 的 SessionGateway 零改**。

- [ ] **Step 5: HTTP 入口**(remote-device.controller.ts,取账号同 L2c):
```ts
@Post("remote-devices/:id/run")
async run(@Param("id") id: string, @Body() dto: RemoteRunDto): Promise<{ streamId: string }> {
  return this.remoteRun.startRun(this.account.getOrThrow(), id, dto.mode, dto.sessionId ?? null, dto.content);
}
@Post("remote-devices/:id/run/interrupt")
async interrupt(@Param("id") id: string, @Body() dto: RemoteInterruptDto): Promise<{ ok: true }> {
  this.remoteRun.sendControl(this.account.getOrThrow(), { streamId: dto.streamId, targetDeviceId: id, sessionId: dto.sessionId, kind: "interrupt" });
  return { ok: true };
}
```
(`RemoteRunDto`/`RemoteInterruptDto` 用 `createI18nZodDto` 或本地 DTO;字段 mode/sessionId?/content、streamId/sessionId。)

- [ ] **Step 6: 注册 provider/controller**(auth.module.ts:providers 加 `RemoteRunService`)。

- [ ] **Step 7: 跑通 + typecheck + check:dead --strict + commit** `feat(server-agent): L3 A 侧远程 run 发起 + 影子渲染(streamId 长活订阅)`

---

### Task 4: B 侧触发 + 帧回传(server-agent)

**Files:** Create `apps/server-agent/src/services/remote-run-inbound.service.ts` + `.spec.ts`;Modify `auth.module.ts`/相应 module 注册。

**Interfaces — Consumes:** 本地 `agentRunRequest`(Task3 relay 发出);`SessionService`(create/appendMessage)、`RunnerService`(kick)、`ImRelayClientService`(emitAgentRunFrame/End)、`AccountContextService`、`EventEmitter2`(订阅 SESSION_WS_EVENTS)。

**镜像基准**:`RemoteQueryInboundService`(account.run + 回发)。

- [ ] **Step 1: 写失败单测**(fake sessions/runner/relay/account/emitter):
  - `agentRunRequest` mode=create → `sessions.create` + `runner.kick`;mode=append → `sessions.appendMessage(sessionId)` + `runner.kick`。
  - 订阅该 sessionId 的 `SESSION_WS_EVENTS.*` → 转成 `agentRunFrame` 回发(按 sessionId 过滤:别的 session 事件不回发)。
  - 收到 `run.done`/`run.error`/`run.interrupted` → 发 `agentRunEnd` + 退订。

- [ ] **Step 2: 实现**:`@OnEvent(IM_RELAY_EVENTS.agentRunRequest)` → `account.run(cloudUserId, async () => { ... })`:
  - create:`const { sessionId } = await this.sessions.create(...)`;append:`await this.sessions.appendMessage(forwarded.sessionId!, { content })`,`sessionId = forwarded.sessionId`。
  - `this.runner.kick(sessionId)`。
  - 建一个**按 sessionId 过滤的 SESSION_WS_EVENTS 监听器**(用 `emitter.on(SESSION_WS_EVENTS.X, handler)` 或一个统一 `@OnEvent` + 过滤;推荐显式 `emitter.on` 便于退订),`payload.sessionId === sessionId` 才 `relay.emitAgentRunFrame(cloudUserId, { streamId, requesterDeviceId, seq++, sessionId, event, payload })`。
  - 终止事件(run.done/error/interrupted)→ `relay.emitAgentRunEnd(...)` + 移除所有该 stream 的监听器。
  > **注意**:SESSION_WS_EVENTS 事件较多(见 session.ts:496-519),需订阅全套并统一转发;`run.tool_call_end` 回发前可照 [session.gateway.ts:199](../../../apps/server-agent/src/ws/session.gateway.ts#L199) 剥大字段(Phase A 可先不剥,注意体积)。

- [ ] **Step 3: 注册 + 跑通 + typecheck + check:dead + commit** `feat(server-agent): L3 B 侧远程 run 触发 + SESSION_WS_EVENTS 帧回传`

---

### Task 5: B 侧中断(server-agent)

**Files:** Create `apps/server-agent/src/services/remote-run-control.service.ts` + `.spec.ts`;Modify module 注册。

**Interfaces — Consumes:** 本地 `agentRunControlInbound`(Task3 relay 发出);`RunnerService.interrupt`([runner.service.ts:145](../../../apps/server-agent/src/services/runner.service.ts#L145))、`AccountContextService`。

- [ ] **Step 1: 写失败单测**:`agentRunControlInbound{kind:interrupt}` → `account.run` 内 `runner.interrupt(sessionId)`;`kind:confirm/answer` → Phase A **暂不处理**(留 Phase B;可 no-op + 注释)。
- [ ] **Step 2: 实现**:`@OnEvent(IM_RELAY_EVENTS.agentRunControlInbound)` → `account.run(cloudUserId, () => { if (forwarded.kind === "interrupt") this.runner.interrupt(forwarded.sessionId); /* confirm/answer: Phase B */ })`。
- [ ] **Step 3: 注册 + 跑通 + typecheck + commit** `feat(server-agent): L3 B 侧远程中断(runner.interrupt)`

---

### Task 6: web-agent UI(发起 + 影子渲染消费 + 中断)

**Files:** Modify `apps/web-agent/src/rest/remote-devices.ts`(加 run/interrupt)、起手台 composer、L2c 远程会话视图 / `useSessionStream`、i18n。

> **说明**:web-agent 无组件测试基建 → 以 typecheck/build/目视 + 双设备手工验证为主。

- [ ] **Step 1: rest** `remote-devices.ts` 加 `startRemoteRun(deviceId, {mode, sessionId?, content}): Promise<{streamId}>`(`POST /api/remote-devices/:id/run`)、`interruptRemoteRun(deviceId, {streamId, sessionId})`(`.../run/interrupt`)。
- [ ] **Step 2: 起手台 composer**:选中远程 agent(B)时,发送 → `startRemoteRun(B, {mode:"create", content})` → 拿 streamId → 打开远程会话视图(等 B 首帧回报 sessionId 后导航 `/assistant?remoteDevice=B&id=<sessionId>`)。
- [ ] **Step 3: 远程会话可交互 + 影子渲染消费**:关键——A 的 `SessionGateway` 已被 Task3 影子渲染喂帧,所以 **A 前端对远程会话走「正常 session socket 订阅」即可收到实时帧**。改造 `useSessionStream`(或包一个 remote 变体)接受 `remoteDeviceId`:
  - 首屏 history:remote 时走 L2c `fetchRemoteHistory`(不走本地 `fetchHistory`)。
  - session socket 订阅:**不变**(影子帧经 A 的 SessionGateway 到达同一 room)。
  - `send`:remote 时走 `startRemoteRun(B, {mode:"append", sessionId, content})`(不走本地 appendMessage)。
  - `interrupt`:remote 时走 `interruptRemoteRun`(不走本地 WS interrupt)。
- [ ] **Step 4: L2c 远程视图**:从只读升级——输入框放开(remote 会话),复用上面 remote 版 useSessionStream。
- [ ] **Step 5: i18n + 校验**:`pnpm --filter @meshbot/web-agent exec tsc --noEmit` + `pnpm build:web-agent` 无错;`pnpm exec tsx scripts/sync-locales.ts -- --check`;目视 + 双设备手工(dev + run:local):起手台选 B 发消息 → 看 B 流式回 → 能中断。
- [ ] **Step 6: commit** `feat(web-agent): L3 远程 run 发起 + 影子流式渲染 + 中断`

---

## 完成后
Phase A 六 Task 完成 + `pnpm test` 全绿(web-agent UI 以 typecheck/build/目视为准)→ superpowers:finishing-a-development-branch 收尾。**双设备端到端**手工验证(dev 设备 A + `run:local` 打包设备 B,同账号):起手台选 B → 发消息 → B 跑、A 流式看 → 中断生效。通过后再出 **Phase B**(远程 confirm/answer)plan。

## Self-Review 检查点
- **Spec 覆盖**:协议(T1)、网关路由(T2)、A 发起+影子(T3)、B 触发+帧(T4)、B 中断(T5)、UI(T6)—— 覆盖 spec Phase A(§4 除 confirm/answer)。
- **类型一致**:`AgentRunStartInput`(T1)→ relay emit(T3)→ 网关注入 requesterDeviceId(T2)→ B 入站 `AgentRunStartForwarded`(T4);`AgentRunFrame`(T1)→ B 回帧(T4)→ 网关路由(T2)→ A onFrame 重发(T3);`AgentRunControlInput` interrupt 贯穿 T3→T2→T5。
- **零改 run 本体**:T4 复用 appendMessage+kick;T5 复用 runner.interrupt。
- **安全**:网关同账号 + 控制帧 requester 校验(T2);B 侧 account.run scope(T4/T5)。
- **Phase B 留口**:T5 confirm/answer 显式留空 + 注释;协议(T1)已含 confirm/answer 字段。
