# 派子 Agent Phase 1b（前端嵌套卡）设计

## 1. 背景与目标

Phase 1a（PR #8，已合并）给主 Agent 落地了 `dispatch_subagent` 工具：子 Agent = 一等持久化子会话（`kind:"subagent"` + `parentSessionId`/`parentToolCallId`），前台跑到完成回传结果，`run.subagent_spawned` 事件已由 gateway 转发到父会话房间（`session.gateway.ts` 的 `onSubagentSpawned`），但**前端目前零消费者**——聊天里的 dispatch 工具调用只渲染成普通工具卡。

Phase 1b 目标：把 dispatch 工具卡升级为**嵌套实时卡**——展开可见子 Agent 自己的消息流（文本/推理/工具），运行中实时滴流，刷新（含子 run 进行中刷新）可完整还原；并行 fan-out 时多卡并列。范围几乎纯前端（web-agent），外加一处小后端增强。

不改变 1a 的任何运行语义（前台阻塞、一层嵌套、并发上限均不动）。

## 2. 关键决策（已确认）

| 决策点 | 结论 |
|---|---|
| mid-run 刷新如何拿 subSessionId | **history 接口附带关联**：后端组装 history 时按 `parent_tool_call_id` 反查子会话带出 `subSessionId`（方案见 §4） |
| 嵌套内容渲染 | **`MessageList` 加 `nested` 变体**：隐藏头像行/重试/反馈/TodoPanel，保留文本、推理块、工具卡、压缩行 |
| 折叠策略 | **运行中自动展开**、结束自动收起、用户手动操作后尊重手动状态（同 `ReasoningBlock` 先例）；历史加载（已完成）默认收起 |

## 3. subSessionId 认领：三路来源

嵌套卡的核心是把父消息里某个 `toolCallId` 关联到 `subSessionId`，三路来源按优先级：

1. **live 事件**：`useSessionStream` 新增消费 `SESSION_WS_EVENTS.runSubagentSpawned`（payload `{sessionId, toolCallId, subSessionId, description}`，类型 `RunSubagentSpawnedEvent` 已在 `libs/types-agent/src/session.ts`）。处理方式与 `onToolEnd` 同款 idiom：按 `toolCallId` 定位 assistant 消息里的工具条目，patch 上 `subSessionId`。`ToolCallView`（`message-list.tsx`）加可选字段 `subSessionId?: string`。
2. **history 附带**（刷新还原，含 mid-run）：见 §4，`HistoryToolCallSchema` 加可选 `subSessionId`，`useSessionStream` 的 history 水合 1:1 透传。
3. **结果 JSON 兜底**：`SubagentCard` 内 `tool.subSessionId ?? safeParse(tool.result).subSessionId`——完成后的工具结果本来就是 `{subSessionId, status, output}`，一行冗余，防旧数据/万一。

事件为一次性（仅 spawn 时发），刷新不依赖它——这正是来源 2 存在的原因：子 run 进行中工具结果尚未落库（`result` 为空、status `running`），没有来源 2 时 mid-run 刷新的卡无法认领。

## 4. 后端增强（唯一后端改动）

- **`SessionService.listChildren(parentSessionId)`**：新只读查询，返回该父会话的子会话 `{id, parentToolCallId}` 列表（`parent_session_id` 已有索引 `idx_sessions_parent`；单表读，无需 `@Transactional`，中文 JSDoc）。Session 归属不变（仍由 SessionService 唯一持有 repo），围栏无冲突。
- **history controller**（`session.controller.ts` 的 history 组装）：构建 `toolByCallId` 之外再查一次 `listChildren(id)`，按 `parentToolCallId` 匹配，把 `subSessionId` 塞进对应工具条目。
- **`HistoryToolCallSchema`**（`libs/types-agent/src/session.ts`）：加 `subSessionId: z.string().optional()`。可选字段，向后兼容，旧客户端不受影响。

## 5. 前端组件

### 5.1 SubagentCard（新组件）

`apps/web-agent/src/components/session/subagent-card.tsx`，props `{ tool: ToolCallView; sessionId: string }`，与现有 6 张特判卡一致。接入点：`tool-call-block.tsx` 特判链（现 42-67 行）加第 7 个分支 `if (tool.name === "dispatch_subagent" && tool.status !== "streaming") return <SubagentCard .../>`；`tool-display.ts` 的 `TOOL_LABELS` 补 `dispatch_subagent: "派发子任务"`。

