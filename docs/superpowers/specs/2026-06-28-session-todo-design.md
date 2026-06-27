# 会话级 todo（agent 任务规划/跟踪）设计

> 状态：已通过 brainstorm，待评审 → writing-plans
> 日期：2026-06-28
> 关联：[[2026-06-27-im-send-message-hitl-design]]（tool-call 卡片渲染范式）、[[2026-06-27-agent-ui-context-awareness-design]]（tool-call-block 特判范式）

## 1. 目标

给会话引入一个 `todo_write` 工具，让 agent 在一次推理（一个 run，可能多轮 tool 调用）里对**稍长的任务**先规划拆解、再逐项推进、实时更新状态——并在前端展示进度。类似 Claude Code 的 TodoWrite。

## 2. 持久层（方案 A：message 历史）

todos **就是 `todo_write` 工具调用的参数**，活在 LangGraph checkpointer 的消息历史里：
- 覆盖式整表写（每次传完整 todos 列表，非增量）。
- 跨轮自动持久（在 checkpointer message 历史里），agent 通过历史天然「记得」当前清单。
- **零 state schema / DB 改动**——不碰 GraphState（当前只有 `messages` 单通道）、不加 entity/migration。

（否决：B = 给 GraphState 加 todos 通道，要改 state schema + 工具写 state 机制 + agent 读 state 回注，重；C = 单独 DB 表，最重。）

## 3. 工具 `todo_write`（libs/agent builtin）

- 参数 schema（`libs/types-agent`）：
  ```
  todos: Array<{
    content: string;        // 任务描述（命令式，如「修复登录 bug」）
    status: "pending" | "in_progress" | "completed";
    activeForm: string;     // 进行中时显示的现在时标签（如「正在修复登录 bug」）
  }>
  ```
  `todos` 非空数组；三字段均必填非空（activeForm 与 content 配对）。
- `execute`：纯函数，无副作用（状态就在 args/历史）。返回一个确认字符串 + 当前 todos 紧凑摘要（回灌给 agent 上下文，便于它接着推进）。
- `description`：引导 agent——对稍长/多步任务先规划拆解为 todos；开始某项时把它标 `in_progress`、完成即标 `completed`；**建议同一时刻只一个 `in_progress`**（软约束，工具不硬校验）；琐碎单步任务不必用。
- 守 libs/agent 框架无关边界：纯 `@Tool()`，无端口、无 I/O。注册进 `AgentModule` providers（纯加工具，无 DI 结构变更）。

## 4. 前端渲染（web-agent，两者结合）

### 4.1 消息流 todo 卡（看演进）
`tool-call-block.tsx` 特判 `tool.name === "todo_write" && tool.status !== "streaming"` → 渲染该次 todo 列表（仿现有 `im_send_message` 特判范式）：每项一行，状态图标（`pending` ○ / `in_progress` ◐ / `completed` ● 或对应 lucide 图标）+ 文案（`in_progress` 显示 `activeForm`，其余显示 `content`，completed 加删除线/弱化）。多次 `todo_write` = 多个卡，呈现任务演进。

### 4.2 会话常驻面板（看当前）
- 新组件 `TodoPanel`，渲染在会话视图消息列表上方（`message-list.tsx` 顶部或 `AssistantConversationBody`）。
- 数据**从 `stream.messages` 派生**：纯函数 `selectLatestTodos(messages)` 遍历 TimelineMessage 的 `toolCalls`，取**最新一次** `name === "todo_write"` 的 `args.todos`。实时流式更新（messages 变 → 派生重算）+ 重载历史都自动重建，**无需单独维护 atom**。
- 空清单（无任何 todo_write）→ 面板不渲染。
- 展示：紧凑列表 + 进度（如「2/5 完成」），状态图标 + 文案同 4.1。

## 5. 数据流

```
agent 调 todo_write(todos) → 流式 tool_call_start/args/end
  → 前端 ① tool-call-block 渲染消息流 todo 卡
        ② TodoPanel 从 stream.messages 派生最新 todos 重渲
重载会话：history 进 stream.messages → 同一 selectLatestTodos 派生 → 面板重建
```

## 6. 边界 / 不变量

- **会话级**：每会话各自独立 todos（在各自消息历史）。
- **单向**：只渲染、无用户交互回传（与功能 2「问题选项」的 HITL 不同）。
- todos 在 message 历史，受上下文压缩影响：旧的 todo_write tool-call 可能被压缩归纳——可接受（最新一次仍在近窗内，面板取最新）。
- 工具结果（确认字符串）走既有 `capForLlm` 截断（todos 摘要很小，无影响）。
- 不硬校验「一个 in_progress」。

## 7. 测试

- **types-agent**：`todoWriteSchema` 单测（非空数组、三字段必填、status 枚举、空 content/activeForm 报错）。jest。
- **libs/agent**：`todo_write` 工具 vitest（参数透传 + execute 返回含 todos 摘要；mock ToolContext）。
- **前端纯函数**：`selectLatestTodos(messages)` jest 单测（多次 todo_write 取最新、无 todo_write 返回空、status 派生）；状态图标/文案映射单测。
- 面板/卡片组件渲染靠 typecheck（.tsx 不在 jest testMatch）。
- 无 boot 必要（纯加工具，无 DI/provider 结构变更）；常规 typecheck/jest/vitest/围栏。

## 8. 涉及文件（预估）

- libs/types-agent：`todo.ts`（`todoWriteSchema` + 类型）+ index 导出。
- libs/agent：`tools/builtins/todo-write.tool.ts` + agent.module 注册 + tools 单测。
- web-agent：`lib/todo.ts`（`selectLatestTodos` + 状态映射纯函数）+ `components/session/todo-panel.tsx`（常驻面板）+ `tool-call-block.tsx` 特判（消息流卡，可内联或抽 `todo-card.tsx`）+ `message-list.tsx` 顶部挂 TodoPanel + 纯函数 jest 单测。
