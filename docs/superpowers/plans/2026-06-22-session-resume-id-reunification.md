# 会话续传 id 收口（雪花贯穿全链路）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让雪花成为一条逻辑消息在 checkpointer / `session_messages` / WS 事件三处唯一一致的 id，修复「思考完毕→工具长执行→刷新」时出现的重复「思考中」气泡 + 持续计时回归。

**Architecture:** 服务端为每条 assistant AIMessage 铸雪花并注入 supervisor 节点（checkpointer 直接存雪花）与事件流（所有 `run.*` 事件用同一雪花）；前端为 human 生成雪花；`session_messages.id` 落库改用该雪花（=langgraphId）；Runner 增「本轮已落库」标志，已落库轮不再作为活 inflight partial 吐出。

**Tech Stack:** NestJS（server-agent）、LangGraph（libs/agent）、TypeORM + SQLite、Next.js（web-agent）、Jest（server-agent）、vitest（libs/agent）。

**关联文档：** [设计文档](../specs/2026-06-22-session-resume-id-reunification-design.md) · [2026-05-28 resume 保真度](../specs/2026-05-28-refresh-resume-fidelity-design.md) · [2026-06-18 雪花 PK](../specs/2026-06-18-snowflake-primary-keys-design.md)

## Global Constraints

- 中文 JSDoc（公开方法）；中文 commit（conventional commits）。
- 不改 schema（不加列、不删 `langgraph_id`）；不写新迁移（dev 库清空重建，沿用 2026-06-18 前提）。
- 排序唯一可靠键是 `session_messages.seq`，与 `id` 取值无关——改 `id` 取值不得影响分页。
- 不动 compaction / run error / interrupted 刷新路径。
- 提交前 `pnpm typecheck` 干净、`pnpm check` 全过。
- `generateSnowflakeId` 来自 `@meshbot/common`（依赖方向 agent→common 合法）。

**修复闭环判定：** 截图 bug 在 Task 3（assistant 表 id 收口）+ Task 6（partial 抑制）落地后消除；Task 1-2 是 assistant 雪花贯穿的前置；Task 5 收口 human 侧。Task 7 为可选硬化。

---

### Task 1: supervisor 节点把 AIMessage.id 设为注入的雪花

**Files:**
- Modify: `libs/agent/src/graph/nodes/supervisor.node.ts`
- Test: `libs/agent/src/graph/nodes/supervisor.node.spec.ts`（新建或追加）

**Interfaces:**
- Produces: `createSupervisorNode(modelProvider, toolsProvider, resolveMessageId: (modelId: string) => string)` —— 第三参把模型生成的 AIMessage id 映射为我方雪花；节点返回的 AIMessage `id` 即该雪花。

- [ ] **Step 1: 写失败测试**

```ts
// supervisor.node.spec.ts
import { AIMessageChunk } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { createSupervisorNode } from "./supervisor.node";

function fakeModel(chunks: AIMessageChunk[]) {
  return {
    bindTools() { return this; },
    async stream() {
      return (async function* () { for (const c of chunks) yield c; })();
    },
  } as unknown as Awaited<ReturnType<import("./supervisor.node").ModelProvider>>;
}

describe("createSupervisorNode", () => {
  it("把累加 AIMessage 的 id 替换成 resolveMessageId 返回的雪花", async () => {
    const chunk = new AIMessageChunk({ content: "你好", id: "model-uuid-1" });
    const node = createSupervisorNode(
      async () => fakeModel([chunk]),
      () => [],
      (modelId) => (modelId === "model-uuid-1" ? "900000000000000001" : "x"),
    );
    const out = await node({ messages: [] });
    expect(out.messages?.[0]?.id).toBe("900000000000000001");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @meshbot/agent test supervisor.node`
Expected: FAIL（`createSupervisorNode` 仅接受 2 参 / id 仍为 `model-uuid-1`）

- [ ] **Step 3: 改实现**

`supervisor.node.ts`：函数签名加第三参，重建 AIMessage 时用映射后的 id。

