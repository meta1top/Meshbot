# 会话上下文压缩（Context Compaction）

## 背景

deepseek-v4-pro 等大上下文模型让长会话成为常态。当前一次失败用例：14 轮对话累计 input 3.99M（单次峰值 511k），其中两次 `take_screenshot` 工具的 base64 截图各撑了 ~30%。如果不主动压缩，迟早撞 ctx 上限报 `context_length_exceeded`。

右下角进度环原本显示 `sum(input+output) / contextWindow` —— 累加值除以单次上限，量纲错乱。本设计把它改成"下次请求估算 / ctx 上限"，并以这个比例作为压缩触发条件：≥ 90% 时同步压缩到约 20% 再发请求。

支撑层早已为此预留：

- `session_messages` 与 LangGraph `checkpoints` 故意解耦（[migration 1779300000000 注释](../../../apps/server-agent/src/migrations/1779300000000-SessionMessagesTable.ts) 写明"为未来 summarize 压缩做准备"）
- `RemoveMessage` + messages reducer 已被 `sanitizeOrphanToolCalls` / `cutMessagesAfter` 验证可用

## 决策总览

| 维度 | 决策 |
|---|---|
| 压缩目标 | ctx 上限的 20%（10% 给摘要预算 + 10% 给近期保留） |
| 压缩策略 | 摘要 + 保留近 N 轮（hybrid，N 由 token 预算动态决定） |
| 触发点 | **Pre-check**：runner.runOnce 开头同步检查 + 等待压缩完成才发 LLM 请求 |
| 触发阈值 | `lastInputTokens / contextWindow ≥ 0.9` |
| 兜底 | LLM 抛 `context_length_exceeded` 时 runner 强制压缩 + 重试一次 |
| 摘要模型 | 复用当前 enabled model（v1 不开"独立 summarizer"配置） |
| 状态改写 | `graph.updateState(RemoveMessage[] + new SystemMessage)` 一次性提交 |
| UI 反馈 | WS 事件 `run.compaction_start / done / error`，发送中 banner 提示，事后 session_messages 插一行系统占位（type=compaction） |
| UI 时间线 | `session_messages` 永久保留，原历史不删；用户始终能看到原文 |
| 并发 | per-session in-memory `Map<sessionId, Promise<void>>` 锁；用户在压缩中发的消息走 pending_messages 队列 |
| 用户可配置 | v1 不开放（阈值 / 目标全 hardcoded） |
| 手动触发 | v1 不做 |

## 1. 分层与新组件

```
apps/server-agent/src/services/context-compactor.service.ts   (新) ── 入口 + 调度 + 失败处理
apps/server-agent/src/services/context-compactor.service.spec.ts (新)
libs/agent/src/prompt/compactor.prompt.ts                     (新) ── SYSTEM prompt 模板
libs/agent/src/graph/graph.service.ts                         (改) ── 暴露 getMessagesSnapshot / summarize hook
apps/server-agent/src/services/runner.service.ts              (改) ── pre-check + ctx-exceeded catch
apps/server-agent/src/services/llm-call.service.ts            (改) ── getSessionTotals 多返 lastInputTokens
apps/web-agent/src/components/common/chat-input.tsx           (改) ── 进度环数据源换 lastInputTokens
apps/web-agent/src/app/session/page.tsx                       (改) ── 接 WS compaction 事件 + banner
libs/types-agent/src/session.ts                               (改) ── 加 SESSION_WS_EVENTS.runCompaction*
```

**位置选择**：ContextCompactor 放 server-agent 是因为它需要同时调 GraphService（libs/agent 跨域）和 ModelConfigService / SessionMessageService / LlmCallService（server-agent 业务实体），属典型跨层编排。libs/agent 仅承担"跑 LLM 调用、改 checkpointer 状态"的纯能力。

## 2. 数据状态分布

