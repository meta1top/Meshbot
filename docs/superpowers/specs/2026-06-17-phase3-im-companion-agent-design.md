# Phase 3 设计：IM 伴生 Agent（每会话一个本地 agent，感知消息 → 执行 → 候选回复）

> 状态：已与产品对齐，待实施
> 日期：2026-06-17
> 依赖：Phase 2（IM 骨架 + 频道/私信 + presence，已完成并合并）。

## 0. 背景与范围

Phase 2 已让 IM 入站消息经 `ImRelayClientService` 发到本地 EventEmitter2（`IM_WS_EVENTS.message`），但目前无 Agent 消费方（注释标为「Phase 3 钩子」）。Phase 3 接上这个钩子：**每个 IM 会话（频道 / 私信）绑定一个本地的、完整能力的伴生 Agent**。它像旁观者一样看会话的双方消息，按规则被触发后用用户的本地 Agent（账号模型 + 现有工具 / MCP）**真正执行处理**，产出一个**候选回复 / 结果**呈现在该会话的**侧栏**；**绝不自动发出**。用户满意就一键发进 IM，不满意就在侧栏继续和 Agent 对话精修，直到满意再发。

典型：对端问「上线任务怎么样了」→ Agent 调（未来 Phase 4 的）任务面板 MCP 查状态、生成回复草稿；领导要「周五前给报告」→ Agent 整理报告 / 提议建一个待办提醒。一切围绕「让用户省事」。

### 做（Phase 3 = 轨道）
- 每会话一个**伴生 Agent 会话**（本地 server-agent，复用现有 Session/Runner/Graph + 工具/MCP/账号模型）。
- **摄入**会话双方消息为上下文（旁观者视角）。
- 按规则**触发**伴生 Agent 运行（私信对端消息 / 频道 @ 自己），受**每会话开关**控制（默认开）。
- 运行结果作为**候选回复**进侧栏；用户可继续对话精修；**一键「发送」**把选定回复发进 IM。
- 伴生会话从主会话列表**隐藏**，只能从 IM 会话侧栏打开。

### 不做（Phase 4+ / YAGNI）
- **任务面板 MCP**（查任务状态 / 建任务）—— Phase 4。Phase 3 的 Agent **当前有什么工具就用什么**（date / bash / skills / schedule 定时 / `mcp.json` 的 MCP）。
- PDF 等专用产物工具——按需另做。
- Agent **自动**发消息进 IM（永远需用户点发送）。
- 结构化 @mention（先用文本启发式，见 §7）。
- 频道里"群体协作 / 多人 @"高级路由；多模型并发。

## 1. 关键决策（来自需求澄清）

| 决策 | 选择 |
|------|------|
| 伴生引擎 | **完整 Agent**（GraphService/Runner + 工具/MCP/账号模型），非轻量拟句 |
| 输出去向 | **候选回复进侧栏**，用户审阅；**绝不自动发** IM |
| 精修方式 | 侧栏里**继续和 Agent 对话**（普通 agent 多轮），满意后**一键发送** |
| 摄入范围 | 会话**双方**消息都摄入为上下文（含用户自己发的） |
| 触发：私信 | 对端发新消息（`senderId≠自己`）→ 运行；自己发的只更上下文 |
| 触发：频道 | 仅当消息 **@当前用户** → 运行；否则只更上下文 |
| 开关 | **每会话** `agent_enabled`，**默认开**；关则只摄入不运行 |
| 可见性 | 伴生会话不进主会话列表，只从 IM 侧栏访问 |
| 存储位置 | 伴生会话 + 开关都在**本地** server-agent（每账号隔离，复用 ScopedRepository） |

## 2. 架构与数据流