```ts
export function createSupervisorNode(
  modelProvider: ModelProvider,
  toolsProvider: ToolsProvider,
  resolveMessageId: (modelId: string) => string,
) {
  return async function supervisorNode(
    state: SupervisorState,
  ): Promise<Partial<SupervisorState>> {
    // ...（中段不变，累加得到 accumulated）...
    const clean = new AIMessage({
      content: accumulated.content,
      tool_calls: accumulated.tool_calls,
      additional_kwargs: cleanKwargs,
      response_metadata: accumulated.response_metadata,
      // 模型生成的 UUID 映射为我方雪花：checkpointer 直接存雪花，
      // 与事件流 / session_messages 三处 id 收口一致。
      id: resolveMessageId(accumulated.id ?? ""),
      name: accumulated.name,
      usage_metadata: accumulated.usage_metadata,
    });
    return { messages: [clean] };
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @meshbot/agent test supervisor.node`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add libs/agent/src/graph/nodes/supervisor.node.ts libs/agent/src/graph/nodes/supervisor.node.spec.ts
git commit -m "feat(agent): supervisor 节点 AIMessage id 经 resolveMessageId 收口为雪花"
```

---

### Task 2: GraphService 注入 resolveMessageId，事件流用同一雪花

**Files:**
- Modify: `libs/agent/src/graph/graph.builder.ts`（`buildSupervisorGraph` 加形参透传）
- Modify: `libs/agent/src/graph/graph.service.ts`（持有 map + resolveMessageId；`runGraphStream` 事件用雪花；wire 进 `buildSupervisorGraph`）
- Test: `libs/agent/src/graph/graph.service.spec.ts`（追加）

**Interfaces:**
- Consumes: Task 1 的 `createSupervisorNode(..., resolveMessageId)`。
- Produces: `runGraphStream` 内一轮的所有 yield（`reasoning` / `chunk` / `reasoning_done` / `tool_calls` / `assistant_done` / `usage`）的 `messageId` 均为 `resolveMessageId(模型UUID)`；与节点写入 checkpointer 的 id 相同。

- [ ] **Step 1: 写失败测试**

在 `graph.service.spec.ts` 追加（沿用该文件既有的 fake graph / streamMode 注入方式）：

```ts
it("runGraphStream：同一轮所有事件 messageId 收口为雪花（非模型UUID）", async () => {
  // 用既有 harness 构造一个 fake graph.stream：
  //   ["messages",[AIMessageChunk{ id:"model-uuid-1", content:"hi" }]]
  //   ["updates",{ supervisor:{ messages:[...] } }]
  // resolveMessageId 固定映射 model-uuid-1 -> "900000000000000001"
  const events = await collectStreamMessage(/* ... */);
  const ids = new Set(
    events.filter((e) => "messageId" in e).map((e) => (e as { messageId: string }).messageId),
  );
  expect(ids).toEqual(new Set(["900000000000000001"]));
  expect(ids.has("model-uuid-1")).toBe(false);
});
```

> 注：`collectStreamMessage` / fake graph 注入按 `graph.service.spec.ts` 既有写法适配；断言核心是「事件 messageId 全为映射后的雪花」。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @meshbot/agent test graph.service`
Expected: FAIL（事件仍带 `model-uuid-1`）

- [ ] **Step 3: 改实现**

`graph.service.ts`：

```ts
// 类字段（构造区附近）
/** 模型生成的 AIMessage UUID -> 我方雪花。node 与 runGraphStream 共享，保证一致。 */
private readonly msgIdMap = new Map<string, string>();

/** 取/建某条 AIMessage 的雪花 id（get-or-create，幂等）。 */
private readonly resolveMessageId = (modelId: string): string => {
  let s = this.msgIdMap.get(modelId);
  if (!s) {
    s = generateSnowflakeId();
    this.msgIdMap.set(modelId, s);
  }
  return s;
};
```

`accountGraph()` 里 `buildSupervisorGraph(...)` 增传 `this.resolveMessageId`：

```ts
const graph = buildSupervisorGraph(
  checkpointer,
  this.modelProvider,
  this.toolRegistry,
  this.eventEmitter,
  this.resolveMessageId,
);
```

`graph.builder.ts`：`buildSupervisorGraph` 加形参并透传给 `createSupervisorNode`：

```ts
export function buildSupervisorGraph(
  checkpointer: SqliteSaver,
  modelProvider: ModelProvider,
  registry: ToolRegistry,
  emitter: EventEmitter2,
  resolveMessageId: (modelId: string) => string,
) {
  const supervisor = createSupervisorNode(
    modelProvider,
    () => registry.asLangChainBindable(),
    resolveMessageId,
  );
  // ...（其余不变）
}
```