- **内部流**：`useSessionStream(subSessionId ?? null, scrollRef)`，`scrollRef` 指向卡内滚动容器（该参数仅供「加载更多历史」滚动锚定，本期不做该按钮，传真实容器 ref 即可、无副作用）。hook 对 `null` 天然 inert；多实例并挂已被 `assistant-dock` + 主会话页并存验证，socket 单例/退房清理零改造。
- **折叠头**：状态点（子流 `running` 时动效；结束后按工具状态 done/error/aborted 显示徽标）+ 标题（`tool.args.description`，缺省取 `task` 截 30 字，与后端 fallback 一致）+ Chevron 旋转，`aria-expanded`，样式沿用 `ToolCallBlock`/`CompactionRow` 惯例（无第三方 accordion）。
- **展开体**：`<MessageList nested messages={sub.messages} sessionId={subSessionId} running={sub.running} onRegenerateOptimisticCut={noop} />`，外层 `max-h-96 overflow-y-auto`（限高 + 内部滚动，防多卡并行撑长父页面），子流有新内容时自动滚到底（仅当用户未向上滚动）。
- **折叠状态机**：`auto` 态跟随 `sub.running`（运行→展开，结束→收起）；用户点击后切 `manual` 态不再自动。提取为纯函数/自定义 hook 以便单测。
- **收起 ≠ 卸载**：收起只隐藏展开体 DOM，`useSessionStream` 保持挂载订阅，避免反复退房/重拉历史；组件卸载时 hook 既有清理逻辑负责退房。

### 5.2 MessageList nested 变体

`message-list.tsx` 加 `nested?: boolean` prop：为 true 时不渲染头像行、`UserMessageActions`（重试）、反馈按钮、`TodoPanel`，不消费 `usageByMessage`；保留 assistant 文本、`ReasoningBlock`、`ToolCallBlock`、`CompactionRow`。子会话子图无 dispatch 工具（后端三重防护），嵌套深度天然 ≤1，前端无需递归守卫。

### 5.3 useSessionStream 增量

- 注册/清理 `runSubagentSpawned` 监听（与其他 `run.*` 监听同位置成对增加）。
- history 水合时透传 `tc.subSessionId`。
- 不改 hook 对外 API。

### 5.4 i18n

新增 `session.subagent` 子命名空间（`messages/zh.json` + `messages/en.json` 双份齐），全部走 `useTranslations`：标题前缀、启动中、运行中、已完成/失败/已中止、展开/收起等。不沿用 `ask-question-card` 的硬编码中文（既有反例，不是惯例）。

## 6. 错误与边界

- **子 run error/aborted**：折叠头状态徽标区分；展开可见子会话内失败上下文；`output` 摘要照常在父流工具结果里（LLM 与用户都可见）。
- **认领前**（spawned 未到 / history 无关联 / 结果解析失败）：卡显示「启动中」占位，不渲染嵌套流，不炸。
- **并行 fan-out**：同轮多个 dispatch tool_calls 渲染为多张并列卡，各自独立订阅；socket 为共享单例，房间按子会话 id 隔离。
- **子会话不进侧栏**：`listAllSorted`/`listQuickSessions` 均按 kind 过滤（1a 已保证），前端无其他列表路径泄漏。

## 7. 测试

- **后端（jest）**：`SessionService.listChildren` 单测；history controller 附带 `subSessionId` 组装单测（含无子会话、多子会话匹配多 toolCallId）。
- **types-agent（jest）**：`HistoryToolCallSchema` 可选字段解析单测。
- **前端**：web-agent 组件测试基建以 plan 阶段实测为准；最少将「认领优先级（三路来源）」与「折叠状态机」提为纯函数并单测。
- **收尾验证（吸取 1a 教训）**：全量根 jest（不只目标 spec）+ server-agent boot + **真机冒烟**——起 server-agent + web-agent，真派发一次，验证实时滴流、mid-run 刷新还原、并行多卡。

## 8. 明确不做（Phase 2）

停止按钮/独立 abort、`background` 后台运行与完成播报、`model` per-run 覆盖、「在完整页打开子会话」链接、子会话用量小计、孤儿子会话 GC/重拉、「加载更多历史」按钮。
