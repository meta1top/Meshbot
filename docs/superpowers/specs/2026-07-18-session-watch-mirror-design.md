# 会话级 watch/镜像通道：任一端跟看任一端正在跑的 run

> 设计 spec。触发：真机验证「云端和本地都打开会话 A，从本地继续聊时云端不实时输出（反向可以）」。
> 上游事实来自专项排查（见下「现状」，均已精确到文件:行）。

## Goal

把 L3 从**「只能看自己发起的 run」（stream 语义）**扩展到**「任一端可跟看任一端正在跑的 run」（session 观察语义）**：观察者实时收到镜像帧、中途进入能续上半截输出、且**可以应答 HITL**（确认卡/提问卡）。

## 背景与现状（已确证）

**本地发起的 run，帧永远出不了设备**：
- `RunnerService` 经 EventEmitter2 广播 → `apps/server-agent/src/ws/session.gateway.ts:124-261` 逐个 `@OnEvent` 转发到 `this.server.to(payload.sessionId)`，即 **ws/session 命名空间的本机房间**，只有本地浏览器连得上，**没有任何出口**。
- 唯一能把帧抬出设备的桥是 `apps/server-agent/src/services/remote-run-inbound.service.ts:220-293` 的 `subscribeAndForward`，而它**只**在 `onAgentRunRequest`（同文件 `:139-194`）里被调用；监听器 per-request 注册（`:288`），终止事件即全部退订（`:233-238`、`:285`）。**没有远程 run 请求 = 零监听器 = 帧永不出设备。**

**云端路由是 streamId 单播，无 fan-out**：
- `apps/server-main/src/ws/im.gateway.ts:547` 在 `agentRunStart` 时才 `agentRunRoutes.set(streamId, {requester,...})`；`:568-579` 的 `handleAgentRunFrame` 只能 `agentRunRoutes.get(streamId)` → 发给那**一个** requester。
- **没有 sessionId 反向索引**（这也正是 web-main 侧做不了 `fetchActiveRun` 的同一个缺失）。

**观察者即使收到帧也会被丢**：`apps/web-main/src/lib/session-transport.ts:65-77` 只监听 `agentRunFrame`/`agentRunEnd` 交给 `RemoteRunTracker`，而 tracker 只处理**本实例 `register()` 过的 streamId**（`packages/web-common/src/session/remote-run-tracker.ts:52-69`）。

**设备侧完全不知道有观察者**：云端房间只有 `org:` / `device:` / `conv:`（`im.gateway.ts:284-299`）；设备入站 relay 事件全集 9 个（`apps/server-agent/src/cloud/im-relay.events.ts:8-29`），**无任何 subscribe / watch / observer-presence 语义**。观察者留下的唯一痕迹是一次性 `device.query.request` kind=`history`（查完即忘）。

**HITL 应答校验绑死 streamId**：`RemoteRunControlService` 经 `RemoteRunRegistryService` 做 streamId→sessionId 校验。被镜像的本地 run **没有 streamId**。

**可复用资产**：`subscribeAndForward` 本质已是「把某 sessionId 的帧按某 id 镜像上 relay」，差的只是**触发时机**（run 开始 vs 观察者进入）与**生命周期**（终止即退订 vs 常驻）。

## 锁定决策

| # | 决策 | 取值 |
|---|------|------|
| D1 | 方案 | **watch/镜像通道**（真解），非轮询降级 |
| D2 | HITL | **观察者也能应答**（control 接受 watchId 寻址，注册表绑 watchId） |
| D3 | 并发应答仲裁 | **先到先得**：首个到达服务端的应答生效并关卡；其余端收到「已由某端应答」并把卡片置为已完成 |
| D4 | 范围 | **对称**：任一端看任一端（web-main 看设备、web-agent A 看设备 B 均可） |
| D5 | watch 生命周期 | 打开会话即 watch、离开即 unwatch；idle 拆除；断线重连自动重 watch |
| D6 | 重复投递 | 同一客户端持有自己的 stream 期间**抑制 watch**（不逐帧去重） |
| D7 | 中途续上 | `watch_accepted` 回包**携带 inflight 快照**（设备侧 `runner.getInflight` 现成） |

## 架构