| 状态 | 存储 | 压缩时操作 |
|------|------|---------|
| LLM 真值 messages | LangGraph `checkpoints` / `writes` 表 | `graph.updateState(RemoveMessage[N条] + SystemMessage[1条])` |
| UI 时间线 | `session_messages` 表 | append 一行 `role=system, metadata.kind=compaction` |
| ModelConfig | `model_configs.context_window` | 不变 |
| 上次调用 token | `llm_calls.input_tokens`（最新一行） | summarize 调用也写一行（v1 不打标记，merge 进 sessionTotals） |
| 压缩元信息 | session_messages 那行的 `metadata` 列 | `{ kind, removedCount, fromMessageId, toMessageId, summary }` |

**核心不变量**：

1. `session_messages` 只追加，不删
2. `checkpoints` 是 LLM 真值，可任意改写（messages reducer 已支持 RemoveMessage）
3. 两边不需要同步：UI 看 session_messages，LLM 看 checkpoints

## 3. 触发流程

```
runner.runOnce(sessionId)
  ↓
[pre-check]
  const lastCall = await llmCallService.getLastBySession(sessionId)
  const model = await modelConfigService.findEnabled()
  if (lastCall && lastCall.inputTokens / model.contextWindow >= 0.9) {
    await compactor.compact(sessionId)   // 同步等待
  }
  ↓
graphService.streamMessage(...)
  ↓ [若抛 isContextLengthError(err)]
  emit runCompactionStart { reason: "ctx-exceeded" }
  try {
    await compactor.compact(sessionId, { force: true })
    retry graphService.streamMessage(...)   // 只重试一次
  } catch (compactErr) {
    throw err   // 原 ctx 错误抛给用户
  }
```

**Token 估算口径**：

| 用途 | 取值 |
|------|------|
| 进度环显示 | `lastInputTokens / contextWindow`（来自 sessionTotals 新字段） |
| Pre-check 判定 | 同上 |
| 切分预算估 token | 逐条 message `JSON.stringify(content + tool_calls).length / 4` |

`/4` 启发式偏低估，对我们有利——保留预算 10% ctx 实际占用 6-8%，留缓冲。

**为什么不用真实 tokenizer**：DeepSeek / Anthropic / Google 各家分词不同，没有跨 provider 的统一 JS 库。`lastInputTokens` 是服务端真实计数，最准。

## 4. 压缩算法

```ts
async function compact(sessionId: string, opts?: { force?: boolean }) {
  // 0. 锁
  if (locks.has(sessionId)) return locks.get(sessionId)!;
  const promise = doCompact(sessionId, opts).finally(() => locks.delete(sessionId));
  locks.set(sessionId, promise);
  return promise;
}

async function doCompact(sessionId, opts) {
  const threadId = sessionId;
  const ctx = (await modelConfigService.findEnabled())!.contextWindow;
  const messages = await graphService.getMessagesSnapshot(threadId);

  // 1. 切分
  const keepBudget = Math.floor(ctx * 0.10);
  let splitIdx = findSplitIndex(messages, keepBudget);
  splitIdx = expandToToolBoundary(messages, splitIdx);

  if (splitIdx === 0) {
    if (opts?.force) throw new CompactionNothingToCompact();
    return null;
  }
  if (messages.length - splitIdx < 2) {
    splitIdx = Math.max(0, messages.length - 2);
  }
  const toSummarize = messages.slice(0, splitIdx);
  const toKeep = messages.slice(splitIdx);

  // 2. 摘要
  emitter.emit(SESSION_WS_EVENTS.runCompactionStart, { sessionId, reason: opts?.reason ?? "threshold" });
  const summaryText = await graphService.summarize(toSummarize, {
    timeoutMs: 60_000,
    maxTokens: 600,
  });

  // 3. 改写 checkpointer
  await graphService.updateState(threadId, {
    messages: [
      ...toSummarize.map((m) => new RemoveMessage({ id: m.id! })),
      new SystemMessage({
        content: `[Earlier conversation summary]\n${summaryText}`,
        id: `compaction-summary-${Date.now()}`,
      }),
    ],
  });

  // 4. session_messages 占位
  await sessionMessageService.persist({
    sessionId,
    role: "system",
    content: summaryText,
    metadata: {
      kind: "compaction",
      removedCount: toSummarize.length,
      fromMessageId: toSummarize[0].id,
      toMessageId: toSummarize[toSummarize.length - 1].id,
    },
  });

  // 5. 通知前端
  emitter.emit(SESSION_WS_EVENTS.runCompactionDone, {
    sessionId,
    removedCount: toSummarize.length,
    summaryPreview: summaryText.slice(0, 200),
  });
}
```

