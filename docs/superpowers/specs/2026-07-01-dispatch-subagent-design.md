# 派子 Agent（dispatch-subagent）设计

**日期：** 2026-07-01
**状态：** 已定稿（全貌）；实施分两期，先 Phase 1。

## 1. 背景与目标

meshbot 的 Agent 是「supervisor(LLM 决策) + tools(执行)」两节点 LangGraph 图，工具丰富但**没有委派/子 Agent 能力**。目标：给主 Agent 一个 LLM 可调用的 **`dispatch_subagent` 工具**，把子任务委派给一个**上下文隔离的全新子 Agent**——子 Agent 用自己的图/checkpointer 线程跑、完整落库、可回溯，过程实时流式到前端嵌套卡；支持并行 fan-out 与前台/后台两种模式；仅一层嵌套。

## 2. 已确认决策

1. **形态**：LLM 可调用的 dispatch 工具（非用户自建 Agent、非角色注册表）。
2. **子 Agent 配置**：通用型——与主 Agent 相同的完整工具集，只是全新隔离上下文 + 一段任务指令；额外**可选 `model`**。
3. **并发**：并行 fan-out——同一轮可派多个子 Agent 并发。
4. **可见性**：实时嵌套过程——子 Agent 内部步骤实时流式到前端可展开的嵌套卡。
5. **持久化**：子线程完整落库——子 Agent 是一等持久化子会话，有自己的 checkpointer 线程，可回溯/可 resume。
6. **递归**：仅一层——子 Agent 不带 dispatch 工具，不能再派。
7. **两种模式（照抄 Claude Code）**：
   - **前台（默认，阻塞）**：工具阻塞至子 Agent 完成，返回结果，主 Agent 同一 run 续跑。
   - **后台（`background:true`）**：立即返回句柄，主会话回 idle、用户可继续对话；子 Agent 后台跑，**完成时自动播报**——把结果注入父会话并触发主 Agent 新 run 汇报/整合。

## 3. 方案选型：子 Agent = 一等持久化子会话，前端嵌套卡递归复用

子 Agent 就是一个真正的 `Session`（带 `parentSessionId`/`parentToolCallId` 关联），有自己的 thread_id、自己的 `SessionMessage`。它跑起来发**正常的 ws/session 事件（键为子会话 id）**；前端把 `dispatch_subagent` 工具卡特判成嵌套卡，**复用 `useSessionStream`（参数化 sessionId=子会话）**渲染其实时消息流。

对比「把子事件重打标签塞回父房间」方案：本方案与「完整落库 + 实时嵌套 + 可 resume」天然契合，几乎零改事件信封，最大化复用现有 runner/流式/持久化机器，刷新按子会话历史即可还原。

## 4. 组件与数据流

### 4.1 数据模型（server-agent，SQLite + TypeORM 迁移）

**不新增 Entity**——子 Agent 就是一个 `Session`：
- `Session` 增两列 `parentSessionId?: string|null`、`parentToolCallId?: string|null`；`kind` 枚举加 `"subagent"`。
- thread_id = 子会话 id；`SessionMessage` 照常按 `cloudUserId + sessionId` 落。
- 普通会话列表按 `parentSessionId IS NULL` 过滤（子会话只在父的嵌套卡里出现）。
- v1 不做自动 GC（完整保留、可回溯）。
- 迁移：TypeORM 迁移文件加两列（SQLite，启动自动跑；`kind` 是应用层枚举，无需 DB 约束变更）。

### 4.2 dispatch 工具 + port（types-agent + libs/agent）

- **schema**（types-agent）：`dispatchSubagentSchema = { task: string, description?: string, model?: string, background?: boolean }`。
  - `task`：子任务完整指令（子 Agent 的初始 user 消息）。
  - `description`：短标题，用于嵌套卡显示。
  - `model`：可选，`ModelConfig` id/名；缺省继承父 run 当前模型。
  - `background`：默认 `false`（前台阻塞）。
- **port**（`libs/agent/src/tools/dispatch-subagent.port.ts`）：
  - `DISPATCH_SUBAGENT_PORT = Symbol("DISPATCH_SUBAGENT_PORT")`
  - `DispatchSubagentPort.dispatch(params, signal): Promise<string>`，`params = { parentSessionId, parentToolCallId, task, description?, model?, background? }`，返回 JSON：
    - 前台：`{ subSessionId, status:"done"|"error"|"aborted", output }`
    - 后台：`{ subSessionId, status:"running" }`（立即返回）