### A. 协议层（`libs/types`，L3 扩展）

新增三个 wire 事件（与既有 `agentRunStart`/`agentRunFrame` 同处定义）：
- `agent.session.watch` → `{ watchId, targetAgentId, sessionId }`（观察者 → 云端 → 设备）
- `agent.session.watch_accepted` → `{ watchId, inflight: InflightSnapshot | null }`（设备 → 云端 → 该观察者）
- `agent.session.unwatch` → `{ watchId }`

**镜像帧复用既有 `AgentRunFrame` 结构**，但**以 `watchId` 寻址**（新增可选 `watchId` 字段；`streamId` 与 `watchId` 二选一必填）。这样前端 tracker 的帧解析逻辑可复用，只是路由键不同。

HITL 应答扩展：既有 control 事件（confirm/answer/interrupt）的寻址字段从「仅 streamId」放宽为 **`streamId` 或 `watchId`**。

### B. 云端路由（`server-main` `im.gateway`）

新增两张表 + 一条 fan-out 路径：
- `watchRoutes: Map<watchId, { requester, sessionId, deviceId, userId }>`
- **`sessionWatchers: Map<\`${deviceId}:${sessionId}\`, Set<watchId>>`** —— fan-out 的关键索引，今天完全不存在。

流程：
1. 收 `agent.session.watch` → 鉴权（该 user 是否有权观察目标 agent/设备，复用现有 `CloudAgentService.findActiveById` + `agent.userId === requesterUserId` 校验）→ 登记两张表 → 定向 `device:<deviceId>` 房间下发。
2. 收设备上来的镜像帧（带 watchId）→ `watchRoutes.get(watchId)` → 发给该 requester。
3. 设备主动广播某 session 的帧时**按 `sessionWatchers` fan-out** 给全部观察者。

**断线清理四条路径**（`im.gateway.ts:345` 现有清理需扩展）：观察者 socket 断开 → 清其全部 watchId 并通知设备 unwatch；设备断开 → 清该设备全部 watch 路由并通知观察者；显式 unwatch；idle 超时。

### C. 设备侧（`server-agent`）

从 `RemoteRunInboundService.subscribeAndForward` 抽出**会话级常驻转发器**（新 service，如 `SessionMirrorService`）：
- 按 `sessionId` 维护观察者集合；**集合非空时**挂 EventEmitter2 监听并把帧镜像上 relay（按每个 watchId 发一份，或发一次由云端 fan-out——见下「取舍」）。
- **与现有 per-run 转发器的本质差异：不在 `run.done` 时退订**，跨多轮存活到 unwatch/idle。
- **保留 subagent `allowedSessions` 动态集合逻辑**（现有转发器有此逻辑，抽取时不能丢）。
- idle 拆除：观察者集合空后 **5 分钟**仍无新观察者则释放监听（留缓冲避免刷新/切页导致的瞬时空集合反复挂/退）。
- 收 watch 请求时用 `runner.getInflight` 组 `watch_accepted` 的 inflight 快照（D7）。

**取舍（本 spec 定）**：设备**每个 session 只镜像一份帧上 relay**（带 sessionId），由**云端按 `sessionWatchers` fan-out**。理由：省设备上行带宽；观察者增减不影响设备侧行为。故镜像帧携带 `{deviceId, sessionId}` 由云端解析成 watchId 列表。

### D. HITL（D2/D3）

- `RemoteRunRegistryService` 除 streamId 外**也绑 watchId → sessionId**。
- `RemoteRunControlService` 接受 watchId 寻址的 confirm/answer；校验该 watchId 确实在观察该 session 且属于该 user。
- **先到先得（D3）**：`ConfirmationService` 是单例挂起核心，天然只 resolve 一次；晚到的应答收到明确错误（新错误码，如 `HITL_ALREADY_ANSWERED`）。
- **关卡广播**：应答生效后，设备侧把「该卡片已由某端应答」作为一帧镜像给**全部观察者 + 本地 ws/session 房间**，各端据此把卡片置为已完成（否则其他端卡片永远挂着）。

### E. 对称的客户端（D4）

