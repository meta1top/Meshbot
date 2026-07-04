# 设备 Agent 反向通道(子项目 B)设计

日期:2026-07-04
状态:已与用户确认

## 背景与在总蓝图中的位置

「云协同 A/B/C/D」路线图第二块。A(已合并 main,PR #12)交付了设备注册(device 表 + device token)、agent→cloud 每账号 socket.io 长连、程序化跑 Agent 的现成范式(`RunnerService.kickAndWait` / dispatch_subagent / schedule-executor)、多副本 room 广播(RedisIoAdapter)。

B 要打通**反方向**:让一台已注册设备的本地 Agent 成为**云端可寻址、可对话的实体**,云端(经人在 web-main IM 私聊)能把消息送到指定设备的 Agent,触发一次本地 run,回复异步回流。这是 C(Agent 进频道/群)与 D(工作流节点向 Agent 派任务)的传输与身份地基。

| # | 子项目 | 依赖 |
|---|--------|------|
| A(已完成) | 登录形态 + 配置云端化 | — |
| **B(本 spec)** | 设备 Agent 反向通道 + Agent 作 IM 身份(私聊) | A |
| C | Agent 进频道/群(多方会话) | B |
| D | 人机协同流程平台 | B、C |

## 现状(2026-07 盘点,B 相关)

- **四块基建已就位**:device 表 + token 全链路(A);`ImRelayClientService`(server-agent,每账号一条 ws/im 长连,握手带 device token,已把 deviceId 放进 server-main 侧 `client.data`);`RunnerService.kickAndWait` + `SessionService.createSession/appendMessage`(程序化跑 run);`RedisIoAdapter`(room 广播跨副本)。
- **三样全缺**(B 新建):云端按 deviceId **定向反向下发**;**设备级 presence**(现有 presence 是"用户有没有浏览器在看",非"设备 Agent 在不在线");下行消息 **→ 触发本地 run 的钩子**。
- **历史包袱**:IM 伴生 Agent 自动代答(2026-06-28 删除)。B 与之划清界限:Agent 是**独立参与者身份,用户有意去私聊它**(会话对端就是 Agent),不是在人际会话里自动插话。
- 云端 IM 后端(`Conversation`/`ConversationMember`/`Message`/`PresenceService`/`ImGateway`)完整;web-main **无 IM 前端**(IM UI 目前只在 web-agent)。

## 目标

1. 每台已注册设备的 Agent 成为可寻址 IM 身份(每设备一个,`deviceId` 即参与者 id)。
2. 人在 web-main IM 私聊设备 Agent:发消息 → 触发该设备本地 Agent 一次 run → 回复异步回流显示。
3. 云端能按 deviceId 定向下发到目标设备的 relay 连接(跨副本);设备级在线态可见。
4. 离线设备的消息排队,Agent 上线后按序补处理。

## 非目标(YAGNI / 划给 C、D)

- 不做 Agent 进频道/群、多方会话(C)。
- 不做同步 RPC 调用面(采用异步消息式)。
- 不做 per-user Agent 路由 / 主设备选择(每设备一个 Agent,直接寻址)。
- 不做组织内他人访问你的 Agent(B 限本人私聊;跨成员暴露归 C)。
- 不做流式中间态回流(MVP 只回最终 assistant 消息;流式后续)。
- 不新建 Agent 实体表(Agent 就是 device)。

## 关键决策(已确认)

1. 调用语义:**异步消息式**(非同步 RPC)。
2. 调用面:**私聊 Agent**——Agent 作可 DM 的 IM 参与者身份。
3. Agent 身份粒度:**每设备一个**,`deviceId` 即参与者 id,Agent 名 = `device.name`,注册即可用(无额外注册步骤)。
4. 演示面:**web-main 新建 IM**(复用已有云端 IM 后端)。
5. 离线:**排队,上线后补处理**(处理游标存 server-agent 本地 `im_agent_session.last_processed_message_id`)。
6. 反向通道机制:**方案 1——扩展现有 ws/im relay**(device room + 定向下发事件),不另起 WS,不轮询。

## 一、数据模型

### 1.1 Agent 身份 = device

不新建 Agent 表。每设备一个 Agent,`deviceId` 直接作参与者 id(1:1),Agent 名取 `device.name`,`platform` 作副标题;`revokedAt` 的设备即无 Agent。

### 1.2 云端 IM 表加性扩展(Postgres,追加式 SQL DDL,DBA 执行)

- `conversation` 加列 `agent_device_id varchar(20)`(nullable)。有值 = 这是"人 ↔ 设备 Agent"的 DM 会话,值为目标设备 id。人类成员仍走 `conversation_member(user_id)`;Agent 一侧不占 member 行,靠会话上的 `agent_device_id` 表达。归属 `ConversationService`。
- `message` 加列 `sender_type varchar(8) NOT NULL DEFAULT 'user'`('user' | 'agent')。人发:`sender_id=userId, sender_type='user'`;Agent 回:`sender_id=deviceId, sender_type='agent'`。前端/网关据此区分渲染与路由。存量行默认 'user'。
- 幂等 SQL(`ADD COLUMN IF NOT EXISTS`)、snake_case、逻辑外键、文件不可变。

### 1.3 server-agent 本地映射(SQLite,TypeORM 迁移)

新增表 `im_agent_session`:`conversation_id`(云端会话 id)、`session_id`(本地 Agent 会话 id)、`cloud_user_id`(账号作用域列)、`last_processed_message_id`(处理游标,nullable)、`created_at`。每个 Agent-DM 会话钉一条持久本地 Agent 会话,保证多轮上下文连续;`last_processed_message_id` 是该会话的**处理游标**(见 §2.5,不用云端已读态——Agent 不占 member 行、云端无处挂它的游标)。归属新 Service `AgentInboxService`(或拆 `ImAgentSessionService` 持有该表,`AgentInboxService` 编排——实施时按 check:repo 单一归属定)。

本地 session 有完整细节(工具调用/推理);回流到 IM 会话的只是面向人的最终回复(与 dispatch_subagent 的"子会话细节 vs 父可见结果"同构)。

## 二、反向通道(方案 1:扩展 ws/im relay)

一条人发给设备 Agent 的 DM 端到端:

1. **人发消息**(web-main)→ 现有 IM send 路径 → server-main `MessageService` 存 `Message(sender_id=userId, sender_type='user')` 到该 Agent-DM 会话。
2. **云端定向下发**:`MessageService`/`ConversationService` 发现会话 `agent_device_id` 有值 → 向 room `device:<deviceId>` emit 新事件 `agent.inbound`(payload:`{conversationId, messageId, content, senderUserId}`)。
   - **device room 加入**:`ImGateway.onAuthedConnect` 里,device token 连接(`client.data.deviceId` 存在)→ `client.join('device:'+deviceId)`。
   - **跨副本**:A 已就绪的 Redis adapter 把 room emit 路由到持有该 socket 的副本。
   - **设备离线**(room 无 socket):不做额外动作——消息已在 Message 表,靠第 5 步补。
3. **本地触发 run**:server-agent im-relay-client 收到 `agent.inbound` → 交 `AgentInboxService`:按 `im_agent_session` 找/建映射会话 → `sessions.appendMessage(sessionId, {content})` → `runner.kickAndWait(sessionId)` → 取最终 assistant 消息。全程包在 `account.run(cloudUserId, …)` 账号上下文。
4. **回流**:用现有 relay `send` 把回复发回该 conversationId。server-main 因这条连接是 device token 认证、已知 deviceId,给它盖 `sender_type='agent', sender_id=deviceId` 存库 + 广播到会话 room → web-main 显示 Agent 回复。(现有 relay `send` 需扩展:device token 连接发的消息盖 agent 身份;浏览器/JWT 连接发的仍是 user 身份。)
5. **离线补处理(本地处理游标)**:游标存在 server-agent 本地 `im_agent_session.last_processed_message_id`(非云端已读态——Agent 不占 member 行)。relay(重)连时:
   - server-agent 向 server-main 查"本设备的全部 Agent-DM 会话"(server-main 按 `agent_device_id = 本设备` 枚举,新增一个 REST/relay 查询)——**这一步覆盖"离线期间首次收到消息、本地还没有 `im_agent_session` 行"的会话**;
   - 对每个会话,拉取 `last_processed_message_id` 之后的消息(经现有 IM 分页 REST),逐条处理并推进游标(本地无游标即从头)。
   实时 `agent.inbound` 是优化,重连补处理兜空档。

**并发与去重**:两条路(实时 push、重连补处理)都汇到"本地游标之后的消息、处理后推进游标";server-agent 侧**每会话一把 in-flight 锁**串行化,避免双处理同一条。游标推进以"已处理"为准。

## 三、run 触发、回流与错误

- **触发粒度**:Agent-DM 是 1:1 会话,对端只有 Agent,故**每条人发消息都触发一次 run**(无需 @mention 门控——那是 C 的频道语义)。
- **会话连续性**:每个 Agent-DM 会话 ↔ 一条持久本地 session,消息 append 到同一 session,run 延续线程。
- **回流粒度**:MVP 回**最终 assistant 消息**(run 完成后 relay send 回会话)。流式中间态后续。
- **错误处理**:run 失败 → 往会话回一条 `sender_type='agent'` 错误消息("Agent 处理失败:…"),人不干等;游标照常推进(失败也算处理过,避免死循环重试同一条),失败详情进本地日志。

## 四、设备 Agent presence

- Agent 在线 = 它的 relay socket 连着 ws/im。`ImGateway`:device token 连接 connect → 标记该 deviceId 在线;disconnect → 离线;复用 relay 已有 ~20s `im.ping` 当心跳 + TTL。
- 实现:新增**设备级 presence**,与现有 `PresenceService`(Redis sorted-set `presence:<orgId>` 键 userId)同构,但键到 deviceId(如 `agent_presence:<orgId>` member=deviceId)。Redis 不可用退化进程内 Map(同现有)。
- 呈现:web-main IM 侧栏每个 Agent 一个在线点;A 的设备管理页 `/settings/devices` 顺带显示在线状态。给离线 Agent 发消息 UI 标"离线,上线后处理"。

## 五、web-main IM 前端

复用 A 的 web-main 基建(apiClient / auth / providers / AuthGuard)+ 已有云端 IM 后端(REST + ws/im):

- **IM 侧栏**:列出你与各设备 Agent 的 DM 会话(带在线点)。
- **会话视图**:消息列表(按 `sender_type` 区分人/Agent 渲染)+ 输入框。用 socket.io-client 连 ws/im(浏览器 JWT),订阅会话事件实时刷新。
- **新建 DM**:从你名下设备 Agent 列表(在线态)挑一个 → 建/开一个 `agent_device_id` 会话(server-main 新增或复用 dm 创建端点,带 agentDeviceId)。
- **范围**:只做 Agent DM(频道/群是 C);遵循 A 的前端约定(next-intl 禁裸串、`@meshbot/design`、Form/useSchema、Suspense 包 useSearchParams)。

## 六、迁移与向后兼容

- server-main DDL:`conversation.agent_device_id` + `message.sender_type`(存量默认 'user'),幂等,DBA 执行。
- server-agent SQLite:`im_agent_session` 迁移。
- 存量人际 DM 不受影响(`agent_device_id` null、`sender_type` 'user')。

## 七、测试策略

- **server-main e2e**(本地 Postgres):建 Agent-DM 会话 → 发消息 → 断言 `agent.inbound` 定向到 `device:<id>` room;device token 连接 send 回复 → 断言落库 `sender_type='agent' sender_id=deviceId`;离线补处理拉未读(游标之后)。
- **server-agent 单测**:`AgentInboxService`——inbound → 会话映射(找/建)→ kickAndWait → 回流;in-flight 锁串行化(同会话并发 inbound 只跑一次序列);游标在成功与失败都推进;账号作用域(`im_agent_session` 带 cloud_user_id,ScopedRepository)。
- **presence**:设备连接/断开 → 在线/离线;心跳 TTL。
- **web-main IM**:Playwright/curl 冒烟(建 DM → 发消息 → curl 模拟设备 relay 收 inbound + send 回复 → 前端显示 Agent 回复)。
- TDD 优先;DI/迁移/围栏脚本有测试;server-agent 改 provider 需真 boot 验证;`pnpm check` 全绿。

## 八、开放实施细节(留给 writing-plans / 实施)

- `agent.inbound` 事件与相关 payload schema 放 `libs/types`(跨域,server-main 与 server-agent relay 共享),照 `im/im.events.ts` 组织(namespace 常量 + 事件表 + payload 接口)。
- relay `send` 盖 agent 身份:在 `ImGateway` 的 send handler 里,若连接是 device token(`client.data.deviceId`)则 `sender_type='agent' sender_id=deviceId`,否则 user 身份——单点分支,勿散落。
- `AgentInboxService` 单一归属 `im_agent_session`;若与既有 im 模块交叉,按 check:repo 定归属。
