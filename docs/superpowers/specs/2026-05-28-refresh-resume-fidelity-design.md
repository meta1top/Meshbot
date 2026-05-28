# 刷新/切换会话时的「续上」保真度修复 设计文档

## 背景

server-agent 跑一轮 ReAct 推理时，用户可能在 LLM 流式中、tool 执行中、轮次切换等任何时机刷新页面或切换 session。当前实现下：

1. **完成的中间轮看不到**：每轮 LLM 完成后，assistant 行的 `recordAssistant` 调用挂在 `assistant_done` 事件上，而 `assistant_done` 只在「下一轮第一个 chunk 到达」或「整个 stream 关闭」时才 flush。所以中间轮的 assistant 滞后 1～34 秒入库，期间刷新看不到这条 assistant；其对应的 tool result 行虽然实时写入，但前端历史渲染按 `r.role !== "tool"` 过滤、靠 assistant 的 `tool_calls` JSON 才挂回去，孤儿 tool 行直接不可见。
2. **tool 执行中刷新看不到工具调用**：`run.tool_call_start` 是瞬时 WS 事件，刷新后只能从 `session_messages` 拉历史，而执行中的 tool 没有持久化痕迹（assistant 又因 #1 还没 persist）。
3. **思考中刷新 reasoning 块默认折叠**：inflight replay 时 `reasoningDurationMs: 0` 触发「已思考」状态，块默认收起；用户期望此时仍是「思考中 Xs」+ 默认展开。

预期目标：用户在 **任何时机** 刷新或切换回来，时间线视觉跟刷新前一致，且后续增量推送从断点接上。

## 范围

**仅 agent 域的运行时刷新场景**：

* `apps/server-agent` Runner / Graph 持久化路径
* `apps/web-agent` 会话页 history + inflight + WS 三路合并渲染
* `libs/types-agent` 共享类型

**不在本次范围**：

* compaction 期间的刷新行为（已有 banner / 三事件机制，未发现新缺口）
* run abort / error 后的页面状态（另有 `runError`/`runInterrupted` 路径，单独议题）
* 跨设备 / 多用户协同（本地轨单用户）
* `modelMeta` / 模型切换的并发观感问题（已知小瑕疵，不影响功能）

## 八个刷新时机的修复后行为

按事件相对位置编号：

| # | 时机 | 修复后看到 |
|---|------|----------|
| 1 | 用户发了消息、agent 还没动 | user 气泡 + pending 标识（沿用 `pending_messages` 表） |
| 2 | reasoning 流式中刷新 | reasoning 块**默认展开** + 显示「思考中 Xs」，已收到的思考文本完整可见，后续 token 续接 |
| 3 | content chunk 流式中刷新 | 已收到的 content 完整可见 + 后续 token 续接 |
| 4 | LLM 出完 tool_calls、tool 还没启动 | assistant 气泡已可见 + 工具块以「running」状态（含 name + args）渲染 |
| 5 | tool 跑到一半（30s MCP） | 同 #4：assistant + 工具 running 状态可见 |
| 6 | tool 完、下一轮 LLM 还没开始 | 上一轮 assistant + 工具完成态（含 result）可见；新轮 inflight 为空 |
| 7 | 下一轮 LLM 流式中 | 前面所有完整轮可见；当前轮 inflight replay 续上 |
| 8 | stream 即将关闭、最后一轮 assistant 等 flush | 当前轮 inflight 可见；run 结束后 history 端会有这条 assistant |

修复后核心不变量：**只要 inflight 在跑，session_messages 里前面所有完成的轮（含 tool 调用关系）都已落库**，刷新出的 history 视觉跟刷新前一致。

## 设计

四个改动点。后端两处，前端两处。schema 不动。

### 后端 1：graph stream 见到 ToolMessage 立即 flush

文件：[libs/agent/src/graph/graph.service.ts](../../../libs/agent/src/graph/graph.service.ts)

当前 `runGraphStream` 的 for-await 循环：