`runGraphStream`（[graph.service.ts:485+](../../../libs/agent/src/graph/graph.service.ts#L485)）：每轮拿到 `messageId`（即 `msg.id ?? randomUUID()`）后立即 `const sid = this.resolveMessageId(messageId)`，本轮所有 `yield {{ ... messageId }}` 改用 `sid`；`flushRound` 闭包内同理（闭包捕获当前轮的 `sid`，把 `tool_calls`/`assistant_done`/`usage` 的 `messageId: currentId` 改为 `messageId: currentSid`）。轮切换时连同 `currentSid` 一起重置。run 结束（方法尾部）清理本 run 见过的 UUID：`for (const id of seenModelIds) this.msgIdMap.delete(id)`（用一个局部 `Set<string>` 收集本 run 出现过的 `messageId`）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @meshbot/agent test graph.service`
Expected: PASS（同时既有 graph.service 用例不回归）

- [ ] **Step 5: 提交**

```bash
git add libs/agent/src/graph/graph.builder.ts libs/agent/src/graph/graph.service.ts libs/agent/src/graph/graph.service.spec.ts
git commit -m "feat(agent): runGraphStream 事件与 checkpointer 共享雪花 messageId（resolveMessageId 收口）"
```

---

### Task 3: session_messages.id 落库收口到 langgraphId（雪花）

**Files:**
- Modify: `apps/server-agent/src/services/session-message.service.ts`（`insertWithSeq` 的 `id` 取值）
- Test: `apps/server-agent/src/services/session-message.service.spec.ts`（新建或追加；按本仓 Jest + sqlite repo 既有写法）

**Interfaces:**
- Consumes: Task 2 后 `recordAssistant` 收到的 `input.id` 为雪花。
- Produces: `session_messages.id === langgraph_id === input.id`（assistant 为 Task 2 的雪花；human 为 Task 5 的雪花；过渡期为既有 UUID 也保持一致）。

- [ ] **Step 1: 写失败测试**

```ts
it("recordAssistant：session_messages.id 等于传入的 langgraphId（不再另铸雪花）", async () => {
  await service.recordAssistant({
    id: "900000000000000123",
    sessionId: "s1",
    content: "hi",
    reasoning: null,
    toolCalls: null,
  });
  const page = await service.listPage("s1", { limit: 10 });
  const row = page.messages.find((m) => m.langgraphId === "900000000000000123");
  expect(row?.id).toBe("900000000000000123");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter server-agent test session-message.service`
Expected: FAIL（`row.id` 是另铸的雪花，≠ langgraphId）

- [ ] **Step 3: 改实现**

`insertWithSeq`（[session-message.service.ts:99-114](../../../apps/server-agent/src/services/session-message.service.ts#L99)）把 `id: generateSnowflakeId()` 改为用 langgraphId（恒由调用方传入；保留兜底）：

```ts
.values({
  ...row,
  // id 收口到 langgraphId：与 checkpointer / 事件流三处一致，去重/合并才正确。
  // 排序仍由 seq 负责，与 id 取值无关。langgraphId 缺失时兜底铸雪花（防御）。
  id: row.langgraphId ?? generateSnowflakeId(),
  cloudUserId: acct,
  createdAt: () => "datetime('now')",
  seq: () => "(SELECT COALESCE(MAX(seq), 0) + 1 FROM session_messages WHERE session_id = :sid AND cloud_user_id = :acct)",
})
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter server-agent test session-message.service`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/server-agent/src/services/session-message.service.ts apps/server-agent/src/services/session-message.service.spec.ts
git commit -m "fix(server-agent): session_messages.id 收口到 langgraphId，修复历史与 inflight 去重失配"
```

---

### Task 4: history 端 byMessage 关联在 id==langgraphId 下回归验证

**Files:**
- Modify: `apps/server-agent/src/controllers/session.controller.ts`（仅在必要时简化 `idByLanggraph`；否则只加回归测试）
- Test: `apps/server-agent/src/controllers/session.controller.spec.ts` 或既有 e2e

**Interfaces:**
- Consumes: Task 3 后 `m.id === m.langgraphId`。
- Produces: usage `byMessage` 仍按消息对外 id 命中（[session.controller.ts:94-116](../../../apps/server-agent/src/controllers/session.controller.ts#L94)）。

- [ ] **Step 1: 写测试（应直接通过 / 回归保护）**

断言：当 `session_messages.id === langgraph_id` 时，`llm_calls.message_id`（= langgraphId）查回的 usage 经 `idByLanggraph` 投影到 `byMessage[消息id]` 仍命中。

```ts
it("history.byMessage：id==langgraphId 时 usage 投影仍命中", async () => {
  // 落一条 assistant（id=langgraphId=900...123）+ 一条 llm_calls(message_id=900...123)
  const res = await controller.history("s1", { limit: "10" } as Record<string, string>);
  expect(res.byMessage["900000000000000123"]).toBeDefined();
});
```

- [ ] **Step 2: 跑测试**

Run: `pnpm --filter server-agent test session.controller`
Expected: PASS（`idByLanggraph` 退化为恒等映射，行为不变）。若失败说明有隐藏假设，按失败信息修。

- [ ] **Step 3: 提交**

```bash
git add apps/server-agent/src/controllers/session.controller.spec.ts
git commit -m "test(server-agent): 收口后 history.byMessage usage 投影回归"
```

---

### Task 5: 前端 human messageId 改用雪花

**Files:**
- Create: `packages/web-common/src/utils/snowflake.ts`（浏览器安全的雪花生成器）
- Modify: `apps/web-agent/src/hooks/use-session-stream.ts:607`（`crypto.randomUUID()` → 雪花）
- Test: `packages/web-common/src/utils/snowflake.spec.ts`

**Interfaces:**
- Produces: `clientSnowflakeId(): string` —— ≤20 位十进制字符串、单调递增、单节点免冲突；用作 human 消息 id（流入 pending / checkpointer HumanMessage / run.human / recordUser）。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from "vitest";
import { clientSnowflakeId } from "./snowflake";

describe("clientSnowflakeId", () => {
  it("返回 ≤20 位十进制字符串", () => {
    const id = clientSnowflakeId();
    expect(id).toMatch(/^\d{1,20}$/);
  });
  it("连续生成不重复且单调不减", () => {
    const a = clientSnowflakeId();
    const b = clientSnowflakeId();
    expect(a).not.toBe(b);
    expect(BigInt(b) >= BigInt(a)).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @meshbot/web-common test snowflake`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写实现**

```ts
// packages/web-common/src/utils/snowflake.ts
// 浏览器端雪花：本地轨单节点，worker 段用一次性随机值即可免冲突。
// 结构：毫秒时间戳 << 22 | (worker<<12) | seq；BigInt 转十进制字符串。
const EPOCH = 1700000000000n;
const worker = BigInt(Math.floor(Math.random() * 1024)); // 10 位
let lastMs = 0n;
let seq = 0n;

export function clientSnowflakeId(): string {
  let ms = BigInt(Date.now()) - EPOCH;
  if (ms === lastMs) {
    seq = (seq + 1n) & 0xfffn; // 12 位
    if (seq === 0n) {
      // 同毫秒溢出：自旋到下一毫秒
      while (BigInt(Date.now()) - EPOCH <= lastMs) { /* spin */ }
      ms = BigInt(Date.now()) - EPOCH;
    }
  } else {
    seq = 0n;
  }
  lastMs = ms;
  return ((ms << 22n) | (worker << 12n) | seq).toString();
}
```

并在 `packages/web-common` 出口（`src/index.ts` 或对应 utils barrel）导出 `clientSnowflakeId`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @meshbot/web-common test snowflake`
Expected: PASS

- [ ] **Step 5: 接入发送侧**

`use-session-stream.ts:607`：

```ts
const messageId = clientSnowflakeId();
```

并在文件顶部 import：`import { clientSnowflakeId } from "@meshbot/web-common";`（按实际包名/路径）。同步更新该函数上方 JSDoc 的「（UUID）」措辞为「（雪花）」。

- [ ] **Step 6: 跑类型检查**

Run: `pnpm typecheck`
Expected: 干净

- [ ] **Step 7: 提交**

```bash
git add packages/web-common/src/utils/snowflake.ts packages/web-common/src/utils/snowflake.spec.ts packages/web-common/src/index.ts apps/web-agent/src/hooks/use-session-stream.ts
git commit -m "feat(web-agent): human 消息 id 改用客户端雪花，三方 id 收口"
```

---

### Task 6: Runner —— 已落库轮不再作为活 inflight partial

**Files:**
- Modify: `apps/server-agent/src/services/runner.service.ts`（`InflightRun` 加字段、轮切换重置、assistant_done 置真、`getInflight` 抑制）
- Test: `apps/server-agent/src/services/runner.service.spec.ts`（追加）

**Interfaces:**
- Produces: `getInflight(sessionId)` 在「当前轮 assistant 已落库」时返回 `{ messageId: null, content: "", reasoning: "", reasoningStartedAt: null, status: "streaming" }`；下一轮 reasoning/chunk 到达后恢复吐新轮 partial。

- [ ] **Step 1: 写失败测试**

```ts
it("getInflight：assistant_done 落库后、工具执行中 → messageId 为 null 但仍 streaming", async () => {
  // fake graph：yield reasoning(msg-1) → assistant_done(msg-1, reasoning 非空) 后
  // 用一个永不 resolve 的 await 卡住（模拟长工具执行），并在卡住前回调采样 getInflight。
  let snap: ReturnType<typeof runner.getInflight> = null;
  // ... 安排在 assistant_done 之后、stream 未结束时采样 ...
  snap = runner.getInflight("s1");
  expect(snap?.status).toBe("streaming");
  expect(snap?.messageId).toBeNull();
});
```

> 采样时机参考既有 `getInflight：run 进行中可取到累加快照` 用例（[runner.service.spec.ts:310](../../../apps/server-agent/src/services/runner.service.spec.ts#L310)）的 fake graph 卡点写法。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter server-agent test runner.service`
Expected: FAIL（当前 `getInflight` 仍吐已落库轮的 reasoning + messageId）

- [ ] **Step 3: 改实现**

`InflightRun` 接口（[runner.service.ts:17-35](../../../apps/server-agent/src/services/runner.service.ts#L17)）加字段：

```ts
/** 当前轮 assistant 是否已 recordAssistant 落库。落库后该轮不再作为活 partial 吐出，
 *  避免「已落库轮」被刷新当成 inflight 重复推成「思考中」。轮切换时重置。 */
partialPersisted: boolean;
```

创建处（[runner.service.ts:252-259](../../../apps/server-agent/src/services/runner.service.ts#L252)）init `partialPersisted: false`。

reasoning handler 轮切换分支（[runner.service.ts:465-469](../../../apps/server-agent/src/services/runner.service.ts#L465)）与 chunk handler 轮切换分支（[509-513](../../../apps/server-agent/src/services/runner.service.ts#L509)）各加一行 `run.partialPersisted = false;`。

assistant_done 分支（`recordAssistant` 之后，[runner.service.ts:534-547](../../../apps/server-agent/src/services/runner.service.ts#L534)）末尾加 `run.partialPersisted = true;`。

`getInflight`（[runner.service.ts:109-119](../../../apps/server-agent/src/services/runner.service.ts#L109)）：

```ts
getInflight(sessionId: string): InflightView | null {
  const run = this.inflight.get(sessionId);
  if (!run || run.status !== "streaming") return null;
  // 本轮 assistant 已落库：history 已含整条（reasoning + tool_calls），
  // 不再吐活 partial，避免重复气泡 + 「思考中」误计时；但 status 仍 streaming，
  // 让前端知道 run 在跑（停止按钮 / 输入态不变）。
  if (run.partialPersisted) {
    return {
      messageId: null,
      content: "",
      reasoning: "",
      reasoningStartedAt: null,
      status: run.status,
    };
  }
  return {
    messageId: run.messageId,
    content: run.content,
    reasoning: run.reasoning,
    reasoningStartedAt: run.reasoningStartedAt,
    status: run.status,
  };
}
```

> 不动 `run.messageId`：它在 run.done/error/interrupted 标识最终消息。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter server-agent test runner.service`
Expected: PASS（既有 getInflight 累加快照用例仍过——那条在 assistant_done 之前采样）

- [ ] **Step 5: 提交**

```bash
git add apps/server-agent/src/services/runner.service.ts apps/server-agent/src/services/runner.service.spec.ts
git commit -m "fix(server-agent): 已落库轮不再作为活 inflight partial（修复刷新重复思考中）"
```

---

### Task 7（可选硬化）: WS subscribe 回放改 SET 语义（run.snapshot）

> 仅在需要根治「非持久化轮 push+replay 叠加 / 断线重连」文本翻倍隐患时做。A+B（Task 1-6）已修复截图 bug，可先验证后再决定是否做本任务。

**Files:**
- Modify: `libs/types-agent/src/session.ts`（新增 `RunSnapshotEventSchema` + `SESSION_WS_EVENTS.runSnapshot`）
- Modify: `apps/server-agent/src/ws/session.gateway.ts`（`handleSubscribe` 改发 `run.snapshot`）
- Modify: `apps/web-agent/src/hooks/use-session-stream.ts`（新增 `onSnapshot`，SET 语义）
- Test: `apps/server-agent/src/ws/session.gateway.spec.ts`

**Interfaces:**
- Produces: `run.snapshot { sessionId, messageId, reasoning, content, reasoningStartedAt }`；前端按 messageId **覆盖**（非累加）reasoning/content，缺失则建气泡。

- [ ] **Step 1: 写失败测试**

```ts
it("handleSubscribe：已落库轮（getInflight.messageId=null）不发 snapshot", () => {
  jest.spyOn(runner, "getInflight").mockReturnValue({
    messageId: null, content: "", reasoning: "", reasoningStartedAt: null, status: "streaming",
  });
  const emit = jest.fn();
  gateway.handleSubscribe({ sessionId: "s1" }, { join() {}, emit } as never);
  expect(emit).not.toHaveBeenCalledWith("run.snapshot", expect.anything());
});

it("handleSubscribe：非落库轮发一次全量 snapshot", () => {
  jest.spyOn(runner, "getInflight").mockReturnValue({
    messageId: "900...1", content: "正", reasoning: "思", reasoningStartedAt: 1, status: "streaming",
  });
  const emit = jest.fn();
  gateway.handleSubscribe({ sessionId: "s1" }, { join() {}, emit } as never);
  expect(emit).toHaveBeenCalledWith(
    SESSION_WS_EVENTS.runSnapshot,
    expect.objectContaining({ messageId: "900...1", reasoning: "思", content: "正" }),
  );
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter server-agent test session.gateway`
Expected: FAIL（事件未定义 / 仍发 run.reasoning+run.chunk）

- [ ] **Step 3: 改实现**

types-agent 加事件 + schema；`handleSubscribe`（[session.gateway.ts:70-96](../../../apps/server-agent/src/ws/session.gateway.ts#L70)）把 reasoning/chunk 回放替换为：`if (inflight?.messageId) client.emit(SESSION_WS_EVENTS.runSnapshot, { sessionId, messageId, reasoning, content, reasoningStartedAt });`。前端加 `onSnapshot`，按 messageId SET reasoning/content（不 append），并按 `reasoningStartedAt` 维持「思考中」语义。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter server-agent test session.gateway`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add libs/types-agent/src/session.ts apps/server-agent/src/ws/session.gateway.ts apps/web-agent/src/hooks/use-session-stream.ts apps/server-agent/src/ws/session.gateway.spec.ts
git commit -m "feat(agent): WS subscribe 回放改 run.snapshot SET 语义，根治回放翻倍"
```

---

## 收尾验证（全部任务后）

- [ ] `pnpm typecheck` 干净
- [ ] `pnpm check` 全过
- [ ] 集成冒烟：触发 ReAct 多轮 + 长工具的 prompt（如 bash 跑 sleep 30 / 大依赖安装），在工具执行中刷新页面——只剩 1 条 assistant（思考过程折叠 + 工具 running），无「思考中」计时、无重复气泡；工具结束后续接正常。
- [ ] 两个 session 并发跑，各自 running 工具不串台。

## Self-Review 结论

- **Spec 覆盖：** A（id 收口）= Task 1/2/3/5；B（partial 抑制）= Task 6；C（回放幂等）= Task 7；history 关联回归 = Task 4。无遗漏。
- **类型一致：** `resolveMessageId: (modelId: string) => string` 在 Task 1/2 一致；`partialPersisted` 在 Task 6 内自洽；`run.snapshot` 字段在 Task 7 内自洽。
- **占位符：** 无 TBD。Task 2 的 graph fake-stream 注入与 Task 3/6 的 repo/fake-graph 采样时机标注「按既有 spec 写法适配」——属测试脚手架对齐，非逻辑占位。
