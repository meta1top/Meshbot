# 刷新/切换会话时的「续上」保真度修复 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用户在 ReAct 多轮执行的任意时机刷新或切换会话，时间线视觉跟刷新前一致，后续推送从断点续接。

**Architecture:** 四处改动 — 后端把「轮 N 的 assistant」前移到 ToolMessage 边界即 persist；后端 history 渲染识别 orphan tool row 报 `running`；前端 ToolCallBlock 已支持 `running`（schema 拓宽即自动生效），ReasoningBlock 新增 `streaming` 优先级，刷新落在思考中时仍显示「思考中」+ 默认展开。不动 schema、不加新表。

**Tech Stack:** TypeScript (NestJS / Next.js / vitest 单测 / Jest 单测) · @langchain/langgraph · Zod schema 共享类型 · TypeORM (SQLite)

---

## 关联设计文档

[docs/superpowers/specs/2026-05-28-refresh-resume-fidelity-design.md](../specs/2026-05-28-refresh-resume-fidelity-design.md)

---

## File Structure

| 文件 | 类型 | 责任 |
|------|------|------|
| [libs/types-agent/src/session.ts](../../../libs/types-agent/src/session.ts) | 修改 | `HistoryToolCallSchema.status` 加 `"running"` |
| [apps/server-agent/src/controllers/session.controller.ts](../../../apps/server-agent/src/controllers/session.controller.ts) | 修改 | history 端 tool row 缺失时 status="running" |
| [apps/server-agent/src/controllers/session-history-status.ts](../../../apps/server-agent/src/controllers/session-history-status.ts) | 新建 | 抽出纯函数 `computeToolCallStatus` 供单测 |
| [apps/server-agent/src/controllers/session-history-status.spec.ts](../../../apps/server-agent/src/controllers/session-history-status.spec.ts) | 新建 | Jest 单测 |
| [libs/agent/src/graph/graph.service.ts](../../../libs/agent/src/graph/graph.service.ts) | 修改 | runGraphStream for-await 见 ToolMessage 触发 flushRound |
| [libs/agent/tests/unit/graph.service.test.ts](../../../libs/agent/tests/unit/graph.service.test.ts) | 修改 | 新增"flush 在 ToolMessage 边界发生而非等下一轮"的 vitest 单测 |
| [apps/web-agent/src/components/session/message-list.tsx](../../../apps/web-agent/src/components/session/message-list.tsx) | 修改 | ReasoningBlock 加 `streaming` prop；调用处传 `m.streaming` |

`tool-call-block.tsx` 不动 —— 已经支持 `status="running"` 渲染。`page.tsx` 也不动 —— inflight push 仍写 `reasoningDurationMs: 0`，由 ReasoningBlock 内部用 `streaming` 标记覆盖判断。

---

## Task 1: 把 `HistoryToolCallSchema.status` 拓宽到 `"running"`

**Files:**
- Modify: `libs/types-agent/src/session.ts:96`

- [ ] **Step 1: 跑现状基线测试**

Run: `cd /Users/grant/Meta1/meshbot/libs/types-agent && pnpm vitest run 2>&1 | tail -5`
Expected: 现有用例全过（或没有用例报告 0 passed）。这是基线。

- [ ] **Step 2: 修改 schema 枚举**