```ts
for await (const part of stream) {
  const msg = Array.isArray(part) ? part[0] : part;
  if (!(msg instanceof AIMessageChunk)) continue;   // ToolMessage 在这里被直接跳过
  // …
  if (currentId !== null && currentId !== messageId) {
    yield* flushRound();   // 唯一中间 flush 触发：下一轮 chunk msg.id 变化
    // …
  }
}
yield* flushRound();        // 最后一轮兜底
```

新增触发：**当 part 是 ToolMessage 时（说明 supervisor 节点已结束、tools 节点开始流出），先 flush 当前 round 再 continue**。改动后大致：

```ts
for await (const part of stream) {
  const msg = Array.isArray(part) ? part[0] : part;
  if (!(msg instanceof AIMessageChunk)) {
    // tools 节点产出 ToolMessage 等非 AIMessageChunk 时，supervisor 必然已退出
    // → flush 当前累加的 assistant，让其立即 persist，避免「assistant 等到
    //   下一轮 chunk 才入库」的滞后窗口。
    if (currentId !== null && currentAcc !== undefined) {
      yield* flushRound();
      currentAcc = undefined;
      currentId = null;
      currentRoundStartedAt = Date.now();
    }
    continue;
  }
  // …（后续与原代码一致）
}
```

这样 supervisor → tools 这个边界的 `assistant_done` 事件就早早 yield 出来、`recordAssistant` 早早 fire-and-forget。runner 那侧无需改动。

### 后端 2：history 端把缺 tool row 的 tool_call 报为 "running"

文件：[apps/server-agent/src/controllers/session.controller.ts](../../../apps/server-agent/src/controllers/session.controller.ts)

当前 status 计算：

```ts
const status =
  trMeta && trMeta.ok === false
    ? ("error" as const)
    : ("ok" as const);     // tr 不存在时默认 ok
```

改为：

```ts
const status: "running" | "ok" | "error" =
  !tr
    ? "running"
    : trMeta && trMeta.ok === false
      ? "error"
      : "ok";
```

