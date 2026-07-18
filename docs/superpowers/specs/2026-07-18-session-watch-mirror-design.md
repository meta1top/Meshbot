# Agent 级观察通道：订阅同一个 Agent 的端，会话与推理都同步

> 设计 spec（v2，2026-07-18 修订）。触发：真机验证发现两个缺口——
> ①「两端都开着会话 A，从对端继续聊时本端不实时输出」；
> ②「A 设备远程给 B 创建的会话，B 上不实时出现」。
> v1 只覆盖了 ① 的推理帧镜像；用户指出 ② 暴露的是同一个架构缺失，
> **应当用一条统一的事件机制承载「和对话相关的一切」**，本版据此把 watch 从 session 层提到 **Agent 层**。

## Goal

**订阅了同一个 Agent 的端（无论本地还是远程），关于该 Agent 的一切都同步**：
- **会话生命周期**：新建 / 删除 / 改名 / 状态变化 → 各端实时看到（修 ②）
- **推理帧**：正在跑的 run 实时镜像给观察者，中途进入能续上半截输出（修 ①）
- **HITL**：观察者也能应答确认卡/提问卡

## 背景与现状（已确证，精确到文件:行）

**本地发起的 run，帧永远出不了设备**：
- `RunnerService` 经 EventEmitter2 广播 → `apps/server-agent/src/ws/session.gateway.ts:124-261` 逐个 `@OnEvent` 转发到 `this.server.to(payload.sessionId)`，即 **ws/session 命名空间的本机房间**，只有本地浏览器连得上，**没有任何出口**。
- 唯一能把帧抬出设备的桥是 `apps/server-agent/src/services/remote-run-inbound.service.ts:220-293` 的 `subscribeAndForward`，而它**只**在 `onAgentRunRequest`（同文件 `:139-194`）里被调用；监听器 per-request 注册（`:288`），终止事件即全部退订（`:233-238`、`:285`）。**没有远程 run 请求 = 零监听器 = 帧永不出设备。**

**云端路由是 streamId 单播，无 fan-out**：
- `apps/server-main/src/ws/im.gateway.ts:547` 在 `agentRunStart` 时才 `agentRunRoutes.set(streamId, {requester,...})`；`:568-579` 的 `handleAgentRunFrame` 只能 `agentRunRoutes.get(streamId)` → 发给那**一个** requester。
- **没有 sessionId / agentId 反向索引**（这也正是 web-main 侧做不了 `fetchActiveRun` 的同一个缺失）。

**观察者即使收到帧也会被丢**：`apps/web-main/src/lib/session-transport.ts:65-77` 只监听 `agentRunFrame`/`agentRunEnd` 交给 `RemoteRunTracker`，而 tracker 只处理**本实例 `register()` 过的 streamId**（`packages/web-common/src/session/remote-run-tracker.ts:52-69`）。

**设备侧完全不知道有观察者**：云端房间只有 `org:` / `device:` / `conv:`（`im.gateway.ts:284-299`）；设备入站 relay 事件全集 9 个（`apps/server-agent/src/cloud/im-relay.events.ts:8-29`），**无任何 subscribe / watch / observer-presence 语义**。

**会话生命周期事件出不了设备（缺口 ②）**：本地已有一套 ws/events 全局总线事件（`session.status_changed`、`agent.changed` 等，经 `events.gateway.ts` 的 `emitEnvelope` 按 acct 房间下发），但**这套事件只走本机 ws/events，不经 relay**。所以远端建的会话、改的名，对端要刷新才看得到。

**HITL 应答校验绑死 streamId**：`RemoteRunControlService` 经 `RemoteRunRegistryService` 做 streamId→sessionId 校验。被镜像的本地 run **没有 streamId**。

**可复用资产**：`subscribeAndForward` 本质已是「把某 sessionId 的帧按某 id 镜像上 relay」，差的只是**触发时机**（run 开始 vs 观察者进入）与**生命周期**（终止即退订 vs 常驻）。

## 锁定决策

