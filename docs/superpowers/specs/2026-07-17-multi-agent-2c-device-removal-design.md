# 计划二 2c：去「设备」概念、Agent 为主体统一导航 + 跨设备远程寻址迁云端 agentId

> 设计 spec。上游：`2026-07-15-multi-agent-per-device-design.md`（§9 IA 愿景）、
> `2026-07-17-multi-agent-2b-cloud-registration-design.md`、
> `2026-07-17-multi-agent-2b-webagent-addendum.md`（本 spec 吸收并取代之）。
> 触发：真机冒烟 #5 / #9 / #11。

## Goal

把 web-agent 与 web-main 的导航/发起模型从「**设备**为主」彻底改为「**Agent** 为主」：
用户面对的组织对象恒为一个 Agent（本机 Agent + 其他设备上开了「允许远程」的远程 Agent），
「设备」不再是导航层或发起目标，仅作为远程 Agent 的**归属副标题**保留以消歧。
同时把 web-agent 跨设备远程寻址从 deviceId 迁到**云端 agentId**（当前是断的，必修）。

## 背景与现状（已确认）

- **2b 遗留**：寻址协议已 `targetDeviceId → targetAgentId`（T5 网关只用 `CloudAgentService.findActiveById(targetAgentId)` 查 `agent` 表）。
- **web-agent 跨设备当前断裂**：`remote-run.service.ts:146` 发 `targetAgentId: targetDeviceId`（值仍是 deviceId）；`remote-device.controller.ts:143/159/175` 发 `targetAgentId: id`（id=URL deviceId）。deviceId 在 agent 表解不出 → 网关静默丢弃 → 远程发起/浏览无声超时。**故后端寻址迁移是本轮必须项，非打磨。**
- **web-main 已按 agentId 寻址**（2b·T7 路由 `[agentId]`、`session-transport` 发 targetAgentId），但侧栏树仍按宿主设备分组（`primaryAgentIdByDevice` 每设备取最早注册的一个 Agent 做展示↔寻址换算）→ 点设备节点永久骨架（#11）。
- **共享组件**：web-agent 与 web-main 侧栏都用 `@meshbot/web-common/session` 的 `SessionTree`（节点 kind：device/session/placeholder/agent）。

## 锁定决策

| # | 决策 | 取值 |
|---|------|------|
| D1 | 远程 Agent 归属呈现 | Agent 名为主，宿主**设备名作副标题**消歧；设备不再是导航层 |
| D2 | web-agent 侧栏本机/远程排布 | **扁平单列表**：本机 Agent 在前、远程在后，同列；远程带设备名副标题 |
| D3 | 宿主设备离线的远程 Agent | **本轮做**：从设备 presence 派生，离线宿主的 Agent 置灰 + 禁止发起/展开 |
| D4 | 交付 | 一个 spec 一个 plan，任务顺序 **后端 → web-agent → web-main** |

不引兼容层：改完全仓 grep 确认无残留「把 deviceId 当 targetAgentId 寻址值」。

## 架构：三层

### A. 后端（server-agent）——寻址迁云端 agentId

**A1. 代理云端 Agent 列表**
新增 server-agent 端点 `GET /api/remote-agents`：用现有 `cloud-client.service`（device token）代理云端 `GET /api/agents`，返回**同账号其他设备**上已注册（remote_enabled）的远程 Agent：
`{ id, deviceId, localAgentId, name, avatar, description, deviceName, deviceOnline }[]`。
- `id` = 云端 agent.id（寻址主键，网关 `findActiveById` 查的就是它）。
- 过滤掉**本机设备**自身的 agent（本机 Agent 走本地列表，不算「其他设备的远程 Agent」）；用本机 deviceId 比对 `agent.deviceId`。
- `deviceName` / `deviceOnline`：云端 `GET /api/agents` 已带宿主信息则透传；否则 server-agent 侧按 `agent.deviceId` 补（读云端设备 presence）。web-agent 据此渲染副标题 + 离线灰化（D1/D3）。
- web-agent 客户端 `rest/` 加 `useRemoteAgents()`。

**A2. 转发真正的 agentId**
- `remote-run.service.startRun`：入参与字段语义正名为 `targetAgentId`（值=云端 agentId），并发守卫键 `sessionKey(targetAgentId, sessionId)` 随之；删掉类注释里「值仍是 deviceId」段。
- `remote-device.controller`：远程会话浏览/run/control 端点路径参数从 deviceId 改为**云端 agentId**（`/api/remote-agents/:agentId/*` 新路由或 `:id` 语义迁移，二选一，plan 定），转发真值。
- web-agent 远程会话浏览（`createRemoteSessionTransport` / `remote-sessions` atom）跟着按 agentId 寻址。

### B. web-agent UI——「设备」从目标 + 导航消失

**B1. 起手台目标（#5）**
`ComposerTarget` 去掉 `device` 判别分支 → 恒为 `{ kind: "agent"; id }`（id 为**本机 localAgentId 或云端 agentId**，用一个显式字段区分本机/远程，见下）。下拉数据源 = 本机 `useAgents()` + 远程 `useRemoteAgents()` 合并：