同步更新 [libs/types-agent/src/session.ts:96](../../../libs/types-agent/src/session.ts#L96) 的 `HistoryToolCallSchema.status` 枚举：`["ok", "error"]` → `["ok", "error", "running"]`。

### 前端 1：ToolCallBlock 识别 running

文件：[apps/web-agent/src/components/session/tool-call-block.tsx](../../../apps/web-agent/src/components/session/tool-call-block.tsx)

当 `tool.status === "running"` 时渲染流式过程中的转圈状态（跟 WS `run.tool_call_start` 触发后还没收到 `run.tool_call_end` 时一致）。原有 `ok` / `error` 两支保持。

### 前端 2：思考中刷新时 reasoning 块默认展开 + 「思考中 Xs」

文件：[apps/web-agent/src/app/session/page.tsx](../../../apps/web-agent/src/app/session/page.tsx) + [apps/web-agent/src/components/session/message-list.tsx](../../../apps/web-agent/src/components/session/message-list.tsx)

当前 inflight push 时强行写 `reasoningDurationMs: 0`，ReasoningBlock 据此走「已思考」分支默认收起。

**采用方案**：ReasoningBlock 显式看 parent message 的 `streaming` 标记 —— `streaming === true` 时强制走「思考中 Xs」+ 默认展开，无视 durationMs。挑这条而不是改 inflight payload，是因为 `streaming` 是「这条 message 还在跑」的明确语义信号，独立于「思考已经持续多久」这个统计量；后者在历史回放时本来就拿不到，未来扩展也不应混用。

具体改动：

1. `page.tsx` inflight push 那段保留 `reasoningDurationMs: 0`（不动）。
2. ReasoningBlock 接收 `streaming?: boolean` prop（从 parent `m.streaming` 透传），优先级高于 durationMs。当 `streaming === true`：
   * 标签显示「思考中 Xs」，X 用 `reasoningStartedAt` 计算；如 startedAt 缺失（刷新场景就是），fallback「思考中」无时长。
   * 默认展开（不收起）。
3. 上面流式期间的 onReasoning handler 已经把内容累加到这个 TimelineMessage 上，刷新 + 后续 token 续接完全靠这个 message 的状态机不破坏。

## 数据流验证（修复后）

`assistant_done` 路径的 happy path（以 tool_call 一轮 + 最终终答一轮为例）：

```
t=0   supervisor 节点 stream chunks (msg.id=A) → 累加 currentAcc=A
t=2s  supervisor 节点结束 → ToolMessage 进 stream
      → [NEW] flushRound() → yield assistant_done(A)
      → runner.recordAssistant(A) fire-and-forget  ✓ persist
t=2s  tools 节点跑：run.tool_call_start emit
      → 当前 frontend WS push 显示 running 工具块
      → 但 history 已有 assistant(A) 携 tool_calls JSON
      → 即使此刻刷新：history 拉到 A + tool_calls，tool row 不存在 → "running"  ✓
t=30s tools 节点结束：run.tool_call_end emit
      → runner.recordToolResult(...) ✓ persist tool row
      → assistant(A) + tool row 都齐了
t=30s supervisor 节点 stream chunks (msg.id=B) → 累加 currentAcc=B
      → 第一个 chunk 进来时 currentId === null（被 ToolMessage flush 重置了）
      → 设 currentId=B
t=35s supervisor 节点结束（终答，无 tool_calls）→ stream 关闭
      → 收尾 flushRound() → yield assistant_done(B) → recordAssistant(B) ✓
```

中途任何时刻刷新，history fetch + getInflight 组合都能拼出一致视觉。

## 边界 & 风险

* **flushRound() 在 ToolMessage 触发后 currentId 重置为 null**：下一轮第一个 AIMessageChunk 进来时 `currentId !== null && currentId !== messageId` 的旧分支不会再误触发 flush（已 flush 过了），符合预期。需要在实现时小心赋值时序。
* **`assistant_done` 事件被前端 chunk handler 当作流式结束信号**：检查 page.tsx 的 `onAssistantDone` 处理 —— 修复前 `assistant_done` 只在轮切换或 stream 关闭时来；修复后在每个 ReAct 轮的 supervisor 退出时来。如果前端有「assistant_done = 整个 run 结束」的误判断，需要修正。预期不应有，因 `run.done` 才是 run 结束信号。
* **fire-and-forget 写入仍然异步**：`recordAssistant` 在 supervisor 出口被 yield 出来后是异步入库，理论上 race 窗口缩到毫秒级（远小于 tool 跑的几十秒），刷新撞上的概率极低。可接受。
* **历史回放刷新可能与正在到达的 WS 增量竞争**：现有 `page.tsx` 合并逻辑用 `socketArrived` 保留 socket 已先到的消息，此机制不变；修复后中间轮也已落库 → history 拉回的就是「之前」的稳定数据，WS push 只追加 `≥ currentRound` 的增量 → 不会冲突。
* **`tool_calls` JSON 大小**：assistant 行带 tool_calls 数组，args 可能含大型 JSON（MCP 调用的 base64 之类）。当前已落库，不变。如果未来 args 超大要再议截断策略。

## 测试策略

vitest 单测：

* `tools.node` 已有的并发回归用例不动
* `graph.service` 新增：mock supervisor 出 tool_calls 后 tools 节点 yield ToolMessage 的场景，断言 `assistant_done` 在 ToolMessage 之前 yield（而不是等下一轮）
* `session-message.service` history 端：tool row 缺失的 case，断言 status="running"

集成验证：

* 跑一个会触发 ReAct 多轮的 prompt（peekaboo + bash 工具），在工具执行中刷新，断言时间线视觉与刷新前一致
* 两个 session 并发跑（覆盖 Bug A 既有修复 + Bug B 新修复），各自的 running 工具不串台

围栏：`pnpm check` 全过；`pnpm typecheck` 干净。

## 不做

* 不引入新表
* 不给 `session_messages` 加列
* 不持久化 reasoning 的中间 token（只在 inflight 内存里累加，replay 经 WS 推送）
* 不在 tool_call_start 时写 DB（args 已在 assistant 行的 tool_calls JSON 里，没必要双写）
