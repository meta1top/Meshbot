# 「续上」保真度补丁 实施计划（追加）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修两个手测中暴露的真实 bug——刷新中思考计时器跑飞 + tool 执行期间整轮消失。

**Architecture:** 两条独立线：
- 服务端 inflight 加 `reasoningStartedAt` 字段，前端 onReasoning 不再现取 Date.now() 兜底
- graph.service 切到 `streamMode:["messages","updates"]`，supervisor 节点 update 即触发 flushRound（不再等 ToolMessage——后者在工具结束后才到，几十秒太晚）

**Tech Stack:** TypeScript / NestJS / Next.js / vitest / Jest / @langchain/langgraph

---

## 背景

前置 plan：[2026-05-28-refresh-resume-fidelity.md](2026-05-28-refresh-resume-fidelity.md)

Tasks 1-4 落库后手测暴露：

**Bug 1**：刷新落在 reasoning 流式中，标签显示「思考中 41.0s」一路涨。

根因：[apps/web-agent/src/app/session/page.tsx:330](../../../apps/web-agent/src/app/session/page.tsx#L330) `reasoningStartedAt: existing.reasoningStartedAt ?? Date.now()`。刷新时 fetchHistory 推 inflight 进 timeline（**没**带 startedAt），ws handleSubscribe replay 出 `runReasoning` 事件，前端 onReasoning 命中 existing message 但 startedAt undefined → 兜底 `Date.now()`，把 startedAt 设到「刷新时刻」。之后 elapsed = now - 刷新时刻 → 一路涨。

**Bug 2/3**：刷新落在 tool 执行中（30s MCP 调用），那一轮的 assistant + tool 块整个不显示。

根因：前次 Task 3 的修复假设错了——「ToolMessage 进 stream」其实是 **tools 节点 return 时**才发生，而 tools 节点要等 `tool.execute()` resolve。所以工具跑的 30 秒里 ToolMessage 还没进 stream，flushRound 不会触发，assistant 没入库。之前 vitest 用的 echoTool 同步立即返回，看起来「ToolMessage 紧跟 supervisor 退出」是误导。

正确的 supervisor 出口信号是 LangGraph 的 `streamMode:"updates"`——supervisor 节点 return 时 emit 一个 `{ supervisor: {...} }` update 事件，此时 tools 还没跑。多 mode `["messages","updates"]` 之下每个 yield 是 `[mode, payload]` 元组。

---

## File Structure

| 文件 | 类型 | 责任 |
|------|------|------|
| [libs/agent/src/graph/graph.service.ts](../../../libs/agent/src/graph/graph.service.ts) | 修改 | runGraphStream 切 `["messages","updates"]`；supervisor update 触发 flushRound |
| [libs/agent/tests/unit/graph.service.test.ts](../../../libs/agent/tests/unit/graph.service.test.ts) | 修改 | 现有「ToolMessage 边界即 flushRound」用例改名 + 让 echoTool sleep 300ms，断言 assistant_done(A) 在 tool 完成之前 yield |
| [apps/server-agent/src/services/runner.service.ts](../../../apps/server-agent/src/services/runner.service.ts) | 修改 | InflightRun + InflightView 加 `reasoningStartedAt: number \| null`，reasoning/chunk 切轮时重置 + 首次记录 |
| [apps/server-agent/src/services/runner.service.spec.ts](../../../apps/server-agent/src/services/runner.service.spec.ts) | 修改 | （如果存在）加用例：getInflight 返回 reasoningStartedAt |
| [libs/types-agent/src/session.ts](../../../libs/types-agent/src/session.ts) | 修改 | `InflightSnapshotSchema`（或对应 Inflight 类型）加 reasoningStartedAt 可选字段 |
| [apps/web-agent/src/app/session/page.tsx](../../../apps/web-agent/src/app/session/page.tsx) | 修改 | inflight push 时透传 reasoningStartedAt；onReasoning 不再 ?? Date.now() 兜底（startedAt 已经从 inflight 带来或本来就是 undefined） |

---

## Task 1: Bug 1 — 服务端 inflight 加 `reasoningStartedAt`，前端不再现取兜底

### Step 1: 看类型现状

- [ ] **Step 1.1: 读 inflight 相关类型**

Run: `grep -n "InflightSnapshot\|InflightView\|inflight:" /Users/grant/Meta1/meshbot/libs/types-agent/src/session.ts | head -10`
Expected: 定位 inflight schema 在 types-agent 的位置（应该在 session.ts 里）。读那一段确认字段。

Run: `grep -n "InflightView\|InflightRun\|reasoningStartedAt" /Users/grant/Meta1/meshbot/apps/server-agent/src/services/runner.service.ts | head -10`
Expected: 看 runner 里 InflightRun / InflightView 的位置（已知 L17-36 区域）。

### Step 2: 扩 InflightRun + InflightView

- [ ] **Step 2.1: 在 runner.service.ts 给 InflightRun 加字段**

In [apps/server-agent/src/services/runner.service.ts](../../../apps/server-agent/src/services/runner.service.ts) L17-28 区域，给 `InflightRun` 加：

```ts
interface InflightRun {
  messageId: string | null;
  content: string;
  reasoning: string;
  /**
   * 当前轮 reasoning 首个 chunk 到达的时间戳（ms）。
   * - 进入新轮（messageId 切换）时重置为 null
   * - 收到本轮第一个 reasoning event 时记录 Date.now()
   * 用途：getInflight 返回，前端刷新替换 onReasoning 现取 Date.now() 的错误兜底。
   */
  reasoningStartedAt: number | null;
  status: "streaming" | "done" | "interrupted";
  abort: AbortController;
  retried?: boolean;
}
```

同理 `InflightView`：

```ts
export interface InflightView {
  messageId: string | null;
  content: string;
  reasoning: string;
  reasoningStartedAt: number | null;
  status: "streaming" | "done" | "interrupted";
}
```

### Step 3: 在 reasoning/chunk handler 维护 reasoningStartedAt

- [ ] **Step 3.1: reasoning event handler 加初始化逻辑**

In [apps/server-agent/src/services/runner.service.ts](../../../apps/server-agent/src/services/runner.service.ts) 找 `consumeRunStream` 里的 `if (event.kind === "reasoning")` 分支。原代码：

```ts
if (event.kind === "reasoning") {
  if (run.messageId !== event.messageId) {
    run.messageId = event.messageId;
    run.content = "";
    run.reasoning = "";
  }
  run.reasoning += event.delta;
  this.emitter.emit(SESSION_WS_EVENTS.runReasoning, { ... });
  continue;
}
```

改为：

```ts
if (event.kind === "reasoning") {
  if (run.messageId !== event.messageId) {
    run.messageId = event.messageId;
    run.content = "";
    run.reasoning = "";
    run.reasoningStartedAt = null;
  }
  // 本轮首个 reasoning delta：记下 startedAt，刷新时前端能拿到真实开始时间
  if (run.reasoning === "" && event.delta) {
    run.reasoningStartedAt = Date.now();
  }
  run.reasoning += event.delta;
  this.emitter.emit(SESSION_WS_EVENTS.runReasoning, { ... });
  continue;
}
```

- [ ] **Step 3.2: chunk handler 同款重置**

In the `if (event.kind === "chunk")` 分支，找 messageId 切换处：

```ts
if (run.messageId !== event.messageId) {
  run.messageId = event.messageId;
  run.content = "";
  run.reasoning = "";
}
```

加 reset：

```ts
if (run.messageId !== event.messageId) {
  run.messageId = event.messageId;
  run.content = "";
  run.reasoning = "";
  run.reasoningStartedAt = null;
}
```

- [ ] **Step 3.3: assistant_done 不动 reasoningStartedAt**（reasoning 结束、durationMs 由前端 onChunk 推算）

确认 `if (event.kind === "assistant_done")` 分支没有 `reasoningStartedAt =` 操作（不应有）。

### Step 4: runOnce 创建 InflightRun 时给 reasoningStartedAt 初始值

- [ ] **Step 4.1: 改 InflightRun 的初始构造**

In `runOnce`，找：

```ts
const run: InflightRun = {
  messageId: null,
  content: "",
  reasoning: "",
  status: "streaming",
  abort: new AbortController(),
};
```

加 `reasoningStartedAt: null`：

```ts
const run: InflightRun = {
  messageId: null,
  content: "",
  reasoning: "",
  reasoningStartedAt: null,
  status: "streaming",
  abort: new AbortController(),
};
```

### Step 5: getInflight 返回新字段

- [ ] **Step 5.1: 改 getInflight 的快照**

In `getInflight` (`runner.service.ts` 大致 L94-103)：

```ts
getInflight(sessionId: string): InflightView | null {
  const run = this.inflight.get(sessionId);
  if (!run || run.status !== "streaming") return null;
  return {
    messageId: run.messageId,
    content: run.content,
    reasoning: run.reasoning,
    reasoningStartedAt: run.reasoningStartedAt,
    status: run.status,
  };
}
```

### Step 6: types-agent 的 InflightSnapshot schema 加字段

- [ ] **Step 6.1: 定位 inflight schema**

In [libs/types-agent/src/session.ts](../../../libs/types-agent/src/session.ts) 找 `inflight: ...` 或 `InflightSnapshotSchema` 或 `InflightSnapshot`。读出当前定义并对比 InflightView。

- [ ] **Step 6.2: 加 reasoningStartedAt 可选字段**

加 `reasoningStartedAt: z.number().nullable()` 到 schema 里。注意类型保持与 InflightView 一致（`number | null`，可选语义靠 `.nullable()`）。

- [ ] **Step 6.3: 跑 types-agent 单测**

Run: `cd /Users/grant/Meta1/meshbot/libs/types-agent && pnpm vitest run 2>&1 | tail -5`
Expected: 全过。

### Step 7: 前端 page.tsx 透传 + onReasoning 不再现取兜底

- [ ] **Step 7.1: inflight push 时带上 reasoningStartedAt**

In [apps/web-agent/src/app/session/page.tsx](../../../apps/web-agent/src/app/session/page.tsx) L235-247 区域，inflight push 处把 `reasoningStartedAt` 透传：

原：
```tsx
initial.push({
  id: history.inflight.messageId,
  role: "assistant",
  content: history.inflight.content,
  streaming: true,
  ...(history.inflight.reasoning
    ? {
        reasoning: history.inflight.reasoning,
        reasoningDurationMs: 0,
      }
    : {}),
});
```

改为：
```tsx
initial.push({
  id: history.inflight.messageId,
  role: "assistant",
  content: history.inflight.content,
  streaming: true,
  ...(history.inflight.reasoning
    ? {
        reasoning: history.inflight.reasoning,
        // 服务端记录的真实 reasoning 起始时刻；缺失时不设 startedAt
        // （ReasoningBlock 走 streaming + 无 startedAt 的 fallback「思考中 0.0s」分支）
        ...(history.inflight.reasoningStartedAt !== null &&
        history.inflight.reasoningStartedAt !== undefined
          ? { reasoningStartedAt: history.inflight.reasoningStartedAt }
          : {}),
      }
    : {}),
});
```

注意：不再写 `reasoningDurationMs: 0`——保留 `streaming=true` + 真实 startedAt 让 ReasoningBlock 走 isThinking 分支算实际 elapsed。如果 startedAt 缺失，走 Task 4 的 fallback 「思考中 0.0s」。

- [ ] **Step 7.2: onReasoning handler 不再 ?? Date.now() 现取**

In [apps/web-agent/src/app/session/page.tsx](../../../apps/web-agent/src/app/session/page.tsx) L330 原：

```ts
copy[idx] = {
  ...existing,
  reasoning: (existing.reasoning ?? "") + e.delta,
  reasoningStartedAt: existing.reasoningStartedAt ?? Date.now(),
};
```

改为：

```ts
copy[idx] = {
  ...existing,
  reasoning: (existing.reasoning ?? "") + e.delta,
  // existing.reasoningStartedAt 来自 inflight 透传（刷新场景）
  // 或来自 idx===-1 分支首次创建（fresh 流式场景，已设 Date.now()）
  // 两种情况都已正确赋值，不再用「?? Date.now()」覆盖
  reasoningStartedAt: existing.reasoningStartedAt,
};
```

### Step 8: typecheck + 围栏 + commit

- [ ] **Step 8.1: typecheck**

Run: `cd /Users/grant/Meta1/meshbot && pnpm typecheck 2>&1 | tail -5`
Expected: 0 error.

- [ ] **Step 8.2: 围栏**

Run: `cd /Users/grant/Meta1/meshbot && pnpm check 2>&1 | tail -10`
Expected: 全过。

- [ ] **Step 8.3: 跑 server-agent 全套**

Run: `cd /Users/grant/Meta1/meshbot && pnpm --filter @meshbot/server-agent test 2>&1 | tail -10`
Expected: 全过（如果 runner spec 中断言了 InflightView 形状的用例，可能需要同步加字段；按需更新）。

- [ ] **Step 8.4: commit**

```bash
cd /Users/grant/Meta1/meshbot
git add libs/agent/src/graph/graph.service.ts apps/server-agent/src/services/runner.service.ts libs/types-agent/src/session.ts apps/web-agent/src/app/session/page.tsx
git commit -m "$(cat <<'EOF'
fix(agent): inflight 携带 reasoningStartedAt，刷新时思考计时器不再从刷新时刻起算

Bug：刷新落在 reasoning 流式中，标签显示「思考中 41.0s」一路涨。
根因：page.tsx onReasoning handler 用 `?? Date.now()` 兜底 existing.reasoningStartedAt，
ws replay 时把 startedAt 设到刷新时刻，elapsed 从那一刻起算。

修复：服务端 InflightRun + InflightView + types-agent schema 加 reasoningStartedAt；
runner 在本轮首个 reasoning chunk 时记 Date.now()，轮切换时重置。
前端 inflight push 透传该字段，onReasoning 不再现取 Date.now() 兜底。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Bug 2/3 — graph.service 切多 mode、supervisor update 即触发 flushRound

### Step 1: 写更真实的失败用例（旧用例改名 + 让 echoTool sleep）

- [ ] **Step 1.1: 修改现有的 vitest 用例**

In [libs/agent/tests/unit/graph.service.test.ts](../../../libs/agent/tests/unit/graph.service.test.ts) 找 `it("ToolMessage 边界即 flushRound...")`。

把 echoTool 的 execute 改成异步 sleep 300ms：

```ts
const echoTool: MeshbotTool<{ x: string }, string> = {
  name: "echo",
  description: "echo back",
  schema: z.object({ x: z.string() }),
  async execute(args) {
    // 模拟慢 tool（真实场景 MCP / 浏览器调用可能 30s+）
    // 用 300ms 即可暴露「flush 等到 tools 节点 return 才触发」的 bug
    await new Promise((r) => setTimeout(r, 300));
    return `echoed: ${args.x}`;
  },
};
```

把第二轮 200ms sleep 删掉（不需要——slow tool 已经能拉开时间差）：

```ts
const toolCallingModel = {
  stream: async () => {
    streamCall += 1;
    if (streamCall === 1) {
      async function* gen() {
        yield new AIMessageChunk({
          id: "msg-A",
          content: "",
          tool_calls: [{ id: "tc-A", name: "echo", args: { x: "hi" } }],
        });
      }
      return gen();
    }
    round2StartedAt = Date.now();
    async function* gen() {
      yield new AIMessageChunk({ id: "msg-B", content: "好" });
    }
    return gen();
  },
};
```

把 `let toolFinishedAt = 0;` 加到测试顶部，echoTool 的 execute 里 `toolFinishedAt = Date.now()` resolve 前赋值：

```ts
async execute(args) {
  await new Promise((r) => setTimeout(r, 300));
  toolFinishedAt = Date.now();
  return `echoed: ${args.x}`;
},
```

断言改为：assistant_done(A) 必须在 tool 完成之前 yield。

```ts
const adA = events.find(
  (e) => e.kind === "assistant_done" && e.messageId === "msg-A",
);
expect(adA).toBeTruthy();
// 关键断言：assistant_done(A) 必须在 tool 完成之前 yield
// 修复前：flush 等 ToolMessage 进 stream（tool resolve 之后）→ adA.t ≥ toolFinishedAt
// 修复后：supervisor update 立即触发 flush → adA.t < toolFinishedAt
expect(adA!.t).toBeLessThan(toolFinishedAt);
```

测试名改成更准确的：

```ts
it("supervisor 节点退出即 flushRound（assistant_done(A) 不等 tool 执行结束）", ...);
```

- [ ] **Step 1.2: 跑测试确认失败**

Run: `cd /Users/grant/Meta1/meshbot/libs/agent && pnpm vitest run graph.service 2>&1 | tail -25`
Expected: 新断言失败——`adA.t` 实测会 ≥ `toolFinishedAt`（约 300ms 后），不再小于。

### Step 2: 改 runGraphStream 用多 mode

- [ ] **Step 2.1: 改 graph.stream 配置**

In [libs/agent/src/graph/graph.service.ts](../../../libs/agent/src/graph/graph.service.ts) `runGraphStream` 中找 `await this.graph.stream(input, { streamMode: "messages", ... })`。

改为：

```ts
const stream = await this.graph.stream(input, {
  configurable: { thread_id: threadId },
  streamMode: ["messages", "updates"] as const,
  signal,
  recursionLimit: resolveRecursionLimit(),
});
```

LangGraph 在多 mode 下每个 yield 是 `[mode, payload]` 元组（`PregelOutputType = any`）。

- [ ] **Step 2.2: 重写 for-await 循环以区分 mode**

原循环开头：

```ts
for await (const part of stream) {
  const msg = Array.isArray(part) ? part[0] : part;
  if (!(msg instanceof AIMessageChunk)) {
    if (currentId !== null && currentAcc !== undefined) {
      yield* flushRound();
      currentAcc = undefined;
      currentId = null;
      currentRoundStartedAt = Date.now();
    }
    continue;
  }
  ...
}
```

改为：

```ts
for await (const part of stream) {
  // 多 mode 流：每个 yield 是 [mode, payload]
  // mode === "messages" → payload = [BaseMessage, metadata]
  // mode === "updates" → payload = { nodeName: stateUpdate }
  if (!Array.isArray(part) || part.length !== 2) {
    // 未知 yield 形状，跳过（防御性）
    continue;
  }
  const [mode, payload] = part as [string, unknown];

  if (mode === "updates") {
    // supervisor 节点 return → 立即 flush 这一轮 assistant，避免等到 tools
    // 跑完 ToolMessage 进 stream 才 flush（慢 tool 几十秒空窗，刷新页面看不到）。
    const updates = payload as Record<string, unknown>;
    if (updates && "supervisor" in updates) {
      if (currentId !== null && currentAcc !== undefined) {
        yield* flushRound();
        currentAcc = undefined;
        currentId = null;
        currentRoundStartedAt = Date.now();
      }
    }
    continue;
  }

  if (mode !== "messages") continue;

  // messages 模式：payload = [BaseMessage, metadata] 元组
  const messagePart = payload as unknown[];
  const msg = Array.isArray(messagePart) ? messagePart[0] : messagePart;
  if (!(msg instanceof AIMessageChunk)) {
    // ToolMessage 等非 AIMessageChunk：上面 updates 路径已经把 supervisor 出口
    // flush 过了；这里保留为 backup 兜底，防 updates 事件意外缺失。
    if (currentId !== null && currentAcc !== undefined) {
      yield* flushRound();
      currentAcc = undefined;
      currentId = null;
      currentRoundStartedAt = Date.now();
    }
    continue;
  }
  // 之后的 AIMessageChunk 处理与原来一致
  const messageId = msg.id ?? randomUUID();
  if (currentId !== null && currentId !== messageId) {
    yield* flushRound();
    currentAcc = undefined;
    currentRoundStartedAt = Date.now();
  }
  // ...（之后所有 reasoning/chunk 处理保持不变）
}
```

注意：从 `messageId = msg.id ?? randomUUID()` 开始的所有逻辑保持不动。只是 for-await 入口和 mode 判定加了一层。

- [ ] **Step 2.3: 跑新测试确认通过**

Run: `cd /Users/grant/Meta1/meshbot/libs/agent && pnpm vitest run graph.service 2>&1 | tail -25`
Expected: "supervisor 节点退出即 flushRound" 测试 PASS。原有挂的 3 个不变。

- [ ] **Step 2.4: libs/agent 全套**

Run: `cd /Users/grant/Meta1/meshbot/libs/agent && pnpm vitest run 2>&1 | tail -5`
Expected: passed 数跟之前一致或+0（测试名变了不会新增），failed 不变。

### Step 3: typecheck + 围栏 + commit

- [ ] **Step 3.1: typecheck**

Run: `cd /Users/grant/Meta1/meshbot && pnpm typecheck 2>&1 | tail -5`
Expected: 0 error。

- [ ] **Step 3.2: 围栏**

Run: `cd /Users/grant/Meta1/meshbot && pnpm check 2>&1 | tail -10`
Expected: 全过。

- [ ] **Step 3.3: commit**

```bash
cd /Users/grant/Meta1/meshbot
git add libs/agent/src/graph/graph.service.ts libs/agent/tests/unit/graph.service.test.ts
git commit -m "$(cat <<'EOF'
fix(agent): graph stream 切 [messages,updates]，supervisor 出口即 flushRound

前次 Task 3 的修复假设错了：ToolMessage 进 stream 其实是 tools 节点 return
之后（要等 tool.execute() resolve）。慢 tool（30s MCP）跑期间 ToolMessage
不在 stream 里，flushRound 不触发，assistant 没入库——刷新页面看不到整轮。
原测试 echoTool 同步立即返回，掩盖了这个真相。

修复：runGraphStream 改用 streamMode:["messages","updates"]，LangGraph 在
supervisor 节点 return 时 emit updates 事件，此时 tools 还没跑，立即 flush
即可让 assistant 早早入库。ToolMessage 触发保留为兜底。

测试改为：echoTool sleep 300ms + 断言 assistant_done(A) 在 toolFinishedAt
之前 yield，能真实抓住慢 tool 场景的 flush 时机。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: 集成手测 + 八时机回归

**Files:** 无代码改动。

- [ ] **Step 1: 启 server-agent + web-agent**

```bash
pnpm dev:server-agent  # 终端 A
pnpm dev:web-agent     # 终端 B
```

- [ ] **Step 2: 时机 #5 验证（慢 tool 期间刷新）**

发一个会触发慢 MCP 工具（peekaboo browser 操作 / 30s 截图）的 prompt。在工具跑到一半时刷新。

Expected：
- 看到 user 气泡 + assistant 气泡（含 reasoning 已展开 + "思考中" 或合理 elapsed）+ 工具块 **running 转圈**（带 name / args）
- 工具完成后状态 running → ✓ 或 ✗ 自然过渡
- 后续轮次正常继续

**对比前次 plan 测试**：tool 跑期间整轮应**有内容**，不再消失。

- [ ] **Step 3: 时机 #2 验证（reasoning 流式中刷新）**

deepseek thinking 模型思考期间刷新。

Expected：
- reasoning 块默认展开
- 标签 "思考中 X.Xs"——X 是**真实经过的时间**（不是从刷新时刻 0 起算的 41 秒）。从刷新瞬间看到的值就是「截至刷新时刻的真实思考耗时」，之后正常累加
- 已收到 reasoning 文本完整可见

- [ ] **Step 4: 时机 #4 / #6 验证（轮间）**

在 tool 完、下轮 LLM TTFT 期间刷新（这个窗口短，可能不容易撞，能撞到最好）。

Expected：上一轮 assistant + tool 完成态完整可见；当前 inflight 是「即将开始下一轮」状态（不显示新 message 或显示 loading）。

- [ ] **Step 5: Bug A 回归**

同时开两个 session、各跑 tool。不串台。

- [ ] **Step 6: 跑围栏 + typecheck**

`pnpm check` 全过、`pnpm typecheck` 干净。

---

## 完成标准

- [ ] Task 1 + Task 2 commit 都落库
- [ ] `pnpm typecheck` 干净
- [ ] `pnpm check` 全过
- [ ] `pnpm --filter @meshbot/agent vitest run` passed 数 ≥ 128，failed 不变
- [ ] `pnpm --filter @meshbot/server-agent test` passed 数不退化
- [ ] 集成手测 #5 / #2 都符合预期，无 41s 计时器 bug、无整轮消失 bug