```
云端 server-main ──im.message──▶ server-agent ImRelayClientService
                                      │ EventEmitter2: IM_WS_EVENTS.message
                                      ▼
                               ImAgentService（新, @OnEvent）
                                 1. find/create 伴生 Session(conversationId, 账号)
                                 2. 记入上下文（标注 sender）
                                 3. 触发判定（私信对端 / 频道@ + 开关）
                                 4. 命中 → 以新消息为输入跑 RunnerService（完整 Agent）
                                      │ 产出 assistant 候选回复（SESSION_WS_EVENTS 流）
                                      ▼
                               浏览器 IM 会话侧栏（复用聊天组件，指向 companion sessionId）
                                 - 看候选回复 / 继续对话精修
                                 - 「发送」→ 选定文本经 im.send 发进 IM 会话
```

- **每账号独立**：relay 是每账号一条云连接，`im.message` 只到该账号的 server-agent；伴生会话归该账号。双人私信里 A、B 各自有自己的伴生 Agent。
- **发送回环**：用户点发送 → `im.send` 上行 → 云端广播 → 自己的 relay 也收到该消息（`senderId=自己`）→ 摄入为上下文、**不触发**（见触发规则），避免自激。

## 3. 数据模型（server-agent / SQLite，TypeORM 迁移）

`sessions` 表新增三列（迁移文件 `apps/server-agent/src/migrations/<ts>-AddSessionImCompanionFields.ts`）：

| 列 | 类型 | 说明 |
|----|------|------|
| `kind` | `varchar` default `'user'` | `'user'`（用户主动会话）\| `'im'`（IM 伴生会话） |
| `im_conversation_id` | `text` nullable | 伴生会话绑定的 IM conversationId；`kind='user'` 为 null |
| `agent_enabled` | `boolean` default `true` | 仅 `kind='im'` 有意义：该会话是否启用伴生 Agent |

- 每 `(cloud_user_id, im_conversation_id)` 唯一一条伴生会话（建索引 `(cloud_user_id, im_conversation_id)`）。
- `kind` 默认 `'user'` → 现有会话不受影响。
- 伴生会话的对话历史复用现有 `session_messages` / checkpointer。

## 4. 摄入与触发（server-agent 新 `ImAgentService`）

`@OnEvent(IM_WS_EVENTS.message)` 监听入站 `ImMessage = { id, conversationId, senderId, content, createdAt }`：

1. **定位账号**：`im.message` 由某账号的 relay 触发。relay 的 socket 回调里把 emit 包进 `this.account.run(cloudUserId, () => this.emitter.emit(event, payload))`（cloudUserId 来自 `connect(cloudUserId)` 闭包）。EventEmitter2 是**同步派发**，`@OnEvent` handler 在同一调用栈内执行 → AsyncLocalStorage 账号上下文透传到 handler（含其 await 续体）。`ImAgentService` 直接 `account.getOrThrow()` 拿 owner。**不改 payload**（`im.gateway` 转发浏览器的现有监听不受影响）；relay 需注入 `AccountContextService`。
2. **find/create 伴生会话**：按 `(account, conversationId)` 查；无则建 `kind='im'`、`im_conversation_id=conversationId`、`agent_enabled=true`、`title=<会话名/对端名>` 的 Session。
3. **记入上下文**：把该消息追加进伴生会话历史，标注发送者身份（如 `[对端 <name>] ...` / `[我] ...`），让 Agent 知道谁说了什么。**双方消息都记**。
4. **触发判定**（全部满足才运行）：
   - `agent_enabled === true`；
   - 私信：`senderId !== 账号自身 cloudUserId`；
   - 频道：`senderId !== 自身` 且 `content` @ 了自身（§7）；
   - 不满足 → 只记上下文，不运行。
5. **运行**：以该新消息为输入跑伴生会话的 Agent（§5）。并发去重：同一伴生会话已在跑则排队 / 合并（复用 Runner 既有的 per-session 串行机制）。

## 5. 生成引擎（复用 RunnerService / GraphService）