| # | 决策 | 取值 |
|---|------|------|
| D1 | 方案 | **watch/镜像通道**（真解），非轮询降级 |
| D2 | HITL | **观察者也能应答**（control 接受 watchId 寻址，注册表绑 watchId） |
| D3 | 并发应答仲裁 | **先到先得**：首个到达服务端的应答生效并关卡；其余端收到「已由某端应答」并把卡片置为已完成 |
| D4 | 范围 | **对称**：任一端看任一端（web-main 看设备、web-agent A 看设备 B 均可） |
| D5 | watch 生命周期 | 进入 Agent 即 agent-watch、打开会话即 session-watch；离开即 unwatch；idle 5 分钟拆除；断线重连自动重 watch |
| D6 | 重复投递 | 同一客户端持有自己的 stream 期间**抑制** session-watch 的帧（不逐帧去重） |
| D7 | 中途续上 | `watch_accepted` 回包**携带 inflight 快照**（设备侧 `runner.getInflight` 现成） |
| **D8** | **watch 粒度** | **两级 scope、同一套协议**：**Agent 级**订会话生命周期（低频）；**Session 级**订推理帧（高频，仅当前打开的会话）。理由：一个 Agent 可能有几十个会话，把全部推理帧推给每个观察者是浪费 |
| **D9** | **本地/远程统一程度** | **统一事件契约、双传输**：前端消费同一套事件模型，不管 Agent 是本地还是远程；但传输仍是两条（本地 ws/events、远程 relay）。**传输层合一不在本轮**（另一个量级的重构） |

## 架构

### A. 协议层（`libs/types`，L3 扩展）

**统一的事件契约**（本地与远程共用同一份 schema，D9）：

会话生命周期事件（Agent 级 watch 投递）：
- `session.created` → `{ agentId, session: SessionSummary }`
- `session.deleted` → `{ agentId, sessionId }`
- `session.renamed` → `{ agentId, sessionId, title }`
- `session.status_changed` → `{ agentId, sessionId, status }`（**已存在**，本轮把它纳入统一契约并让它能跨 relay）

watch 控制事件：
- `agent.watch` → `{ watchId, targetAgentId }`（Agent 级，订生命周期）
- `session.watch` → `{ watchId, targetAgentId, sessionId }`（Session 级，订推理帧）
- `watch_accepted` → `{ watchId, inflight: InflightSnapshot | null }`（Session 级时携带续上快照）
- `unwatch` → `{ watchId }`

**镜像帧复用既有 `AgentRunFrame` 结构**，但以 **`watchId`** 寻址（新增可选 `watchId`；`streamId` 与 `watchId` 二选一必填）。HITL control 事件的寻址字段同样从「仅 streamId」放宽为 **`streamId` 或 `watchId`**。

### B. 云端路由（`server-main` `im.gateway`）

现有 `agentRunRoutes` 是 **streamId → 单个 requester 的 1:1**，承不了 fan-out。新增：
- `watchRoutes: Map<watchId, { requester, scope: "agent"|"session", agentId, sessionId?, deviceId, userId }>`
- **`agentWatchers: Map<\`${deviceId}:${agentId}\`, Set<watchId>>`** —— 生命周期事件 fan-out
- **`sessionWatchers: Map<\`${deviceId}:${sessionId}\`, Set<watchId>>`** —— 推理帧 fan-out

鉴权复用既有 `CloudAgentService.findActiveById` + `agent.userId === requesterUserId`。

**断线清理四条路径**（`im.gateway.ts:345` 现有清理需扩展）：观察者 socket 断开 → 清其全部 watchId 并通知设备；设备断开 → 清该设备全部 watch 路由并通知观察者；显式 unwatch；idle 超时。

### C. 设备侧（`server-agent`）

**C1. 会话生命周期镜像器**（新，修 ②）：把已有的本地生命周期事件（`session.created/deleted/renamed/status_changed`）在**有 Agent 级观察者时**同时镜像上 relay。
- 事件源已存在（`SessionService` 的增删改、`RunnerService` 的 status），本轮只是**多加一条出口**，不改事件本身。
- 按 `agentId` 判断有无观察者，无则不镜像（零成本）。

**C2. 会话级常驻转发器**（改自 `subscribeAndForward`，修 ①）：
- 按 `sessionId` 维护观察者集合；集合非空时挂 EventEmitter2 监听并把帧镜像上 relay。
- **与现有 per-run 转发器的本质差异：不在 `run.done` 时退订**，跨多轮存活到 unwatch/idle。
- **保留 subagent `allowedSessions` 动态集合逻辑**（现有转发器有此逻辑，抽取时不能丢）。
- idle 拆除：观察者集合空后 **5 分钟**仍无新观察者则释放监听（留缓冲避免刷新/切页反复挂退）。
- 收 session-watch 时用 `runner.getInflight` 组 `watch_accepted` 的 inflight 快照（D7）。

**取舍（本 spec 定）**：设备**每个 session/agent 只镜像一份事件上 relay**，由**云端按 watchers 表 fan-out**。省设备上行；观察者增减不影响设备侧行为。

### D. HITL（D2/D3）

- `RemoteRunRegistryService` 除 streamId 外**也绑 watchId → sessionId**。
- `RemoteRunControlService` 接受 watchId 寻址的 confirm/answer；校验该 watchId 确实在观察该 session 且属于该 user。
- **先到先得（D3）**：`ConfirmationService` 是单例挂起核心，天然只 resolve 一次；晚到的应答收到明确错误（新错误码 `HITL_ALREADY_ANSWERED`）。
- **关卡广播**：应答生效后，把「该卡片已由某端应答」作为一帧镜像给**全部观察者 + 本地 ws/session 房间**，各端据此把卡片置为已完成。

