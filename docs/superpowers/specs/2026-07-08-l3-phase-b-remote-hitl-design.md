# L3 Phase B:跨设备远程 HITL 设计 spec

> Phase A(骨架:发起 + 流式 + 中断 + 影子渲染)已合入 main(PR #26)。本 spec 承接 Phase A,完成**远程工具确认 / 远程提问**的跨进程 HITL 闭环。
> 上游设计:`docs/superpowers/specs/2026-07-07-l3-remote-agent-interaction-design.md`(Phase B 已在其中预留:「远程 confirm/answer(跨进程 HITL,最硬),前端确认/提问卡走 relay」)。

## 目标

一句话:A 设备上的远程会话里,B 的 agent 发起工具确认 / 提问时,A 前端能像本地一样点确认/拒绝/回答,决定经 relay 控制帧回到 B 进程内 resolve 那个正挂起的工具,工具继续执行、结果流回 A。覆盖全部 4 张 HITL 卡(im_send 确认、ask_question 提问、drive_share、drive_create_share)。

顺带解决 Phase A 遗留的两个结构性缺口(同源于「A 不可靠地知道当前 run 的 streamId↔sessionId」):
- create 新远程会话后前端轮询 B 会话列表拿 sessionId → 改查 A 本机。
- 刷新 / 直接进入正在跑的远程会话后 `remoteStreamIdRef` 为 null → 中断(及本 spec 新增的 confirm/answer)无法路由。

## 背景:本地 HITL 机制(设计的地基)

4 类工具共用一套进程内确认核心 `ConfirmationService`(`apps/server-agent/src/services/confirmation.service.ts`):

- 存储:`private readonly pending = new Map<string, (d: unknown) => void>()`,纯内存,无持久化(单用户本地轨)。
- Key:`ConfirmationService.key(cloudUserId, sessionId, toolCallId): string` → `${cloudUserId}:${sessionId}:${toolCallId}`(含 cloudUserId 防跨账号解锁)。
- 挂起:`waitForDecision<T>(key, signal, timeoutMs): Promise<T | "timeout" | "aborted">`——注册 deferred 并 race(超时 / abort / resolve),任一先到走互斥 `cleanup()`。
- 解锁:`resolve<T>(key, decision): boolean`——命中 Map 调 fn 返 true;**未命中返 false(天然幂等,超时竞态兜底)**。
- 决定类型:`ConfirmDecision = { action: "send" | "cancel"; content?: string }`(im_send / drive_share / drive_create_share);`AnswerPayload = { answers: AnswerItem[] }`(ask_question),`AnswerItem = { selected: string[]; other?: string }`。

挂起方(创建 pending):`ImSendService.confirmAndSend` / `AskQuestionService.ask` / `DriveToolService`,均用 `AccountContextService.getOrThrow()` 取 cloudUserId 拼 key,超时 120s。

解锁方(本地):唯一入口 `SessionController`——`POST /api/sessions/:sessionId/confirm`(body `{toolCallId, decision, content}`)→ `resolve(key, {action: decision, content})`;`POST /api/sessions/:sessionId/answer`(body `{toolCallId, answers}`)→ `resolve(key, {answers})`。

触发与前端:确认**不骑专门事件**——工具执行体 `await waitForDecision` 挂起使 tool_call 停在 running(无 `run.tool_call_end`),前端按**工具名 + status** 推断渲染交互卡(`tool-call-block.tsx:43-56` 按 `tool.name` 分派 `ImSendConfirmCard`/`AskQuestionCard`/`DriveShareCard`/`DriveCreateShareCard`),点击 POST 到本机 server-agent。

## Phase A 已铺好的管道(复用,不重做)

- 控制协议 `AgentRunControlSchema`(`libs/types/src/im/im.schema.ts`)`kind` 已含 `"confirm" | "answer" | "interrupt"`,`toolCallId`/`decision`/`content`/`answers` 字段已在。
- A 侧 `RemoteRunService.sendControl(cloudUserId, control)` → `relay.emitAgentRunControl`(fire-and-forget,不等响应)。
- 云网关 `handleAgentRunControl`(`apps/server-main/src/ws/im.gateway.ts`)按 `streamId` 查 `agentRunRoutes` → **校验发起方 = 登记 requester** → 定向下发 `device:${targetDeviceId}`。
- B 侧 relay 下行 `socket.on(agentRunControl)` → `account.run(cloudUserId)` 内 emit 本地 `agentRunControlInbound` → `RemoteRunControlService.onAgentRunControl`(**interrupt 已实现,confirm/answer 现为 no-op 注释占位**)。
- A 侧 `RemoteRunService` 已握有 `streams: Map<streamId, {targetDeviceId, sessionId, ...}>` + `activeSessionRuns: Map<sessionKey, streamId>`(Phase A I3 修复引入,`sessionKey = targetDeviceId:sessionId`)。

## 架构:五处改动

### ① 线路协议(libs/types)

升级 `AgentRunControlSchema.answers`:`z.array(z.string())` → `z.array(AnswerItemSchema).optional()`,其中 `AnswerItemSchema = z.object({ selected: z.array(z.string()), other: z.string().optional() })`,与本地 ask_question 的 `AnswerItem` 同构,无损承载多问题分组结构。

- `AnswerItem` 定义在 `libs/types-agent/src/ask-question.ts`(Agent 域);`libs/types` 的 im 协议不应反向依赖 types-agent。因此在 `libs/types/src/im/im.schema.ts` **就地定义** `AgentRunAnswerItemSchema`(同形状),避免跨域依赖。B 侧 resolve 时该形状可直接喂给本地 `AnswerPayload`(结构一致)。
- confirm/interrupt 字段不变。
- 兼容性:Phase A 实际只发过 `kind:"interrupt"`(无 answers),此改动不破坏任何在途数据。

### ② B 侧:真正 resolve + M3 绑定校验

`RemoteRunControlService`(`apps/server-agent/src/services/remote-run-control.service.ts`):

- 注入 `ConfirmationService`。
- `onAgentRunControl` 在 `account.run(cloudUserId)` 内按 kind 分派:
  - `"interrupt"` → `runner.interrupt(sessionId)`(不变)。
  - `"confirm"` → `key = ConfirmationService.key(cloudUserId, sessionId, toolCallId)`;`resolve(key, { action: decision, content })`(线路 `decision:"send"|"cancel"` 映射到本地 `ConfirmDecision.action`)。统一覆盖 im_send / drive_share / drive_create_share。
  - `"answer"` → `resolve(key, { answers })`(结构化 `AnswerItem[]`)。覆盖 ask_question。
- **M3 绑定校验**:B 侧维护 `streamId → sessionId` 注册表,防「control 帧携带的 sessionId 与该 streamId 实际会话不符」→ 跨会话 resolve。
  - 登记/清除位置:`RemoteRunInboundService`(它在 `onAgentRunRequest` 建订阅时已知 streamId 与 sessionId,终止退订时清除)。暴露供 `RemoteRunControlService` 查询的只读方法(通过共享 service 或注入)。
  - 校验:resolve 前 `if (registry.get(control.streamId) !== control.sessionId) return;`(拒,不 resolve)。
  - 双保险:即使绕过校验,`resolve` 对未命中 key 返 false 幂等。
- confirm/answer 缺 `toolCallId` 时(协议标 optional)记 warn 并 return,不抛。

### ③ A 侧:控制出口 + 本机真源端点

`RemoteDeviceController`(`apps/server-agent/src/controllers/remote-device.controller.ts`):

- `POST /api/remote-devices/:id/run/confirm`,body `{ streamId, sessionId, toolCallId, decision: "send"|"cancel", content?: string }` → `remoteRun.sendControl(cloudUserId, { streamId, targetDeviceId: id, sessionId, kind: "confirm", toolCallId, decision, content })`。
- `POST /api/remote-devices/:id/run/answer`,body `{ streamId, sessionId, toolCallId, answers: AnswerItem[] }` → `sendControl(..., { kind: "answer", toolCallId, answers })`。
- **`GET /api/remote-devices/:id/runs`**(本机真源,方案 1 核心),query `?sessionId=` 或 `?streamId=`:查 `RemoteRunService` 的 Map 返回活跃 run `{ streamId, sessionId, status }`(未找到返 null / 空)。`RemoteRunService` 暴露只读查询方法 `findRunBySession(targetDeviceId, sessionId)` / `findRunByStreamId(streamId)`。

DTO 走 `createZodDto`;端点补 Swagger(Phase A 遗留 Minor,本 spec 端点一并加)。

### ④ 前端:卡片路由 + create/reclaim 改造

`apps/web-agent`:

- **卡片透传**:`useSessionStream` 已知 `remoteDeviceId`(入参)与 `remoteStreamIdRef`(内部)。经 React context(推荐,避免 4 张卡逐层 props)或 props 把 `{ remoteDeviceId, streamId }` 透传到 4 张卡。
- **卡片 remote 分支**:
  - `ImSendConfirmCard` / `DriveShareCard` / `DriveCreateShareCard`:`remoteDeviceId` 非空时,点击走新 rest `confirmRemote(remoteDeviceId, { streamId, sessionId, toolCallId, decision, content })` → `POST /run/confirm`;否则走既有本地 `confirmSend`。
  - `AskQuestionCard`:remote 时走 `answerRemote(remoteDeviceId, { streamId, sessionId, toolCallId, answers })` → `POST /run/answer`;否则本地 `confirmAnswers`。
  - `agentRunEnd`/`run.error` 后禁用卡片交互(hook 已有 running/终态,卡片据此禁用)。
- **create 改造**(`launcher-home.tsx` + `remote-devices.ts`):删 `waitForNewRemoteSession` 轮询 B;改为 `startRemoteRun` 拿 `{streamId}` 后 `fetchRemoteRun(deviceId, {streamId})`(查 A 本机 `GET runs`,短间隔轮询本机至 sessionId 就绪,近乎即时)→ 导航 `?remoteDevice&id=<sessionId>&streamId=<streamId>`。
- **reclaim**(`use-session-stream.ts`):远程会话挂载时若 `remoteStreamIdRef` 为 null,`fetchRemoteRun(remoteDeviceId, {sessionId})` 拿 streamId 回填 `remoteStreamIdRef`,恢复 confirm/answer/interrupt 路由。

### ⑤ 错误处理(YAGNI,不引显式 ack)

- **超时竞态**:B `waitForDecision` 120s 固定。B 先超时 → 工具 fail-safe(im_send/ask 返 `{status:"timeout"}`)→ A 迟到 confirm 命中未知 key,`resolve` 返 false 幂等无害;A 卡片靠 B 转发的 `run.tool_call_end` 帧(已在 `FORWARDED_SESSION_EVENTS`,content 已剥)翻到终态。存在「A 显示可点、B 已超时」时间窗,接受(靠 tool_call_end 帧收敛)。
- **B 离线 / run 结束**:`handleAgentRunEnd` 删路由,之后 A confirm 静默无路由;前端在 `agentRunEnd`/`run.error` 后禁用卡片,不再让用户点。
- **无 ack**:`sendControl` fire-and-forget;后续 `tool_call_end` 帧作隐式 ack,不引 control-ack 帧。
- **重复点击**:同 toolCallId 多帧靠 `resolve` 幂等(第二次 false)兜底;前端点击后置 busy 防抖。

## 数据流(confirm 闭环,端到端)

```
B agent 执行 im_send → ImSendService.confirmAndSend → waitForDecision(key=cuid:Bsid:tcid) 挂起
  → tool_call 停 running(无 tool_call_end)
  → B RemoteRunInboundService 影子帧 run.tool_call_start 回传 → 云网关 → A RemoteRunService
  → A SessionGateway(经 REMOTE_SHADOW_FRAME 桥)→ A 前端渲染 ImSendConfirmCard(拿到 remoteDeviceId+streamId)
用户点「确认」→ confirmRemote → POST /run/confirm
  → A RemoteRunService.sendControl → relay agent.run.control{kind:confirm, streamId, Bsid, tcid, decision}
  → 云网关 handleAgentRunControl(streamId 查路由 + 发起方=登记 requester 校验)→ device:B
  → B relay 下行 → agentRunControlInbound → RemoteRunControlService
    → M3 校验 registry[streamId]===Bsid → account.run(cuid) → resolve(key, {action:decision, content})
  → B 那个 waitForDecision 解锁 → im_send 继续执行 → 结果经影子帧流回 A
```

## 组件边界与职责

| 单元 | 职责 | 依赖 |
|------|------|------|
| `AgentRunControlSchema`(升级) | answers 承载结构化 AnswerItem[] | libs/types(就地定义 item schema) |
| `RemoteRunControlService`(B) | confirm/answer/interrupt → resolve/interrupt + M3 校验 | ConfirmationService、RunnerService、streamId→sessionId 注册表 |
| streamId→sessionId 注册表(B) | 绑定校验的真源 | RemoteRunInboundService 维护 |
| `RemoteRunService`(A,扩展) | 新增 findRunBySession / findRunByStreamId 只读查询 | 已有 streams/activeSessionRuns Map |
| `RemoteDeviceController`(A,扩展) | run/confirm、run/answer、GET runs 三端点 | RemoteRunService |
| 4 张 HITL 卡(前端) | remote 分支走 control 帧;终态禁用 | useSessionStream 透传 remoteDeviceId+streamId |
| create/reclaim(前端) | 查 A 本机拿 sessionId/streamId | GET runs + rest fetchRemoteRun |

## 测试策略

- **协议**:AnswerItem[] schema 往返(含 other 字段);confirm/answer/interrupt 三 kind 解析。
- **B 侧 `RemoteRunControlService`**:confirm 真调 `resolve` 且 key 三段正确、`decision→action` 映射;answer 真调 resolve 且 answers 结构透传;M3 sessionId 不匹配 → 不 resolve;未知 key 幂等;缺 toolCallId → warn 不抛;interrupt 回归不变。
- **A 侧**:两控制端点构造正确 control(sendControl 收到期望字段);GET runs 按 streamId / sessionId 查中 / 查空;DTO 校验。
- **前端**:无组件测试基建 → tsc/build + biome;双设备手工:点确认(send)/拒绝(cancel)/改文案 content/回答多问题(selected+other)/超时后翻终态/刷新后再 confirm/B 离线后卡片禁用。

## 非目标(Phase B 之外)

- 多实例路由(Phase A I2 记账,streamId 路由表进程内 Map)——仍单实例;上线前另迁 Redis。
- 显式 control-ack 帧 / confirm 送达可靠回执——靠 tool_call_end 帧隐式 ack。
- 远程 HITL 的持久化(B 重启后恢复挂起)——本地 HITL 本就不持久化,对齐。
- 远程会话历史翻页、远程 usage 口径修正——Phase A 遗留 Minor,非本 spec。

## 安全

- control 帧的发起方校验(发起方 = streamId 登记的 requester)Phase A 已做,复用。
- M3 sessionId 绑定校验新增,防同账号内跨会话 resolve。
- key 含 cloudUserId,`account.run` scope 在 B 上正确(同账号不同设备),跨账号天然隔离。