- **tool**（`libs/agent/src/tools/builtins/dispatch-subagent.tool.ts`）：`@Tool` 薄壳，`@Inject(DISPATCH_SUBAGENT_PORT)`，`execute` 从 `ToolContext` 取 `sessionId→parentSessionId`、`toolCallId→parentToolCallId`、`signal` 透传（与 im_send/ask_question 同款）。
- **仅一层**：子 Agent 的图用**去掉 dispatch 工具的 registry** 构建，天然不能再派。

### 4.3 tools 节点并发（真并行 fan-out 的前提）

同一轮多个 `dispatch` tool_call 要真正并发，需 tools 节点**并发执行同轮 tool_calls**（`Promise.all` + 各自 try/catch，保持每个 `tool_call → ToolMessage` 配对与顺序）。这是对 `tools.node` 的扩展；对其它工具安全（同轮工具调用本相互独立，HITL 工具各自等自己的确认）。**实施前须先核实现有 tools 节点是串行还是已并发**，据此改。

### 4.4 DispatchSubagentService（server-agent，绑定 port）

`@Global DispatchSubagentModule` 绑 `{ provide: DISPATCH_SUBAGENT_PORT, useExisting: DispatchSubagentService }`。`dispatch()`：

1. `cloudUserId = account.getOrThrow()`（同账号，ALS 从父 run 传入）。
2. 取并发槽（账号级信号量，上限 `SUBAGENT_MAX_CONCURRENCY`；前台 fan-out + 后台任务合计计数）。
3. 建子会话（`Session`：`kind:"subagent"` + `parentSessionId`/`parentToolCallId`，标题取 `description ?? truncate(task)`）。
4. 把 `task` 作为子会话首条 user 消息入队。
5. 解析模型（有 `model` 按 id/名经 `ModelConfigService` 取，否则继承父 run 当前模型）。
6. 在**父会话**上补发一条 `{ toolCallId, subSessionId, description }` 关联事件（唯一的小信封新增），让前端把嵌套卡认领到子会话。
7. 分模式：
   - **前台**：`runToCompletion(subSessionId, { model, 用子图 })` 阻塞 → 读末条 assistant 作为 `output` → 返回 `{subSessionId, status:"done", output}`（经 `capForLlm` 截断喂回父 LLM）。`signal`（父 run stop）中断则返回 `status:"aborted"`。
   - **后台**：立即返回 `{subSessionId, status:"running"}`；子 run **fire-and-forget** 起（独立 `AbortController`，不随父 `signal` abort）；完成时执行「完成回灌」（见 4.5）。
8. `finally` 释放并发槽。

**需要的后端扩展（复用为主）：**
- `AccountGraphProvider` 增一个缓存的**子 Agent 图**（registry 去 dispatch；与主图共用同一 checkpointer，thread_id 隔离）。
- `RunnerService` 增 **每-run 模型覆盖** + 一条 `runToCompletion(sessionId, opts)` 路径（复用 `consumeRunStream` 的流式 + 落库内核，结束返回末条 assistant 文本）。当前 runner 面向主会话 pending 队列 + `kick`；子会话是不同 sessionId，anti-reentrancy 天然隔离。

### 4.5 后台完成回灌（A 自动播报）

子 run 结束（后台）→ 往**父会话**注入一条「子 Agent〈description〉完成 + output」通知消息（合成的 user/system 消息）+ `kick(parentSessionId)` 触发主 Agent 新 run，主 Agent 据此向用户汇报/整合。复用 `PendingMessage` 队列 + `kick`（天然串行，和用户当前对话不打架；多个后台完成各自入队、`kickAndWait` 批处理）。

### 4.6 流式与前端（嵌套卡）

- 子会话照常发正常 ws/session 事件（键为子会话 id），零改现有事件结构。
- 前端 `tool-call-block` 特判 `dispatch_subagent`：嵌套卡内**复用 `useSessionStream`（参数化 sessionId=子会话）**渲染子 Agent 实时消息流；折叠默认收起、可展开；并发多个 → 多张并列嵌套卡。
- **刷新安全**：嵌套卡重挂按 subSessionId 重订阅房间 + 拉子会话历史（已落库），live 或历史都能还原。
- 主会话列表按 `parentSessionId IS NULL` 过滤，子会话不单独出现在侧栏。

### 4.7 中断语义

- **前台**子 Agent：随父 run stop 一起 abort（`ctx.signal` 传播）。
- **后台**子 Agent：**独立生命周期**，父 run stop **不杀它**；取消走嵌套卡上的「停止」按钮 → abort 该子 run。父 run 结束后嵌套卡仍持续实时流式。