### 4.1 切分点算法

```ts
function findSplitIndex(messages: BaseMessage[], budget: number): number {
  let acc = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    acc += estimateTokens(messages[i]);
    if (acc > budget) return i + 1;
  }
  return 0;  // 全部都在预算内
}

function estimateTokens(m: BaseMessage): number {
  const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
  const toolCallsLen = "tool_calls" in m && Array.isArray(m.tool_calls)
    ? JSON.stringify(m.tool_calls).length : 0;
  return Math.ceil((text.length + toolCallsLen) / 4);
}
```

### 4.2 Tool 边界扩展（关键正确性约束）

如果切分点正好落在 `AIMessage(tool_calls)` 与对应 `ToolMessage(tool_call_id)` 之间，会出现孤儿 tool_call → LLM 直接 400。`expandToToolBoundary` 把 splitIdx 往前移直到没有跨边界的 tool 对：

```ts
function expandToToolBoundary(messages: BaseMessage[], splitIdx: number): number {
  // 在 splitIdx 右边（keep 区）找 ToolMessage，看其 tool_call_id 是否对应到
  // 左边（summarize 区）的 AIMessage.tool_calls。如有，把 splitIdx 移到那
  // AIMessage 之前（让整组 pair 进 summarize 区）。

  while (splitIdx < messages.length) {
    const right = messages[splitIdx];
    if (right._getType() !== "tool") break;
    const toolCallId = (right as any).tool_call_id;
    // 在 summarize 区找匹配的 AIMessage
    const ownerIdx = findToolCallOwner(messages, toolCallId, splitIdx);
    if (ownerIdx < 0 || ownerIdx >= splitIdx) break;
    // 把 owner AIMessage 一起划进 summarize 区
    splitIdx = ownerIdx + 1;
    // 但 owner 的其他 tool_call 的 ToolMessage 还可能在 keep 区 → 循环再处理
    // 终止条件：右边再也不是孤儿 ToolMessage
  }
  return splitIdx;
}
```

### 4.3 摘要 prompt

`libs/agent/src/prompt/compactor.prompt.ts`：

```ts
export const COMPACTION_SYSTEM_PROMPT = `你是一个会话历史摘要器。
将下面的对话按时间顺序压缩成简要总结，保留：
- 用户的关键意图和约束
- 已尝试过的方法、成功与失败的结果
- 重要的工具调用结论（不要保留截图 / 长输出的原文，仅描述要点）
- 当前进行中的任务状态

不保留：
- 寒暄
- 已被后续轮次推翻或重做的细节
- 工具调用的原始 base64 / 大段日志

输出 600 token 以内，第三人称叙述。`;
```

### 4.4 序列化摘要输入

`serializeForSummary(toSummarize)`：把消息数组拉平成单段文本喂给摘要 LLM：

```
[user] 帮我看看这家酒店的评价
[assistant] 好的，我打开页面
[tool mcp__chrome-devtools__new_page] (url: "...")
  result: 已加载页面 https://tripadvisor.com/...
[tool mcp__chrome-devtools__take_screenshot] ()
  result: (binary image, 256KB) — 截断省略 ...[truncated 256000 chars]
...
```

**Tool result 截断**：单条超过 500 字符的尾部截断为 `... [truncated N chars]`。这是为了：

- 不让 base64 进摘要 LLM 自己的 input（递归爆 ctx）
- 让摘要 LLM 知道"这里有过截图"但不带原始字节
- 摘要 LLM 自然写出"用户截了 X 页面"这样的描述

## 5. 失败处理矩阵