- 观察者逻辑（watch/unwatch、tracker 按 watchId 认帧、inflight 续上）抽到 **`packages/web-common`** 共享。
- **transport 不同**：web-main 直连 relay；**web-agent 走自己的 server-agent 代理**（浏览器不直连云端）——即 A 的 server-agent 需要新增 watch 代理端点 + 把镜像帧经 ws/events 或 ws/session 转给 A 的浏览器。
- `RemoteRunTracker` 扩展为同时认 streamId（自己发起的）与 watchId（观察的），并实现 D6 抑制。

## 数据流

**建立观察**：观察者打开会话 A → 生成 watchId → `agent.session.watch{watchId, targetAgentId, sessionId}` → 云端鉴权+登记+下发设备 → 设备登记观察者、（首个观察者时）挂监听、回 `watch_accepted{inflight}` → 观察者用 inflight 渲染半截输出。

**镜像**：本地用户在设备上继续聊 → runner 出帧 → 本机 ws/session 房间（本地实时，不变）**且** `SessionMirrorService` 镜像一份上 relay → 云端按 `sessionWatchers` fan-out → 各观察者渲染。

**观察者应答 HITL**：观察者点确认 → control 事件带 watchId → 云端按 watchRoutes 转设备 → 设备校验 watchId 观察关系 → `ConfirmationService.resolve`（先到先得）→ 关卡帧镜像给所有端。

**结束观察**：离开会话/断线/idle → unwatch → 设备移除观察者，集合空则退订监听。

## 错误处理

- **云端不可达 / relay 断**：观察者侧退化为「不实时」，重连后自动重 watch 并用新的 `watch_accepted.inflight` 续上（D5）。
- **观察者无权**：云端鉴权失败直接拒 watch（复用既有 agent.userId 校验），不下发设备。
- **设备离线**：watch 请求无法送达 → 云端回明确失败，观察者提示（不静默）。
- **晚到 HITL 应答**：`HITL_ALREADY_ANSWERED`，客户端把卡片置为已完成而非报错弹窗。
- **idle 泄漏防护**：设备侧 idle 拆除 + 云端断线四路清理，避免观察者异常消失后永久挂监听（现有 per-run 转发器靠终止事件退订，常驻转发器没有这个天然终点，**这是本设计最需要防的泄漏点**）。

## 测试

- **协议/schema**：三个新事件 + `AgentRunFrame` 的 watchId 寻址 zod 校验。
- **云端 fan-out**：多观察者同 session 各收一份；watchRoutes/sessionWatchers 双表一致；**四条断线清理路径各自单测**（观察者断、设备断、显式 unwatch、idle）。
- **设备转发器**：首个观察者挂监听/末个观察者退订；**跨多轮 run 存活**（关键差异，必测）；subagent allowedSessions 逻辑未丢；idle 拆除。
- **HITL**：观察者应答生效；先到先得（并发两应答只一个成功、另一个得 `HITL_ALREADY_ANSWERED`）；关卡帧广播到全部端；无权 watchId 应答被拒。
- **续上**：中途 watch 拿到 inflight 并渲染半截输出。
- **D6 抑制**：同一客户端既发起又观察时不收双份。
- **对称**：web-agent 经 server-agent 代理 watch 设备 B 的链路。
- 改 module/DI 真启动验证（临时 MESHBOT_HOME）。

## 交付顺序（建议，供 plan 细化）

1. 协议 + 设备侧常驻转发器（含 inflight 快照）
2. 云端 watchRoutes/sessionWatchers + fan-out + 四路清理
3. web-main 观察者（直连 relay）——先打通不对称的「云端看本地」，可独立验证
4. HITL watchId 寻址 + 先到先得 + 关卡广播
5. web-agent 观察者（server-agent 代理）——补齐 D4 对称
6. 终验 + 双机冒烟

## 不在本轮

- 观察者列表/"谁在看"的呈现（presence UI）。
- 观察者对 run 的其他控制（除 HITL 应答外，如替观察者打断——**打断仍限发起方**）。
- 远程 history 补齐 `byMessage` usage / tool 结果折叠 / subagent 认领（排查中发现远程 history 走 `SessionMessagePage` 被 `as HistoryResponse` 强转，缺这些加工）——独立问题，本轮只补 D7 需要的 inflight。
