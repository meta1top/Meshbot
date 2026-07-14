# web-main 二期：云端 ↔ 设备远程会话 设计 spec

> Shell v2 二期（一期=壳+IM 抽包，PR #38 已合）。本期：web-main 浏览器与任意
> 已授权在线设备完整会话。分支 `feat/web-main-remote-session`，连续提交。

## 0. 需求

云端（web-main）没有本地 agent，但可与所有已授权设备发起/继续会话——
会话界面与 web-agent **全量对齐**（用户已确认：全量抽包，非精简版）。

## 1. 现状勘查结论

| 项 | 现状 |
|---|---|
| L3 协议 | server-main `im.gateway` 完整承担帧中转：`agentRunStart/Frame/End/Control` + `deviceQuery`；但发起方硬编码设备身份（`requesterDeviceId`，用户连接被 `if (!requesterDeviceId) return` 拒）；路由表 `agentRunRoutes: streamId → {requesterDeviceId, targetDeviceId}`，回流走 `device:` room |
| 安全不变量 | 帧回流校验发送方=登记 targetDeviviceId；控制帧校验发起方身份；同账号校验 `target.userId === requester.userId` |
| web-agent 会话 UI | ~3600 行：`use-session-stream`（1095 行，含完整 remote 分支——远程 HITL/interrupt/patch-model/readOnly 语义现成）+ 15 个组件（message-list/tool-call-block/ask-question-card/im-send-confirm-card/reasoning/markdown/todo 面板/subagent 卡/artifact 卡/用量等） |
| 关键简化 | **web-main 的会话形态 ≡ web-agent 的远程会话形态**——抽包后 web-main 只走 remote 路径，无新语义 |
| B 端 | server-agent 的 RemoteRunInbound/QueryInbound 只回 correlationId/streamId，不关心发起方——**零改动** |
| web-main 通道 | 一期的 ws/im 用户 socket 单例（JWT 认证）+ mainApi 现成 |
| 跨设备产物 | deviceQuery 已有 artifact-file/artifact-upload-drive 两 kind（设备发起方版），泛化后 web-main 免费获得 |

## 2. 设计

### 2.1 协议侧：发起方泛化（server-main，B 端零改动）

- 路由表值改：`{ requester: { kind: "device"; deviceId: string } | { kind: "user"; socketId: string }, targetDeviceId }`。
- `handleAgentRunStart/Control` 与 `handleDeviceQueryRequest` 接受用户连接
  （无 deviceId 时取 `{kind:"user", socketId: client.id}`）；同账号校验不变。
- 回流路由按 kind：device → `device:<id>` room（重连稳定）；user →
  `this.server.sockets.sockets.get(socketId)` 精确回流（socket 断开 =
  发起方消失 → 路由清理时对 user 发起的 stream 直接终止，浏览器刷新后重新
  发起，与 streamId 生命周期一致）。
- `DeviceQueryForwarded`/`AgentRunStartForwarded` 的 `requesterDeviceId`
  字段保留兼容（user 发起时填 `"user:<socketId>"` 形态或新增并存字段——
  实施时以 B 端零改动为约束选择：B 端只把它原样回填，形态不影响 B）。
- 断连清理：现有 device 断连清路由的逻辑扩展到 user socket 断连。
- 安全不变量逐条保留：帧回流校验发送方=登记 targetDeviceId；控制帧校验
  发送方=登记 requester（kind+id 全等）；越权静默拒。

### 2.2 SessionTransport 抽包（packages/web-common/src/session/）

- **`SessionTransport` 接口**（纯 TS）：listSessions / history / startRun
  （create/append）/ subscribe（run 事件流）/ confirm / answer / interrupt /
  patchSessionModel / readArtifact / uploadArtifactToDrive / capability
  标记（hasLocalRun 等，web-main=false）。
- **`use-session-stream` 整体迁入** web-common：jotai atoms（sessions/usage
  atomFamily/todo 派生）留 app 层，hook 通过参数注入回调（onSessionsChange/
  onUsage/...）；本地 run 分支保留由 transport capability 门控。
- **15 个会话组件全部迁入**：模式沿用一期 IM 抽包（props + labels 注入，
  禁 jotai/next-intl/app 路径/apiClient）；web-agent 逐组件原位替换薄容器。
- **web-agent 适配器**：包现有本机链路（REST + session WS + 现 remote
  分支）。**web-agent 会话全功能零回归是一票否决项**（流式/思考/工具/HITL/
  todo/用量/产物/重生成/反馈/本地+远程双形态）。

### 2.3 web-main 装配

- web-main transport（remote-only）：ws/im 用户 socket 单例复用（一期
  im-socket）——deviceQuery（sessions/history/patch-model/artifact）+
  agentRunStart/Frame/End/Control 全走它；`AgentRunFrame` 解包为 hook
  消费的事件流（帧内即 B 端 session 事件，语义同源）。
- `/assistant/[deviceId]` 填真会话：二级子栏=该设备会话列表（新建/续聊/
  切换）；主区完整会话界面（与 web-agent 远程会话同功能：流式/思考/工具卡/
  HITL 确认与提问/todo 面板/用量/模型切换/产物预览）。
- 产物预览：web-main 的 ArtifactBody remote 数据源走 transport（泛化
  deviceQuery），大文件网盘路径复用现有 presigned 预览。
- 设备离线：发起时报 offline 明确提示（协议现成语义）。

## 3. 边界

- 不做：web-main 本地 run、随手问 dock、跨会话搜索、会话分享。
- 不改：B 端 server-agent、L3 安全模型、AgentRunFrame 帧格式。

## 4. 测试与验收

- 协议：gateway 单测（user 发起 start/control/query、回流按 socketId、
  越权拒、断连清理）+ server-main e2e（真 WS 双角色：user socket 发起 ↔
  伪设备 socket 回流）。
- transport/hook：纯逻辑单测（帧解包/事件分发/HITL 状态机）。
- **web-agent 全量回归一票否决**：现有测试 + 眼验会话全功能双形态。
- 眼验主路径：web-main 对在线设备发起新会话 → 流式+思考+工具卡 → HITL
  确认/提问 → 中断 → 续聊历史 → 切模型 → 产物预览（含大文件网盘路径）→
  设备离线报错；web-agent 本地+远程会话全功能无回归。

## 5. 风险

- use-session-stream 迁移是最大手术（1095 行,本地/远程/atoms 交织）——
  策略：先 transport 接口与 web-agent 适配器就位，hook 原位 transport 化
  并保持 web-agent 全绿，再迁 web-common；组件逐个原位替换（一期已验证
  的节奏）。
- user socket 回流的多标签页语义：每个标签独立发起独立 stream（socket.id
  隔离），无共享——符合预期但需在 e2e 钉住。