## 5. 关键契约

| 契约 | 值/形态 |
|------|--------|
| 工具名 | `dispatch_subagent` |
| schema | `{ task, description?, model?, background? }` |
| port token | `DISPATCH_SUBAGENT_PORT`（libs/agent 定义，server-agent `@Global` 绑定） |
| 前台返回 | JSON `{ subSessionId, status:"done"\|"error"\|"aborted", output }` |
| 后台返回 | JSON `{ subSessionId, status:"running" }` |
| 子会话 | `Session{ kind:"subagent", parentSessionId, parentToolCallId }`，thread_id=子会话 id |
| 关联事件 | 父会话上 `{ toolCallId, subSessionId, description }` |
| 后台完成 | 往父会话注入通知消息 + `kick(parentSessionId)` |
| 并发上限 | 常量 `SUBAGENT_MAX_CONCURRENCY`（账号级信号量） |
| 步数上限 | 继承 `MESHBOT_GRAPH_RECURSION_LIMIT` |

## 6. 错误处理与边界

- **子 run 失败**：`status:"error"`，output 带错误摘要；前台回给父 LLM，后台经完成回灌播报。
- **并发超限**：取不到槽时排队或直接返回「繁忙」错误（v1：排队等槽，受 `signal`/超时约束）。
- **父 run 中断（前台）**：`sanitizeOrphanToolCalls` 会在 resume 时清掉无 ToolMessage 的 dispatch 调用 → 前台 dispatch 天然「中断即重试整个 dispatch」，与现有 resume 模型一致。
- **后台 orphan**：后台子 run 与父 run 解耦，父会话 resume 不影响后台任务；后台任务自身完成/失败/被取消三态终结。
- **SQLite 并发写**：并行子 Agent 同账号 db 并发写，靠 WAL + `busy_timeout` 缓解；并发上限进一步兜底。
- **capForLlm**：output 喂回父 LLM 前按 `TOOL_RESULT_LLM_LIMIT` 截断（history 全量仍在子会话）。

## 7. 测试

- **libs/agent vitest**：dispatch tool 薄壳透传（port 被调用、参数正确）；子图 registry 不含 dispatch。
- **server-agent jest**：`DispatchSubagentService`（建子会话 / 前台 `runToCompletion` 返回 output / 后台立即返回+完成注入+`kick` / 信号量并发上限 / abort 前台随父·后台独立）；`Session` parent 关联 + 迁移；`runToCompletion` 模型覆盖。
- **web-agent**：嵌套卡递归 `useSessionStream`、按 subSessionId 订阅+历史还原、后台完成播报落主流。

## 8. 分期

功能大，拆两期，各自出 plan：

- **Phase 1（先做）：后端 + 前台阻塞**
  数据模型迁移 + port/tool（schema 含 `background` 但先只实现前台分支）+ 子图 + `runToCompletion` + 每-run 模型覆盖 + tools 节点并发 fan-out + 前台 dispatch 返回结果 + 父→子关联事件 + 嵌套卡最小实时视图。**验收**：端到端跑通「派（可并行）子 Agent → 拿结果续跑」，子会话落库可回溯。
- **Phase 2：后台 + 富前端**
  `background` 后台运行 + 完成自动播报回灌 + 嵌套卡富交互（展开/停止/刷新还原）+ 独立 abort + 并发/繁忙处理完善。

## 9. 非目标 / 未来

- 子会话作为可交互活会话「点进去继续追问」——v1 是一次性任务运行，不可再对话（未来可扩展）。
- 角色注册表 / 工具子集限定 / 自定义 system prompt——本期只做「通用 + 可选模型」。
- 子会话自动 GC / 保留策略——v1 全保留。
- 多层递归——仅一层。

## 10. 实施风险 / plan 待核实

- `tools.node` 现为串行还是并发执行同轮 tool_calls（决定 fan-out 是否真并发，见 4.3）。
- `RunnerService` 现有入口与 `runToCompletion` 的贴合度、每-run 模型覆盖如何最小侵入接入 `modelProvider` 工厂。
- `AccountGraphProvider` 增子图缓存对现有 per-account 缓存/生命周期的影响（需 boot 验证 DI）。
- 后台完成回灌注入的消息 role/形态（合成 user vs 特殊 system），确保主 Agent 能正确消化且不破坏 checkpointer 消息序不变量。