### E. 对称的客户端（D4/D9）

- 观察者逻辑（watch/unwatch、tracker 按 watchId 认帧、inflight 续上、生命周期事件应用到会话列表）抽到 **`packages/web-common`** 共享。
- **transport 不同**：web-main 直连 relay；**web-agent 走自己的 server-agent 代理**（浏览器不直连云端）。
- 前端消费**同一套事件模型**：本地 Agent 的生命周期事件来自 ws/events，远程 Agent 的来自 relay 镜像，**上层处理逻辑一份**（D9 的「统一契约」落点）。
- `RemoteRunTracker` 扩展为同时认 streamId（自己发起的）与 watchId（观察的），并实现 D6 抑制。

## 数据流

**进入 Agent**：客户端 agent-watch → 云端鉴权登记 → 设备登记观察者 → 此后该 Agent 的会话增删改名实时到达 → **A 远程建的会话，B 上立刻出现（修 ②）**。

**打开会话**：客户端 session-watch → 设备回 `watch_accepted{inflight}` → 渲染半截输出 → 此后该会话的推理帧实时到达 → **对端发起的 run，本端也能实时看（修 ①）**。

**观察者应答 HITL**：观察者点确认 → control 带 watchId → 设备校验观察关系 → `ConfirmationService.resolve`（先到先得）→ 关卡帧广播给所有端。

**离开**：unwatch → 设备移除观察者，集合空则退订（session 级）/停止镜像（agent 级）。

## 错误处理

- **relay 断**：观察者退化为「不实时」，重连自动重 watch 并用新的 `watch_accepted.inflight` 续上（D5）。
- **无权 watch**：云端鉴权失败直接拒，不下发设备。
- **设备离线**：watch 送不达 → 云端回明确失败，观察者提示（不静默）。
- **晚到 HITL 应答**：`HITL_ALREADY_ANSWERED`，客户端把卡片置为已完成而非报错弹窗。
- **idle 泄漏防护**：设备侧 idle 拆除 + 云端断线四路清理。常驻转发器没有「run 终止」这个天然终点，**这是本设计最需要防的泄漏点**。

## 测试

- **协议/schema**：新事件 + `AgentRunFrame` 的 watchId 寻址 zod 校验。
- **云端 fan-out**：多观察者各收一份；`watchRoutes`/`agentWatchers`/`sessionWatchers` 三表一致；**四条断线清理路径各自单测**。
- **生命周期镜像（②）**：有 Agent 级观察者时新建/删除/改名会被镜像；无观察者时不镜像（零成本）。
- **会话级转发器（①）**：首个观察者挂监听/末个退订；**跨多轮 run 存活**（关键差异，必测）；subagent allowedSessions 逻辑未丢；idle 拆除。
- **HITL**：观察者应答生效；先到先得（并发两应答只一个成功）；关卡帧广播到全部端；无权 watchId 被拒。
- **续上**：中途 session-watch 拿到 inflight 并渲染半截输出。
- **D6 抑制**：同一客户端既发起又观察时不收双份。
- **对称**：web-agent 经 server-agent 代理 watch 设备 B 的链路。
- 改 module/DI 真启动验证（**用 `timeout 60 node dist/main.js`，不要用 nodemon 起常驻**）。

## 交付顺序（建议，供 plan 细化）

1. 协议 + 设备侧会话级常驻转发器（含 inflight 快照）
2. 云端 watchRoutes + 三表 fan-out + 四路清理
3. web-main 观察者（直连 relay）——先打通「云端看本地」，可独立验证
4. **生命周期镜像（修 ②）**——Agent 级 watch 打通，独立可验
5. HITL watchId 寻址 + 先到先得 + 关卡广播
6. web-agent 观察者（server-agent 代理）——补齐 D4 对称
7. 终验 + 双机冒烟

**可中断点**：做完 3 或 4 都是可独立交付验证的状态。

## 不在本轮

- **传输层合一**（本地 ws/events 与远程 relay 统一成一条通道）——D9 只统一契约，传输合一是另一个量级的重构。
- 观察者列表 /「谁在看」的 presence UI。
- 观察者对 run 的其他控制（**打断仍限发起方**，观察者只能应答 HITL）。
- 远程 history 补齐 `byMessage` usage / tool 结果折叠 / subagent 认领（远程 history 走 `SessionMessagePage` 被 `as HistoryResponse` 强转，缺这些加工）——独立问题。