| 失败点 | 状态影响 | 用户感知 | 处理 |
|--------|--------|---------|------|
| `getState()` 抛错 | 无 | banner 闪一下 → 错误 toast | 抛 CompactionError；runner 标 message failed |
| toSummarize 为空（非 force） | 无 | 无 | return null，runner 正常进 LLM |
| toSummarize 为空 + force=true | 无 | 错误 toast"无法压缩，可能消息过长" | 抛 CompactionNothingToCompact；runner 抛原 ctx 错 |
| Summarize LLM 失败 | 无 | banner → 错误 toast"历史压缩失败" | emit `runCompactionError`，抛错 |
| Summarize LLM timeout (60s) | 无 | 同上 | 同上 |
| `updateState()` 失败 | summary 已生成但丢弃 | 同上 | log error，抛错 |
| `sessionMessageService.persist()` 失败 | checkpointer 已改，UI 行丢失 | banner 撤掉但时间线没占位 | log warn，**不回滚**（LLM 状态已正确，UI 占位行不致命） |
| Pre-check 漏判 → LLM 报 ctx_exceeded | 无 | banner → 几秒后回复正常 | runner catch → 强制 compact + retry 一次 |
| 兜底重试还失败 | 无 | message failed + 错误展示 | 抛原 ctx 错给上层 |

**`isContextLengthError(err)` 实现**：按 provider 分别匹配——

- OpenAI / DeepSeek / OpenAI-compatible：`err.error?.code === 'context_length_exceeded'` 或 `err.status === 400 && /context/.test(err.message)`
- Anthropic：`err.error?.type === 'invalid_request_error' && /prompt is too long/.test(err.message)`
- Gemini：`err.message?.includes('exceeds the maximum')`
- 匹配不到 → 当作非 ctx 错误抛出，不触发兜底

## 6. WS 事件

`libs/types-agent/src/session.ts` 新增：

```ts
SESSION_WS_EVENTS.runCompactionStart  // { sessionId, reason: "threshold" | "ctx-exceeded" }
SESSION_WS_EVENTS.runCompactionDone   // { sessionId, removedCount, summaryPreview }
SESSION_WS_EVENTS.runCompactionError  // { sessionId, error }
```

前端 [apps/web-agent/src/app/session/page.tsx](../../../apps/web-agent/src/app/session/page.tsx) 接这三个事件维护一个本地 `compacting: boolean` 状态，session 顶部展示 banner：

> 「会话历史压缩中…（已用 X / Y）」

收到 done / error 撤掉 banner。done 的同时 session_messages 列表里会通过 listPage 刷新自然出现新的 compaction 占位行（带"已压缩 N 条，点击展开摘要"折叠 UI）。

## 7. 进度环改造

**`LlmCallService.getSessionTotals` 返回结构加 `lastInputTokens: number`**：

```ts
interface SessionTotals {
  // ... 既有字段
  lastInputTokens: number;  // 新增：最近一次 llm_calls.input_tokens；空 session = 0
}
```

实现：现有 `rows.reduce` 之后再取 `rows.at(-1)?.inputTokens ?? 0`。

**前端 [chat-input.tsx](../../../apps/web-agent/src/components/common/chat-input.tsx)**：

```ts
tokenUsage={{
  current: sessionTotals.lastInputTokens,    // 改这里
  max: enabledModel.contextWindow,           // 模型上限（之前已修）
  breakdown: {
    inputTokens: sessionTotals.inputTokens,        // 累计花费
    outputTokens: sessionTotals.outputTokens,
    cacheReadTokens: sessionTotals.cacheReadTokens,
    reasoningTokens: sessionTotals.reasoningTokens,
    callCount: sessionTotals.callCount,
  },
}}
```

进度环主显示从"累加比"换成"下次比"，tooltip 里继续显示 breakdown（累计花费、调用次数）作为辅助信息。

## 8. 测试

### 单元测试（jest）

`apps/server-agent/src/services/context-compactor.service.spec.ts`：

- `estimateTokens()` 各 message 类型给出合理估值
- `findSplitIndex()`：
  - 全部都在预算内 → 0
  - 普通切分
  - 边界情况：单条 message 已超预算