- 伴生会话是**真正的 agent 会话**：运行走现有 `RunnerService`（账号上下文 + `GraphService` 完整图 + 工具/MCP + 账号模型 + checkpointer 记忆）。
- **输入建模**：触发时，把"对端最新消息"作为 Agent 的输入回合；Agent 的回复回合 = **候选回复**。用户在侧栏的追问也是普通用户回合（再次跑图精修）。用户自己在 IM 发的消息以**上下文/旁观**形式进历史（不作为"要求 Agent 回复"的输入回合）。
- **系统 prompt 框定**（伴生会话专用）：说明「你在协助用户在一个 IM 会话中应对；你看到的是双方对话;产出的是给用户审阅的候选回复,不会自动发出;可调用工具完成任务（查询/整理/建提醒等）」。具体 prompt 计划阶段定，挂在伴生会话的 system prompt 上（区别于普通助手会话）。
- **输出去向**：运行产出经现有 `SESSION_WS_EVENTS` 流给浏览器**侧栏**（侧栏订阅该 companion sessionId 的流）。**不经 IM 通路**，绝不自动发。

## 6. 侧栏 UI 与发送（web-agent）

- IM 会话视图（`apps/web-agent` messages 区）增加**伴生 Agent 侧栏**：
  - 进入某会话时，按 conversationId 取/建伴生会话（新 REST：`GET /api/im/:conversationId/agent-session` → 返回 companion sessionId + agent_enabled），侧栏**复用现有聊天/消息组件**指向该 sessionId（消息流、输入框、流式渲染都复用）。
  - 展示 Agent 候选回复 / 执行过程；用户可在侧栏输入框**继续对话精修**（普通 agent 多轮）。
  - **「发送到会话」按钮**：取 Agent 最新回复文本（用户可编辑）→ 经现有 IM `im.send` 发进当前 IM 会话。发送后该消息走回环摄入为上下文。
  - **「Agent 建议」开关**：切 `agent_enabled`（新 REST：`PUT /api/im/:conversationId/agent-session { enabled }`），默认开。
- 不改动 IM 主消息流 UI;侧栏是新增的并列面板（桌面端宽屏显示;窄屏可折叠，YAGNI 先做宽屏）。

## 7. @ 检测（频道触发）

`ImMessage.content` 是纯文本，无结构化 mention。频道触发用**文本启发式**：content 是否包含 `@<当前用户 displayName>` 或 `@<email 本地部分>`（大小写不敏感、词边界）。命中即视为 @ 自身。〔局限已知；结构化 mention 留后续。〕当前用户的 displayName/email 取自本地 `cloud_identity`。

## 8. 可见性与设置

- `listSessions`（主会话列表 / 侧栏会话列表）**只返回 `kind='user'`**；伴生会话不出现在主列表。
- 伴生会话仅经 IM 会话侧栏（§6 的 REST）访问。
- `agent_enabled` 每会话本地存（伴生会话行），默认 `true`；关闭后只摄入不运行。

## 9. 测试

- **server-agent 单测（Jest）**：
  - `ImAgentService` 触发逻辑：私信对端消息触发、自己消息不触发、频道 @ 命中触发 / 未 @ 不触发、`agent_enabled=false` 不触发。
  - 伴生会话 find/create 幂等（同 conversationId 不重复建）。
  - `listSessions` 排除 `kind='im'`。
  - @ 检测启发式（命中 / 不命中 / 大小写 / 词边界）。
  - 运行本身复用已测的 Runner/Graph（用桩 model 验证"被触发跑了一次"，不重复测图）。
- **手验**：私信对端发消息 → 侧栏出现候选回复;频道 @ 自己 → 触发,未 @ 不触发;侧栏精修 → 一键发送进 IM;关开关 → 不再自动跑。

## 10. 验收

- 私信:对端发「上线任务怎么样了」→ 侧栏伴生 Agent 自动跑出候选回复(用现有工具能力);用户编辑/精修后点发送 → 对端收到。
- 频道:别人 @ 我 → 触发;无 @ 的普通消息 → 不触发(只更上下文)。
- 关掉某会话「Agent 建议」→ 该会话不再自动跑;开着的不受影响。
- 伴生会话不出现在主会话列表;每账号各自独立(双人私信两端各有自己的伴生 Agent)。
- 全量 typecheck + 静态围栏通过。