```ts
type LauncherTarget =
  | { scope: "local"; agentId: string }            // 本机，走 createSession
  | { scope: "remote"; cloudAgentId: string };     // 远程，走 L3 startRun(cloudAgentId)
```

- 本机 Agent 在前、远程在后（D2），远程项显示 Agent 名 + 设备名副标题；离线宿主的远程项置灰、不可选（D3）。
- `launcher-home` 发送分流：`scope==="local"` → 本地 createSession + agentId；`scope==="remote"` → L3 `sendToRemoteAgent(cloudAgentId)`（原 `sendToRemoteDevice(deviceId)` 改名 + 换值）。
- 删除 `devicesAtom` 在起手台的使用（`composer-target-bar` 不再列设备）。

**B2. 侧栏（#9）**
去掉下区「其他设备 → 远程会话」设备树，变**扁平 Agent 列表**：
- 本机 Agent（可展开 → 本地会话，保留 hover 编辑铅笔）+ 远程 Agent（可展开 → 该 Agent 的远程会话，只读，无编辑铅笔），同一列表，本机在前远程在后。
- 远程 Agent 带设备名副标题 + 离线灰化（离线不可展开/不可发起）。
- 会话叶子点击：本机 → 本地会话路由；远程 → 远程会话浏览（按 cloudAgentId，url 参数从 `?remoteDevice=` 改 `?remoteAgent=`）。
- `SessionTree` 复用；`agent` 节点扩展承载「远程 + 宿主设备名 + 在线态」展示属性（新增可选字段，本机 Agent 不传即本机语义）。设备 kind 节点在 web-agent 不再使用。

### C. web-main UI——侧栏去设备层（#11）

- 侧栏从「按宿主设备分组 + `primaryAgentIdByDevice` 换算」拍平成**Agent 列表**（数据源 `useAgents()` 已是云端 agent 列表）。每个 Agent 一节点，展开 → 该 Agent 的远程会话（`useRemoteSessions(agentId)`），点会话 → `/assistant/[agentId]?session=`。
- 删除 device 分组节点与 `primaryAgentIdByDevice` 换算层 → 修掉点设备永久骨架（#11）。
- 远程 Agent 带宿主设备名副标题（`useDevices()` 按 `agent.deviceId` 反查）+ 离线灰化（`useDevicePresenceSync` 已有）。
- 起手台 `launcher.tsx` 已是 Agent 下拉（2b·T7），本轮仅补副标题/离线灰化对齐 D1/D3，逻辑不大改。

## 数据流

**发起（web-agent → 远程 Agent）**
选远程 Agent（cloudAgentId）→ `startRun(cloudAgentId, ...)` → relay `agentRunStart{ targetAgentId: cloudAgentId }` → 云端网关 `findActiveById` 解出宿主 deviceId + localAgentId → emit `device:<deviceId>` room（带 forwarded.localAgentId）→ B 侧 `remote-run-inbound` 二次门控（只信 forwarded.localAgentId + 校 remote_enabled）→ 本地 run → 回流。

**浏览远程会话** 同理，`/api/remote-agents/:agentId/sessions` 经 server-agent 代理 relay 到宿主设备的该 localAgentId。

## 错误处理

- **远程 Agent 关了允许远程**（云端软删）：`useRemoteAgents()` 列表消失（已由 #12 实时推送覆盖）；正发起时被二次门控拒（`agent_not_remotable`，已由 #13 覆盖）。
- **宿主设备离线**：列表置灰禁发（D3）；仍强发则走既有 `offline` reason（#13 已 i18n）。
- **远程 Agent 已寻址但云端解不出**（竞态删除）：网关静默丢 → 依赖发起端 idle-timeout 兜底（既有）。

## 测试

- **A1** 代理端点单测（mock cloud.get；本机 agent 过滤；deviceName/online 拼装）。
- **A2** `remote-run.service` / `remote-device.controller` 单测按 agentId 转发；grep 断言无 deviceId 残留。
- **B/C** 纯函数抽取并单测：本机+远程合并排序、离线灰化判定、target scope 分流、url 参数 remoteAgent 解析。改 module/DI 真启动验证（临时 MESHBOT_HOME）。
- 全仓 typecheck + `npx jest`（相关路径）+ build + `pnpm check` + sync-locales。

## 交付顺序（D4）

后端（A1→A2）→ web-agent（B1→B2）→ web-main（C）。每层独立可测；web-agent 交付后可在第二台机器手工冒烟（选设备 B 的某远程 Agent 发起 → 落到 B 的那个 agent、过二次门控；宿主离线灰化；关允许远程后消失）。

## 不在本轮

- Agent 编组（本地/跨设备）——后续独立需求。
- #1 模型本地+云端组合——单独 brainstorm。
- 双轨对等技能/规则（附加请求）——单独处理。
- 云端 `GET /api/agents` 若需补 deviceName/online 字段而动 server-main：优先 server-agent 侧拼装，尽量不改云端契约；确需改则 A1 plan 说明（不改 DDL）。