文件 [libs/types-agent/src/session.ts:96](../../../libs/types-agent/src/session.ts#L96)：

```ts
// 原
status: z.enum(["ok", "error"]),

// 改为
status: z.enum(["ok", "error", "running"]),
```

- [ ] **Step 3: 全工作区 typecheck（拓宽枚举不应引发新错）**

Run: `cd /Users/grant/Meta1/meshbot && pnpm typecheck 2>&1 | tail -10`
Expected: `Tasks: <N> successful, <N> total` 没有新 error。`ToolCallView` 在 [apps/web-agent/src/components/session/message-list.tsx:22](../../../apps/web-agent/src/components/session/message-list.tsx#L22) 本就声明 `"running" | "ok" | "error"`，拓宽 schema 后自然匹配。

- [ ] **Step 4: Commit**

```bash
cd /Users/grant/Meta1/meshbot
git add libs/types-agent/src/session.ts
git commit -m "$(cat <<'EOF'
feat(types-agent): HistoryToolCall.status 拓宽到 "running"

为 history 端报告"工具正在跑"（assistant 已 persist 但 tool 行还没到）做准备，
前端 ToolCallBlock 已支持 "running" 渲染，无需前端改动。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: 抽出 `computeToolCallStatus` 纯函数 + Jest 单测 + 控制器接入

**Files:**
- Create: `apps/server-agent/src/controllers/session-history-status.ts`
- Create: `apps/server-agent/src/controllers/session-history-status.spec.ts`
- Modify: `apps/server-agent/src/controllers/session.controller.ts:144-170`

### Step 1: 先写失败用例

- [ ] **Step 1: 写 Jest 失败用例**

新建 [apps/server-agent/src/controllers/session-history-status.spec.ts](../../../apps/server-agent/src/controllers/session-history-status.spec.ts)：

```ts
import { computeToolCallStatus } from "./session-history-status";

describe("computeToolCallStatus", () => {
  it("tool row 不存在 → running（assistant 已 persist 但 tool 还在跑）", () => {
    expect(computeToolCallStatus(undefined)).toBe("running");
  });

  it("tool row 存在、无 metadata → ok（成功，兼容老数据）", () => {
    expect(computeToolCallStatus({ metadata: null })).toBe("ok");
  });

  it("tool row 存在、metadata={ok:true} → ok", () => {
    expect(computeToolCallStatus({ metadata: JSON.stringify({ ok: true }) })).toBe(
      "ok",
    );
  });

  it("tool row 存在、metadata={ok:false} → error", () => {
    expect(computeToolCallStatus({ metadata: JSON.stringify({ ok: false }) })).toBe(
      "error",
    );
  });

  it("tool row 存在、metadata JSON 解析失败 → ok（防御性）", () => {
    expect(computeToolCallStatus({ metadata: "not-json-{{{" })).toBe("ok");
  });
});
```

- [ ] **Step 2: 确认失败**

Run: `cd /Users/grant/Meta1/meshbot && pnpm --filter @meshbot/server-agent exec jest --testPathPattern=session-history-status 2>&1 | tail -10`
Expected: `Cannot find module './session-history-status'`（实现文件还没有）。

### Step 2: 实现纯函数

- [ ] **Step 3: 实现 computeToolCallStatus**

新建 [apps/server-agent/src/controllers/session-history-status.ts](../../../apps/server-agent/src/controllers/session-history-status.ts)：

```ts
/**
 * 从 session_messages 的 tool row 推断单次工具调用的展示状态。
 *
 * - 没有 tool row（undefined）→ "running"：assistant 已 persist（含 tool_calls JSON）
 *   但 tool 还在执行 / 还没来得及 persist 结果。前端按此渲染转圈。
 * - tool row 存在、metadata.ok === false → "error"：tool 抛错或 zod 校验失败。
 * - 其余（metadata null / 解析失败 / ok===true） → "ok"：兼容老数据。
 *
 * 纯函数、不依赖 ORM 实体，便于单测覆盖三态分支。
 */
export function computeToolCallStatus(
  toolRow: { metadata: string | null } | undefined,
): "running" | "ok" | "error" {
  if (!toolRow) return "running";
  if (!toolRow.metadata) return "ok";
  try {
    const parsed = JSON.parse(toolRow.metadata) as { ok?: boolean };
    return parsed.ok === false ? "error" : "ok";
  } catch {
    return "ok";
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/grant/Meta1/meshbot && pnpm --filter @meshbot/server-agent exec jest --testPathPattern=session-history-status 2>&1 | tail -10`
Expected: `Tests: 5 passed`.

### Step 3: 控制器接入新函数

- [ ] **Step 5: 改 session.controller.ts 用新函数**

修改 [apps/server-agent/src/controllers/session.controller.ts:144-170](../../../apps/server-agent/src/controllers/session.controller.ts#L144-L170) 这段——把里面 `const trMeta = ...` 到 `const status = ...` 的 13 行逻辑全部替换为对纯函数的调用：

```ts
const toolCalls: HistoryToolCall[] = calls.map((c) => {
  const tr = toolByCallId.get(c.id);
  const status = computeToolCallStatus(tr);
  return {
    toolCallId: c.id,
    name: c.name,
    args: c.args,
    status,
    result: tr?.content ?? "",
  };
});
```

文件顶部加 import：

```ts
import { computeToolCallStatus } from "./session-history-status";
```

- [ ] **Step 6: 全工作区 typecheck**

Run: `cd /Users/grant/Meta1/meshbot && pnpm typecheck 2>&1 | tail -5`
Expected: 0 error。

- [ ] **Step 7: 跑 server-agent 整套单测**

Run: `cd /Users/grant/Meta1/meshbot && pnpm --filter @meshbot/server-agent test 2>&1 | tail -10`
Expected: 全过，包含新增 5 个 status 用例。

- [ ] **Step 8: Commit**

```bash
cd /Users/grant/Meta1/meshbot
git add apps/server-agent/src/controllers/session-history-status.ts \
        apps/server-agent/src/controllers/session-history-status.spec.ts \
        apps/server-agent/src/controllers/session.controller.ts
git commit -m "$(cat <<'EOF'
feat(server-agent): history 端 orphan tool row 报 "running"

session_messages 里 tool row 缺失 → assistant 已 persist 但工具还在跑
（或还没来得及写结果）。抽出 computeToolCallStatus 纯函数 + 5 个分支单测。
前端 ToolCallBlock 已识别 "running"，自动展示转圈。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: graph.service 见到 ToolMessage 触发 flushRound

**Files:**
- Modify: `libs/agent/src/graph/graph.service.ts:495-520`（for-await 循环开头那段）
- Modify: `libs/agent/tests/unit/graph.service.test.ts`（加新用例）

### Step 1: 写失败的 vitest 用例

- [ ] **Step 1: 增强 fakeModel 让它两轮一轮带 tool_calls**

修改 [libs/agent/tests/unit/graph.service.test.ts](../../../libs/agent/tests/unit/graph.service.test.ts) 的 beforeEach 顶部 `streamCall` 闭包模型，让它支持「轮 1 出 tool_calls、轮 2 出终答（并故意延迟 200ms 模拟 LLM TTFT）」。在原 `fakeModel` 旁边新增一个用于本测试的工厂；不要破坏原有 6 个用例，新增工厂 `makeToolCallingModel()`，然后写新 it：

在文件末尾 `describe("GraphService", ...)` 之内追加：

```ts
  it("ToolMessage 边界即 flushRound（assistant_done(A) 不等下一轮 LLM 启动）", async () => {
    // 重新构造一个会两轮跑、且第二轮故意延迟 200ms 的 GraphService
    // -- 让我们能在时间维度上区分「flush 在 ToolMessage 边界（修复后）」
    //    vs「flush 等下一轮第一个 chunk（修复前）」
    let streamCall = 0;
    let round2StartedAt = 0;
    const echoTool: import("../../src/tools/tool.types").MeshbotTool<
      { x: string },
      string
    > = {
      name: "echo",
      description: "echo back",
      schema: (await import("zod")).z.object({ x: (await import("zod")).z.string() }),
      async execute(args) {
        return `echoed: ${args.x}`;
      },
    };
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
        await new Promise((r) => setTimeout(r, 200));
        async function* gen() {
          yield new AIMessageChunk({ id: "msg-B", content: "好" });
        }
        return gen();
      },
    };
    const fakeDisc = {
      getProviders: () => [{ instance: echoTool }] as never,
    };
    const toolRegistry2 = new (
      await import("../../src/tools/tool-registry")
    ).ToolRegistry(fakeDisc as never);
    toolRegistry2.onModuleInit();
    const configService = new MeshbotConfigService();
    (configService as unknown as Record<string, string>).meshbotDir = testDir;
    const gs = new GraphService(
      configService,
      new PromptService(testDir),
      toolRegistry2,
      new EventEmitter2(),
      () => Promise.resolve(toolCallingModel as never),
      { providerType: "fake", model: "fake-model" },
    );
    const threadId = await gs.startSession({ model: "fake" });
    const events: Array<{ kind: string; messageId: string; t: number }> = [];
    for await (const ev of gs.streamMessage(threadId, [
      { id: "pm-1", content: "hi" },
    ])) {
      events.push({
        kind: ev.kind,
        messageId: (ev as { messageId?: string }).messageId ?? "",
        t: Date.now(),
      });
    }
    const adA = events.find(
      (e) => e.kind === "assistant_done" && e.messageId === "msg-A",
    );
    expect(adA).toBeTruthy();
    // 关键断言：assistant_done(A) 必须在「第二轮 LLM 开始 200ms 延迟之前」就 yield 出来
    // 修复前：assistant_done(A) 要等第二轮 stream 出第一个 chunk → adA.t ≥ round2StartedAt + 200
    // 修复后：assistant_done(A) 在 ToolMessage 边界即 yield → adA.t ≤ round2StartedAt + 50（容忍误差）
    expect(adA!.t).toBeLessThan(round2StartedAt + 100);
  });
```

注：动态 import `zod` / `ToolRegistry` 用 await import() 是为了 keep test 文件不引入新的 top-level import，减少与原 imports 顺序的冲突；如果觉得乱，task 实施时可以提到文件顶部。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/grant/Meta1/meshbot/libs/agent && pnpm vitest run graph.service 2>&1 | tail -20`
Expected: 新增的 "ToolMessage 边界即 flushRound" 用例 fail，断言 `adA.t < round2StartedAt + 100` 不成立（实测会接近 round2StartedAt + 200）。

注：原有 3 个挂的用例（streamMessage 逐 chunk / resume / usage）跟本任务无关，保持原状不管。

### Step 2: 实现 flush 触发

- [ ] **Step 3: 改 runGraphStream 的 for-await 循环**

文件 [libs/agent/src/graph/graph.service.ts](../../../libs/agent/src/graph/graph.service.ts)，找到 `runGraphStream` 里的 for-await 循环（大致 L495-L520 区域，以 `for await (const part of stream)` 为锚）：

原代码：

```ts
for await (const part of stream) {
  // streamMode:"messages" 产出 [BaseMessage, metadata] 元组
  const msg = Array.isArray(part) ? part[0] : part;
  if (!(msg instanceof AIMessageChunk)) continue;
  const messageId = msg.id ?? randomUUID();
  // 轮次切换：flush 上一轮，重置累加
  if (currentId !== null && currentId !== messageId) {
    yield* flushRound();
    currentAcc = undefined;
    currentRoundStartedAt = Date.now();
  }
  // …
}
```

改为：

```ts
for await (const part of stream) {
  // streamMode:"messages" 产出 [BaseMessage, metadata] 元组
  const msg = Array.isArray(part) ? part[0] : part;
  if (!(msg instanceof AIMessageChunk)) {
    // tools 节点产出 ToolMessage（及任何非 AIMessageChunk 的消息）出现在 stream 里
    // → supervisor 节点必然已退出 → 立即 flush 当前累加的 assistant，让 runner 早早
    //   recordAssistant 落库。否则要等下一轮第一个 chunk 才 flush，期间 tool 在跑
    //   （可能几十秒），刷新页面看不到这一轮的 assistant + 孤儿 tool。
    if (currentId !== null && currentAcc !== undefined) {
      yield* flushRound();
      currentAcc = undefined;
      currentId = null;
      currentRoundStartedAt = Date.now();
    }
    continue;
  }
  const messageId = msg.id ?? randomUUID();
  // 轮次切换：flush 上一轮，重置累加（保留这条分支兜底——理论上 ToolMessage 边界
  // 已 flush 过、currentId=null；但 supervisor 终答→END 不经 tools 时仍可能命中）
  if (currentId !== null && currentId !== messageId) {
    yield* flushRound();
    currentAcc = undefined;
    currentRoundStartedAt = Date.now();
  }
  // …（后续与原代码一致）
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/grant/Meta1/meshbot/libs/agent && pnpm vitest run graph.service 2>&1 | tail -20`
Expected: "ToolMessage 边界即 flushRound" 用例 PASS。原有挂的 3 个跟本任务无关，保持原状。新增用例必须过。

- [ ] **Step 5: 跑 libs/agent 全套单测确认无回归**

Run: `cd /Users/grant/Meta1/meshbot/libs/agent && pnpm vitest run 2>&1 | tail -5`
Expected: 总数比之前多 1 个 passed（新增的 ToolMessage flush 用例）；fail 数不变（仍是历史挂的 7 个）。

- [ ] **Step 6: 全 typecheck**

Run: `cd /Users/grant/Meta1/meshbot && pnpm typecheck 2>&1 | tail -5`
Expected: 0 error。

- [ ] **Step 7: Commit**

```bash
cd /Users/grant/Meta1/meshbot
git add libs/agent/src/graph/graph.service.ts libs/agent/tests/unit/graph.service.test.ts
git commit -m "$(cat <<'EOF'
fix(agent): ToolMessage 进 stream 即 flushRound，assistant 不再滞后到下一轮

修复前：每轮 LLM 完成后 assistant_done 要等下一轮第一个 chunk 才 yield，
其间 tool 在跑（可能几十秒），session_messages 里这轮 assistant 没行
→ 刷新页面看不到这轮 assistant + 孤儿 tool row 直接不可见。

修复后：for-await 见到 ToolMessage（非 AIMessageChunk）时 supervisor 必已退出，
立即 flushRound() → recordAssistant 早早落库。

新增 vitest 单测：用故意延迟 200ms 的第二轮 LLM 验证 assistant_done(轮1)
不再被「下一轮 LLM TTFT」拖延。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: ReasoningBlock 看 streaming 标记走「思考中」+ 默认展开

**Files:**
- Modify: `apps/web-agent/src/components/session/message-list.tsx:122-128, 225-256`

注：前端 message-list 用 React 没单测基建，本任务靠 typecheck + 手测验证。代码改动很小、行为可视。

- [ ] **Step 1: 给 ReasoningBlock 加 `streaming` prop**

修改 [apps/web-agent/src/components/session/message-list.tsx:225-256](../../../apps/web-agent/src/components/session/message-list.tsx#L225-L256)：

原 signature：

```ts
function ReasoningBlock({
  text,
  startedAt,
  durationMs,
}: {
  text: string;
  startedAt?: number;
  durationMs?: number;
}) {
```

改为：

```ts
function ReasoningBlock({
  text,
  startedAt,
  durationMs,
  streaming,
}: {
  text: string;
  startedAt?: number;
  durationMs?: number;
  /**
   * 父 message 是否在流式中（来自 inflight push 或 ws onChunk 标记）。
   * 为 true 时强制走「思考中」分支 + 默认展开，无视 durationMs ——
   * 刷新落在 reasoning 流式中时 durationMs=0 会被误判为「已思考」，
   * 此 prop 是首要语义信号。
   */
  streaming?: boolean;
}) {
```

`isThinking` 行修改：

```ts
// 原
const isThinking = durationMs === undefined && startedAt !== undefined;

// 改为：streaming 优先；否则保留原 durationMs/startedAt 推断
const isThinking =
  streaming === true ||
  (durationMs === undefined && startedAt !== undefined);
```

`elapsed` 行兜底（startedAt 缺失时不让 elapsed 算成负数巨值）：

```ts
// 原
const elapsed = isThinking
  ? Date.now() - (startedAt ?? Date.now())
  : (durationMs ?? 0);

// 改为
const elapsed = isThinking
  ? startedAt !== undefined
    ? Date.now() - startedAt
    : 0
  : (durationMs ?? 0);
```

`label` 的 fallback：当 `isThinking && elapsed === 0`（刷新场景 startedAt 没传）时显示无秒数的「思考中」。

```ts
// 原
const label = isThinking
  ? t("reasoningThinking", { seconds: (elapsed / 1000).toFixed(1) })
  : elapsed > 0
    ? t("reasoningThought", { seconds: (elapsed / 1000).toFixed(1) })
    : t("reasoningProcess");

// 改为
const label = isThinking
  ? elapsed > 0
    ? t("reasoningThinking", { seconds: (elapsed / 1000).toFixed(1) })
    : t("reasoningThinking", { seconds: "0.0" })  // fallback：刷新场景没 startedAt
  : elapsed > 0
    ? t("reasoningThought", { seconds: (elapsed / 1000).toFixed(1) })
    : t("reasoningProcess");
```

注：若 `reasoningThinking` 翻译 key 强制要求 `seconds` 参数，给个 "0.0" 字符串即可；调用方读到「思考中 0.0s」可接受。

- [ ] **Step 2: 调用处把 `m.streaming` 透传给 ReasoningBlock**

修改 [apps/web-agent/src/components/session/message-list.tsx:122-128](../../../apps/web-agent/src/components/session/message-list.tsx#L122-L128)：

```tsx
// 原
{m.role === "assistant" && m.reasoning ? (
  <ReasoningBlock
    text={m.reasoning}
    startedAt={m.reasoningStartedAt}
    durationMs={m.reasoningDurationMs}
  />
) : null}

// 改为
{m.role === "assistant" && m.reasoning ? (
  <ReasoningBlock
    text={m.reasoning}
    startedAt={m.reasoningStartedAt}
    durationMs={m.reasoningDurationMs}
    streaming={m.streaming}
  />
) : null}
```

- [ ] **Step 3: typecheck web-agent**

Run: `cd /Users/grant/Meta1/meshbot && pnpm --filter @meshbot/web-agent typecheck 2>&1 | tail -5`
Expected: 0 error.

- [ ] **Step 4: 全围栏**

Run: `cd /Users/grant/Meta1/meshbot && pnpm check 2>&1 | tail -10`
Expected: 全过、无新增 finding。

- [ ] **Step 5: Commit**

```bash
cd /Users/grant/Meta1/meshbot
git add apps/web-agent/src/components/session/message-list.tsx
git commit -m "$(cat <<'EOF'
fix(web-agent): ReasoningBlock 看 streaming 标记，刷新落在思考中仍显「思考中」+ 默认展开

刷新页面时 inflight 把 reasoning push 进时间线 + reasoningDurationMs:0，
原 ReasoningBlock 把 durationMs!==undefined 当作「思考已结束」→ 标签变「已思考」
默认收起。

加 streaming?: boolean prop，true 时强制走「思考中」分支 + 默认展开，
无视 durationMs。startedAt 缺失（刷新场景）时 fallback「思考中 0.0s」。
调用处把 m.streaming 透传过来。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: 集成手测 + 八个时机回归

**Files:** 无代码改动。本任务只是「跑起来手测」+ 抓 log 验证。

- [ ] **Step 1: 启 server-agent + web-agent**

```bash
cd /Users/grant/Meta1/meshbot
# 终端 A
pnpm dev:server-agent
# 终端 B
pnpm dev:web-agent
```

- [ ] **Step 2: 准备一个会触发 ReAct 多轮的 prompt**

在 web-agent 打开会话，发：「列出 Chrome 中打开的页面，然后告诉我有几个」（前提：Chrome 开了 remote debugging + peekaboo MCP 配好）。Agent 会调 `browser` + `list_pages`，至少 2 轮 tool。

- [ ] **Step 3: 时机 #4 验证 — tool 还没启动时刷新**

观察服务端日志，看到 LLM 第一轮 stream 结束、`recordAssistant` 即将触发时，立即按 Cmd+R 刷新。

Expected：
- 刷新后立即看到 user 气泡、assistant 气泡（即便 content 为空也有 reasoning 区块）+ 第一个工具调用的 running 转圈状态（带工具名 + args 摘要）
- 几秒后工具执行完，状态从 running → ✓ 或 ✗ 自然过渡

- [ ] **Step 4: 时机 #5 验证 — tool 跑到一半时刷新**

agent 调一个慢工具（30s+ 的 MCP 截图）。在 tool 跑到一半时刷新。

Expected：
- 刷新后看到完整 assistant + 工具 running 状态
- 工具结束后状态自然过渡，content 出现

- [ ] **Step 5: 时机 #2 验证 — reasoning 流式中刷新**

deepseek thinking 模型在思考中（看 ws onReasoning 事件累加）时刷新。

Expected：
- reasoning 块默认展开
- 标签显示「思考中 0.0s」或类似（startedAt 没传，时长 0）
- 已收到的思考文本完整可见
- 后续 reasoning token 通过 WS 续接累加

- [ ] **Step 6: Bug A 回归 — 两 session 并发**

同时开两个 session，各自发一个会调工具的 prompt。Expected：两个会话的工具调用各归各显示，不串台。

- [ ] **Step 7: 跑完整围栏**

Run: `cd /Users/grant/Meta1/meshbot && pnpm check 2>&1 | tail -10`
Expected: 全过。

Run: `cd /Users/grant/Meta1/meshbot && pnpm typecheck 2>&1 | tail -5`
Expected: 0 error。

- [ ] **Step 8: 如果手测发现新缺口，单独开新 issue/plan**

本计划只 cover 设计文档列的八个时机。如果手测发现 abort / interrupted / 压缩边界等场景刷新行为还有问题，不在本计划范围；记录下来另开 plan。

---

## 完成标准

- [ ] 所有四个 Task 的 commit 都已落库
- [ ] `pnpm typecheck` 全工作区干净
- [ ] `pnpm check` 围栏全过
- [ ] `pnpm --filter @meshbot/agent vitest run` 总数比之前多 1 passed（新增 ToolMessage flush 用例），fail 不变
- [ ] `pnpm --filter @meshbot/server-agent test` 通过、新增 5 个 status 用例都过
- [ ] 集成手测的 4 个时机 (#2, #4, #5, Bug A) 都符合期望