- `expandToToolBoundary()`：
  - 切分点跨 tool pair → 扩展
  - 多重嵌套 tool（一个 AIMessage 多 tool_calls）→ 全组扩展
  - 切分点干净 → 不动
- `serializeForSummary()` tool result 长内容截断
- `isContextLengthError()` 各 provider 错误识别

ContextCompactor 自身（Nest Testing + mock GraphService / ModelConfigService / SessionMessageService / EventEmitter2）：

- happy path：20 条 → 切分 5 → summary 生成 → state 一次性 updateState（验断 RemoveMessage 数量 + SystemMessage 注入）→ session_messages 写入 → 3 个事件依次发射
- LLM summarize 失败 → state 没动 → emit `runCompactionError` → 抛 CompactionError
- 空 toSummarize 非 force → return null，不调 LLM 不发事件
- 空 toSummarize + force → 抛 CompactionNothingToCompact
- 并发同 sessionId compact → 第二个 await 拿到第一个的 Promise，不重复
- `getState()` 抛错 → 抛出，无副作用

### Runner 单元测试

- pre-check 命中阈值 → 调 `compactor.compact()` 成功 → 进 streamMessage
- pre-check 命中 → compact 抛错 → 不进 streamMessage，标 message failed
- streamMessage 抛 ctx_exceeded → emit + 强制 compact + 重试一次成功
- streamMessage 抛非 ctx 错 → 不触发兜底，原样抛
- 兜底压缩成功但重试 streamMessage 仍 ctx_exceeded → 抛原错（不再继续重试）

### 集成测试（v1 不做）

libs/agent 已有 vitest 跑 SqliteSaver 集成测试，但需 mock LLM + 真 SQLite，工作量大。v1 单测覆盖足够，v2 引入 e2e 时一起做。

## 9. 配置常量

`apps/server-agent/src/services/context-compactor.service.ts` 顶部 hardcoded：

```ts
const COMPACTION_TRIGGER_RATIO = 0.9;
const COMPACTION_RECENT_RATIO = 0.1;
const COMPACTION_SUMMARY_MAX_TOKENS = 600;
const COMPACTION_SUMMARIZE_TIMEOUT_MS = 60_000;
```

v2 想做"用户可配置"时挪到 `ModelConfig` 加列 + setup 表单字段。v1 不开 UI。

## 10. 不做 / 范围外

| 项 | v1 决定 | v2 可能 |
|----|--------|--------|
| 用户可配置阈值 / 目标 | ❌ hardcoded | ✅ ModelConfig 加列 + UI |
| 手动「压缩」按钮 | ❌ auto only | ✅ 加按钮 |
| 独立 summarizer model | ❌ 复用 enabled | ✅ ModelConfig role=summarizer |
| 压缩可撤销 / 回滚 | ❌ session_messages 不变但 LLM 不可回滚 | 看需求 |
| Compaction 调用单独标记不进 sessionTotals | ❌ merge | ✅ llm_calls 加 purpose 列 |
| 多用户 / 跨进程协调 | ❌ in-memory Map 锁足够 | N/A（本地轨永远单进程） |
| 集成测试 | ❌ 单测覆盖 | ✅ 配合 phase E2E |

## 11. 实施顺序建议

按文件依赖从底层往上：

1. `libs/types-agent` 加 `runCompaction*` 事件名 + types
2. `libs/agent/src/prompt/compactor.prompt.ts` 加 SYSTEM prompt
3. `libs/agent/src/graph/graph.service.ts` 加 `getMessagesSnapshot()` / `summarize(messages, opts)` 公开方法
4. `apps/server-agent/src/services/llm-call.service.ts` `getSessionTotals` 加 `lastInputTokens` + 单测
5. `apps/server-agent/src/services/context-compactor.service.ts` + 完整单测
6. `apps/server-agent/src/services/runner.service.ts` pre-check + ctx-exceeded catch + 单测
7. (可能) `session_messages` 加 `metadata` 列（按现有 schema 决定）
8. `apps/web-agent` chat-input 进度环 + session/page banner + WS 事件处理
9. session_messages 折叠组件渲染 compaction 占位行

每步独立 commit 走 conventional-commit 中文规范。
