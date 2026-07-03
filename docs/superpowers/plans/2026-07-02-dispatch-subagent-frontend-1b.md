# 派子 Agent Phase 1b（前端嵌套卡）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把聊天里的 `dispatch_subagent` 工具卡升级为嵌套实时卡：展开可见子 Agent 自己的消息流，运行中实时滴流，任意时刻刷新可还原，并行 fan-out 多卡并列。

**Architecture:** 三路认领 subSessionId（live `run.subagent_spawned` 事件 / history 接口附带 / 结果 JSON 兜底）→ `SubagentCard` 内嵌第二个 `useSessionStream(subSessionId)`（多实例已被 assistant-dock 验证）→ 展开体复用 `MessageList` 的新 `nested` 变体。唯一后端增强：history 组装时按 `parent_tool_call_id` 反查子会话带出 `subSessionId`。

**Tech Stack:** Next.js + next-intl + jotai（web-agent）、socket.io client、NestJS + TypeORM/SQLite（server-agent）、Zod（types-agent）、Jest（根配置，含 web-agent 纯函数测试）。

**设计 spec:** `docs/superpowers/specs/2026-07-02-dispatch-subagent-frontend-design.md`

## Global Constraints

- 分支 `feat/dispatch-subagent-ui`（已存在，自 main 62f8981 切出，spec 已提交）。不 push、不开 PR（收尾由控制者处理）。
- 不改 1a 任何运行语义（前台阻塞、一层嵌套、`SUBAGENT_MAX_CONCURRENCY=4` 均不动）；本期不做：停止按钮/独立 abort、background、model 覆盖、「在完整页打开子会话」、子会话用量小计、「加载更多历史」按钮。
- **web-agent 前端测试跑在根 jest（node 环境、ts-jest、无 jsdom）**：被测纯逻辑模块**严禁 import React 组件 / jotai / socket / next-intl**（jotai 是纯 ESM，node jest 加载即炸——`use-global-events.spec.ts` 因此被 testPathIgnorePatterns 排除，前车之鉴）。纯逻辑放 `apps/web-agent/src/lib/`，用结构化类型（不 import `message-list.tsx`）。
- i18n：新 UI 字符串走 `useTranslations`，`messages/zh.json` 与 `en.json` 键**必须对称**（pre-commit 跑 `sync-locales --check`，missing/asymmetric 必须为 0；orphan 允许）。不学 `ask-question-card` 的硬编码中文（既有反例）。
- `TOOL_LABELS`（`tool-display.ts`）是既有的「工具名→中文」lib 映射，不走 i18n——按既有惯例补条目即可。
- 公开方法中文 JSDoc；Biome（`if` 前一行不放注释）；中文 conventional commits + 结尾 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
- **只跑本任务相关测试**，全量套件 / boot / 冒烟留 Task 5（1a 教训：最后必须全量根 jest，不只目标 spec）。
- server-agent dev 端口在 PR #7 后由自检决定（不再固定 3100），以启动日志 `Agent running on ...` 实际端口为准。
- 根 jest 基线：全绿 + 1 skip（session.e2e 的 retry 用例是既有 `it.skip`）。

---

## File Structure

**新建：**
- `libs/types-agent/src/history-tool-call.spec.ts` — HistoryToolCallSchema 可选字段单测（jest）。
- `apps/web-agent/src/lib/subagent-card.ts` — 认领/状态/折叠纯逻辑（零依赖，可被根 jest 测）。
- `apps/web-agent/src/lib/subagent-card.spec.ts` — 上述纯逻辑单测。
- `apps/web-agent/src/components/session/subagent-card.tsx` — 嵌套卡组件。

**修改：**
- `libs/types-agent/src/session.ts` — `HistoryToolCallSchema` 加可选 `subSessionId`。
- `apps/server-agent/src/services/session.service.ts` — `listChildren`。
- `apps/server-agent/src/services/session.service.spec.ts` — listChildren 单测。
- `apps/server-agent/src/controllers/session.controller.ts` — history 组装带出 `subSessionId`。
- `apps/server-agent/src/controllers/session.controller.spec.ts` — history 关联单测。
- `apps/web-agent/src/components/session/message-list.tsx` — `ToolCallView.subSessionId` + `nested` prop。
- `apps/web-agent/src/hooks/use-session-stream.ts` — 水合透传 + `runSubagentSpawned` 监听。
- `apps/web-agent/src/components/session/tool-call-block.tsx` — 第 7 个特判分支。
- `apps/web-agent/src/lib/tool-display.ts`（+ `tool-display.spec.ts`）— `TOOL_LABELS` 补条目。
- `apps/web-agent/messages/zh.json` / `en.json` — `session.subagent` 命名空间。

---

## Task 1: types-agent — HistoryToolCallSchema 加可选 subSessionId

**Files:**
- Modify: `libs/types-agent/src/session.ts`（`HistoryToolCallSchema`，现约 94-101 行）
- Create: `libs/types-agent/src/history-tool-call.spec.ts`

**Interfaces:**
- Produces: `HistoryToolCallSchema` / `HistoryToolCall` 新可选字段 `subSessionId?: string`——Task 2 的 controller 组装写入、Task 3 的前端水合读取。

- [ ] **Step 1: 写失败测试**

新建 `libs/types-agent/src/history-tool-call.spec.ts`：

```ts
import { HistoryToolCallSchema } from "./session";

describe("HistoryToolCallSchema.subSessionId", () => {
  const base = {
    toolCallId: "tc-1",
    name: "dispatch_subagent",
    args: { task: "调研" },
    status: "running",
    result: "",
  };

  it("无 subSessionId 可解析（向后兼容）", () => {
    const r = HistoryToolCallSchema.parse(base);
    expect(r.subSessionId).toBeUndefined();
  });

  it("带 subSessionId 解析并保留", () => {
    const r = HistoryToolCallSchema.parse({
      ...base,
      subSessionId: "901000000000000001",
    });
    expect(r.subSessionId).toBe("901000000000000001");
  });

  it("subSessionId 非字符串拒绝", () => {
    expect(() =>
      HistoryToolCallSchema.parse({ ...base, subSessionId: 123 }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm jest libs/types-agent/src/history-tool-call.spec.ts`
Expected: 第 2 个用例 FAIL——schema 尚无该字段时，zod object 默认 strip 未知键，`r.subSessionId` 为 undefined（`Expected: "901000000000000001", Received: undefined`）。

- [ ] **Step 3: 实现**

`libs/types-agent/src/session.ts` 的 `HistoryToolCallSchema` 加一个字段（其余不动）：

```ts
/** 历史 ReAct 轨迹中的单次工具调用。 */
export const HistoryToolCallSchema = z.object({
  toolCallId: z.string(),
  name: z.string(),
  args: z.unknown(),
  status: z.enum(["ok", "error", "running"]),
  result: z.string(),
  /**
   * dispatch_subagent 专用：该次调用派生的子会话 id。后端组装 history 时按
   * parent_tool_call_id 反查带出，供前端嵌套卡在任意时刻（含子 run 进行中刷新）
   * 认领。其他工具无此字段。
   */
  subSessionId: z.string().optional(),
});
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm jest libs/types-agent/src/history-tool-call.spec.ts`
Expected: 3/3 PASS。

- [ ] **Step 5: 提交**

```bash
git add libs/types-agent/src/session.ts libs/types-agent/src/history-tool-call.spec.ts
git commit -m "feat(types-agent): HistoryToolCall 加可选 subSessionId（嵌套卡刷新认领）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: server-agent — listChildren + history 组装带出 subSessionId

**Files:**
- Modify: `apps/server-agent/src/services/session.service.ts`（`findOrNull` 附近加方法）
- Modify: `apps/server-agent/src/controllers/session.controller.ts`（history 组装，现约 128-184 行）
- Test: `apps/server-agent/src/services/session.service.spec.ts`、`apps/server-agent/src/controllers/session.controller.spec.ts`

**Interfaces:**
- Consumes: Task 1 的 `HistoryToolCall.subSessionId`；1a 的 `createSubSession(input: {parentSessionId, parentToolCallId, task, description?}) → {subSessionId}`（测试造数用，签名以文件实际为准）。
- Produces: `SessionService.listChildren(parentSessionId: string): Promise<Array<Pick<Session, "id" | "parentToolCallId">>>`；history 响应中 dispatch 条目带 `subSessionId`。

- [ ] **Step 1: 写 service 失败测试**

`apps/server-agent/src/services/session.service.spec.ts` 的 `describe("createSubSession")` 块内追加（该 spec 用真 better-sqlite3 内存库 + 自动账号上下文代理 `service`，直接沿用）：

```ts
it("listChildren 按父会话返回子会话 id + parentToolCallId；不含他父的子会话", async () => {
  const parentId = "990000000000000001";
  expect(await service.listChildren(parentId)).toEqual([]);
  const a = await service.createSubSession({
    parentSessionId: parentId,
    parentToolCallId: "tc-1",
    task: "任务A",
  });
  const b = await service.createSubSession({
    parentSessionId: parentId,
    parentToolCallId: "tc-2",
    task: "任务B",
  });
  await service.createSubSession({
    parentSessionId: "990000000000000002",
    parentToolCallId: "tc-3",
    task: "他父的任务",
  });
  const rows = await service.listChildren(parentId);
  expect(new Map(rows.map((r) => [r.parentToolCallId, r.id]))).toEqual(
    new Map([
      ["tc-1", a.subSessionId],
      ["tc-2", b.subSessionId],
    ]),
  );
});
```

（`createSubSession` 的入参/返回以文件实际为准；若返回字段名不同，按实际调整断言。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm jest apps/server-agent/src/services/session.service.spec.ts -t "listChildren"`
Expected: FAIL，`service.listChildren is not a function`。

- [ ] **Step 3: 实现 listChildren**

`session.service.ts` 中 `findOrNull` 方法之后加：

```ts
/**
 * 列出某父会话派生的全部子会话（id + 认领用的 parentToolCallId）。
 * 供 history 组装嵌套卡关联：子 run 进行中工具结果未落库，前端刷新后唯有
 * 此路能把 dispatch 工具卡认领到子会话。
 */
listChildren(
  parentSessionId: string,
): Promise<Array<Pick<Session, "id" | "parentToolCallId">>> {
  return this.sessionRepo.find({
    where: { parentSessionId },
    select: { id: true, parentToolCallId: true },
  });
}
```

- [ ] **Step 4: 跑 service 测试确认通过**

Run: `pnpm jest apps/server-agent/src/services/session.service.spec.ts`
Expected: 全绿（原有 52 个 + 新 1 个）。

- [ ] **Step 5: 写 controller 失败测试**

`apps/server-agent/src/controllers/session.controller.spec.ts` 追加 describe（沿用文件里既有的「直接 new SessionController + 逐参 mock」模式；**构造参数个数与顺序以文件现有用例为准**——现有用例是 7 参，其中后两个 `undefined as never`）：

```ts
describe("SessionController.history 嵌套卡 subSessionId 关联", () => {
  it("dispatch 工具条目带出子会话 id；其他工具与无子会话的不带", async () => {
    const MID = "900000000000000200";
    const assistantRow = {
      id: MID,
      langgraphId: null,
      role: "assistant",
      content: "",
      reasoning: null,
      toolCalls: JSON.stringify([
        { id: "tc-dispatch", name: "dispatch_subagent", args: { task: "调研" } },
        { id: "tc-bash", name: "bash", args: { command: "ls" } },
      ]),
      toolCallId: null,
      metadata: null,
      seq: 1,
      createdAt: new Date(),
    };
    const controller = new SessionController(
      {
        findSessionOrFail: async () => {},
        listChildren: async () => [
          { id: "901000000000000001", parentToolCallId: "tc-dispatch" },
        ],
      } as unknown as SessionService,
      { getInflight: () => null } as unknown as RunnerService,
      {
        listByMessageIds: async () => [],
        getSessionTotals: async () => null,
      } as unknown as LlmCallService,
      {
        listPage: async () => ({ messages: [assistantRow], hasMore: false }),
      } as unknown as SessionMessageService,
      {} as unknown as SessionTitleService,
      undefined as never,
      undefined as never,
    );
    const res = await controller.history("s1", { limit: "10" });
    const tcs = res.messages[0]?.toolCalls ?? [];
    expect(
      tcs.find((t) => t.toolCallId === "tc-dispatch")?.subSessionId,
    ).toBe("901000000000000001");
    expect(
      tcs.find((t) => t.toolCallId === "tc-bash")?.subSessionId,
    ).toBeUndefined();
  });
});
```

- [ ] **Step 6: 跑测试确认失败**

Run: `pnpm jest apps/server-agent/src/controllers/session.controller.spec.ts`
Expected: 新用例 FAIL（`subSessionId` 为 undefined——controller 还没写关联；若先因 mock 缺 `listChildren` 报错也算有效 RED）。

- [ ] **Step 7: 实现 history 组装**

`session.controller.ts` 的 `history` 方法里，`toolByCallId` 构建之后（`const messages = rows...` 之前）加：

```ts
// dispatch_subagent 嵌套卡认领：按 parent_tool_call_id 反查子会话。
// 子 run 进行中工具结果未落库（无 tool 行），前端刷新后唯有此路能认领。
const children = await this.sessions.listChildren(id);
const childByToolCallId = new Map<string, string>();
for (const c of children) {
  if (c.parentToolCallId) childByToolCallId.set(c.parentToolCallId, c.id);
}
```

`toolCalls` 的 map 回调改为（仅在已有返回对象上加一个展开字段）：

```ts
const toolCalls: HistoryToolCall[] = calls.map((c) => {
  const tr = toolByCallId.get(c.id);
  const status = computeToolCallStatus(tr);
  const subSessionId = childByToolCallId.get(c.id);
  return {
    toolCallId: c.id,
    name: c.name,
    args: c.args,
    status,
    result: tr?.content ?? "",
    ...(subSessionId ? { subSessionId } : {}),
  };
});
```

- [ ] **Step 8: 跑测试确认通过**

Run: `pnpm jest apps/server-agent/src/controllers/session.controller.spec.ts apps/server-agent/src/services/session.service.spec.ts`
Expected: 全绿。

- [ ] **Step 9: 提交**

```bash
git add apps/server-agent/src/services/session.service.ts \
        apps/server-agent/src/services/session.service.spec.ts \
        apps/server-agent/src/controllers/session.controller.ts \
        apps/server-agent/src/controllers/session.controller.spec.ts
git commit -m "feat(server-agent): history 按 parent_tool_call_id 带出 subSessionId（嵌套卡任意时刻刷新可认领）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: web-agent — 认领纯逻辑模块 + ToolCallView/useSessionStream 接线

**Files:**
- Create: `apps/web-agent/src/lib/subagent-card.ts`、`apps/web-agent/src/lib/subagent-card.spec.ts`
- Modify: `apps/web-agent/src/components/session/message-list.tsx`（仅 `ToolCallView` 接口）
- Modify: `apps/web-agent/src/hooks/use-session-stream.ts`

**Interfaces:**
- Consumes: Task 2 的 history 响应 `tc.subSessionId`；`RunSubagentSpawnedEvent` / `SESSION_WS_EVENTS.runSubagentSpawned`（1a 已有，`@meshbot/types-agent`）。
- Produces（Task 4 消费）：`ToolCallView.subSessionId?: string`；纯函数 `resolveSubSessionId` / `subagentTitle` / `resolveSubagentStatus` / `SubagentCollapse` / `isSubagentOpen` / `toggleSubagentOpen` / `claimSubagentOnTimeline`（签名见 Step 3）。

**纪律**：`subagent-card.ts` 是零依赖纯模块（不 import React/jotai/组件文件），否则根 jest 直接炸（见 Global Constraints）。

- [ ] **Step 1: 写失败测试**

新建 `apps/web-agent/src/lib/subagent-card.spec.ts`：

```ts
import {
  claimSubagentOnTimeline,
  isSubagentOpen,
  resolveSubagentStatus,
  resolveSubSessionId,
  type SubagentCollapse,
  subagentTitle,
  toggleSubagentOpen,
} from "./subagent-card";

describe("resolveSubSessionId 三路认领", () => {
  it("优先 tool.subSessionId（spawned 事件 / history 附带）", () => {
    expect(
      resolveSubSessionId({ subSessionId: "sub-1", result: '{"subSessionId":"sub-2"}' }),
    ).toBe("sub-1");
  });
  it("兜底解析结果 JSON", () => {
    expect(
      resolveSubSessionId({ result: '{"subSessionId":"sub-2","status":"done","output":"x"}' }),
    ).toBe("sub-2");
  });
  it("无来源 / 结果非 JSON / 空 subSessionId → null", () => {
    expect(resolveSubSessionId({})).toBeNull();
    expect(resolveSubSessionId({ result: "oops" })).toBeNull();
    expect(resolveSubSessionId({ result: '{"subSessionId":""}' })).toBeNull();
  });
});

describe("subagentTitle", () => {
  it("优先 description", () => {
    expect(subagentTitle({ description: "调研竞品", task: "很长的任务说明" })).toBe("调研竞品");
  });
  it("无 description 取 task 截 30 字（与后端 fallback 一致）", () => {
    expect(subagentTitle({ task: "a".repeat(40) })).toBe("a".repeat(30));
    expect(subagentTitle({ task: "短任务" })).toBe("短任务");
  });
  it("args 非对象 / 均缺 → 空串", () => {
    expect(subagentTitle(undefined)).toBe("");
    expect(subagentTitle({})).toBe("");
  });
});

describe("resolveSubagentStatus", () => {
  it("工具 running 或子流 running → running", () => {
    expect(resolveSubagentStatus({ status: "running" }, false)).toBe("running");
    expect(resolveSubagentStatus({ status: "ok", result: "" }, true)).toBe("running");
  });
  it("结束后按结果 JSON status 区分 done/error/aborted", () => {
    expect(resolveSubagentStatus({ status: "ok", result: '{"status":"done"}' }, false)).toBe("done");
    expect(resolveSubagentStatus({ status: "ok", result: '{"status":"error"}' }, false)).toBe("error");
    expect(resolveSubagentStatus({ status: "ok", result: '{"status":"aborted"}' }, false)).toBe("aborted");
  });
  it("结果非 JSON 时按工具级状态兜底", () => {
    expect(resolveSubagentStatus({ status: "ok", result: "oops" }, false)).toBe("done");
    expect(resolveSubagentStatus({ status: "error", result: "boom" }, false)).toBe("error");
  });
});

describe("折叠状态机", () => {
  const auto: SubagentCollapse = { mode: "auto" };
  it("auto 态跟随 childRunning", () => {
    expect(isSubagentOpen(auto, true)).toBe(true);
    expect(isSubagentOpen(auto, false)).toBe(false);
  });
  it("点击切 manual 并取反当前展示态；manual 后不再跟随", () => {
    const manual = toggleSubagentOpen(auto, true); // 运行中展开时点击 → 手动收起
    expect(manual).toEqual({ mode: "manual", open: false });
    expect(isSubagentOpen(manual, false)).toBe(false);
    expect(isSubagentOpen(toggleSubagentOpen(manual, false), false)).toBe(true);
  });
});

describe("claimSubagentOnTimeline", () => {
  // 显式标注可选 subSessionId，否则字面量推断出的类型上访问该字段会 TS2339
  const timeline: Array<{
    id: string;
    toolCalls?: Array<{ toolCallId: string; subSessionId?: string }>;
  }> = [
    { id: "m1", toolCalls: [{ toolCallId: "tc-1" }, { toolCallId: "tc-2" }] },
    { id: "m2" },
  ];
  it("按 toolCallId 打上 subSessionId，其余条目不动", () => {
    const next = claimSubagentOnTimeline(timeline, "tc-2", "sub-9");
    expect(next[0].toolCalls?.[1].subSessionId).toBe("sub-9");
    expect(next[0].toolCalls?.[0].subSessionId).toBeUndefined();
    expect(next[1]).toBe(timeline[1]);
  });
  it("未命中返回原数组引用（不触发重渲染）", () => {
    expect(claimSubagentOnTimeline(timeline, "tc-404", "sub-9")).toBe(timeline);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm jest apps/web-agent/src/lib/subagent-card.spec.ts`
Expected: FAIL，`Cannot find module './subagent-card'`。

- [ ] **Step 3: 实现纯模块**

新建 `apps/web-agent/src/lib/subagent-card.ts`：

```ts
/**
 * dispatch_subagent 嵌套卡纯逻辑（认领 / 标题 / 状态 / 折叠 / 时间线打标）。
 *
 * 零依赖：本模块被根 jest（node 环境、无 jsdom/ESM transform）直接加载测试，
 * 严禁 import React 组件 / jotai / socket / next-intl；工具切片用结构化类型。
 */

/** 认领所需的最小工具调用切片（结构化类型，避免 import 组件模块）。 */
export interface SubagentToolSlice {
  subSessionId?: string;
  result?: string;
}

/**
 * 解析嵌套卡的子会话 id，三路优先级：
 * tool.subSessionId（spawned 事件 / history 附带）→ 结果 JSON 兜底 → null（未认领）。
 */
export function resolveSubSessionId(tool: SubagentToolSlice): string | null {
  if (tool.subSessionId) return tool.subSessionId;
  if (!tool.result) return null;
  try {
    const parsed = JSON.parse(tool.result) as { subSessionId?: unknown };
    return typeof parsed.subSessionId === "string" && parsed.subSessionId
      ? parsed.subSessionId
      : null;
  } catch {
    return null;
  }
}

/** 卡标题：args.description 优先，缺省取 task 截 30 字（与后端 spawned 事件 fallback 一致）。 */
export function subagentTitle(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as { description?: unknown; task?: unknown };
  if (typeof a.description === "string" && a.description) return a.description;
  if (typeof a.task === "string" && a.task) return a.task.slice(0, 30);
  return "";
}

export type SubagentStatus = "running" | "done" | "error" | "aborted";

/**
 * 嵌套卡状态：dispatch 工具即使子 run 失败/中止也正常返回 JSON（工具级 status
 * 恒为 ok），真实结局在结果 JSON 的 status 字段——结束后以它为准。
 */
export function resolveSubagentStatus(
  tool: { status: string; result?: string },
  childRunning: boolean,
): SubagentStatus {
  if (tool.status === "running" || childRunning) return "running";
  if (tool.result) {
    try {
      const parsed = JSON.parse(tool.result) as { status?: unknown };
      if (
        parsed.status === "done" ||
        parsed.status === "error" ||
        parsed.status === "aborted"
      ) {
        return parsed.status;
      }
    } catch {
      // 非 JSON 结果：走工具级状态兜底
    }
  }
  return tool.status === "error" ? "error" : "done";
}

/** 折叠状态：auto 跟随子 run（运行→展开、结束→收起）；用户点击后转 manual 不再自动。 */
export type SubagentCollapse = { mode: "auto" } | { mode: "manual"; open: boolean };

/** 当前是否展开。 */
export function isSubagentOpen(
  state: SubagentCollapse,
  childRunning: boolean,
): boolean {
  return state.mode === "auto" ? childRunning : state.open;
}

/** 用户点击折叠头：取反当前展示态并转 manual。 */
export function toggleSubagentOpen(
  state: SubagentCollapse,
  childRunning: boolean,
): SubagentCollapse {
  return { mode: "manual", open: !isSubagentOpen(state, childRunning) };
}

/**
 * 在时间线上按 toolCallId 认领子会话：给命中的工具条目打上 subSessionId。
 * 未命中返回原数组引用（调用方 setState 不触发重渲染）。泛型保持
 * TimelineMessage 兼容而不引入组件模块依赖。
 */
export function claimSubagentOnTimeline<
  T extends { toolCalls?: Array<{ toolCallId: string; subSessionId?: string }> },
>(prev: T[], toolCallId: string, subSessionId: string): T[] {
  let changed = false;
  const next = prev.map((m) => {
    if (!m.toolCalls?.some((t) => t.toolCallId === toolCallId)) return m;
    changed = true;
    // 泛型展开覆写属性后 TS 无法证明仍是 T，运行时结构未变，安全收窄
    return {
      ...m,
      toolCalls: m.toolCalls.map((t) =>
        t.toolCallId === toolCallId ? { ...t, subSessionId } : t,
      ),
    } as T;
  });
  return changed ? next : prev;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm jest apps/web-agent/src/lib/subagent-card.spec.ts`
Expected: 全绿。

- [ ] **Step 5: ToolCallView 加字段 + hook 接线**

`message-list.tsx` 的 `ToolCallView` 接口（`result?: string;` 之后）加：

```ts
  /** dispatch_subagent 专用：已认领的子会话 id（spawned 事件 / history 附带）。 */
  subSessionId?: string;
```

`use-session-stream.ts` 三处改动：

1）import（类型 + 纯函数）：

```ts
import type { RunSubagentSpawnedEvent } from "@meshbot/types-agent";
import { claimSubagentOnTimeline } from "@/lib/subagent-card";
```

（`RunSubagentSpawnedEvent` 并入文件头部既有的 `@meshbot/types-agent` type import 列表。）

2）history 水合的 toolCalls map（现约 189-195 行）加透传：

```ts
toolCalls: m.toolCalls.map((tc) => ({
  toolCallId: tc.toolCallId,
  name: tc.name,
  args: tc.args,
  status: tc.status,
  result: tc.result,
  ...(tc.subSessionId ? { subSessionId: tc.subSessionId } : {}),
})),
```

3）`onToolEnd` 定义之后加 handler，并在注册/清理两处成对增加（紧跟 `runToolCallEnd` 那两行之后）：

```ts
const onSubagentSpawned = (e: RunSubagentSpawnedEvent) => {
  if (e.sessionId !== sessionId) return;
  apply((prev) => claimSubagentOnTimeline(prev, e.toolCallId, e.subSessionId));
};
```

```ts
socket.on(SESSION_WS_EVENTS.runSubagentSpawned, onSubagentSpawned);
```

```ts
socket.off(SESSION_WS_EVENTS.runSubagentSpawned, onSubagentSpawned);
```

- [ ] **Step 6: 验证**

Run: `pnpm jest apps/web-agent/src/lib && pnpm --filter @meshbot/web-agent typecheck`
Expected: lib 测试全绿；typecheck 通过。

- [ ] **Step 7: 提交**

```bash
git add apps/web-agent/src/lib/subagent-card.ts apps/web-agent/src/lib/subagent-card.spec.ts \
        apps/web-agent/src/components/session/message-list.tsx \
        apps/web-agent/src/hooks/use-session-stream.ts
git commit -m "feat(web-agent): 嵌套卡认领链路（纯逻辑模块 + spawned 事件消费 + history 透传）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: web-agent — SubagentCard 组件 + MessageList nested 变体 + 接入

**Files:**
- Create: `apps/web-agent/src/components/session/subagent-card.tsx`
- Modify: `apps/web-agent/src/components/session/message-list.tsx`（`nested` prop）
- Modify: `apps/web-agent/src/components/session/tool-call-block.tsx`（特判分支）
- Modify: `apps/web-agent/src/lib/tool-display.ts` + `apps/web-agent/src/lib/tool-display.spec.ts`
- Modify: `apps/web-agent/messages/zh.json`、`apps/web-agent/messages/en.json`

**Interfaces:**
- Consumes: Task 3 全部纯函数与 `ToolCallView.subSessionId`；`useSessionStream(sessionId | null, scrollRef)`（null 惰性 inert）。
- Produces: `<SubagentCard tool={ToolCallView} />`；`MessageList` 新可选 prop `nested?: boolean`。

组件无法在 node jest 下测试（无 jsdom）——本任务的自动验证 = tool-display 单测 + typecheck + lint；行为验证靠 Task 5 冒烟。

- [ ] **Step 1: 写 tool-display 失败测试**

`apps/web-agent/src/lib/tool-display.spec.ts` 的 `describe("toolDisplayName")` 内追加：

```ts
it("dispatch_subagent 映射「派发子任务」", () => {
  expect(toolDisplayName("dispatch_subagent")).toBe("派发子任务");
});
```

Run: `pnpm jest apps/web-agent/src/lib/tool-display.spec.ts`
Expected: FAIL（当前兜底返回 `"dispatch subagent"`）。

- [ ] **Step 2: TOOL_LABELS 补条目**

`tool-display.ts` 的 `TOOL_LABELS` 里加（按字母序邻近位置）：

```ts
  dispatch_subagent: "派发子任务",
```

Run: `pnpm jest apps/web-agent/src/lib/tool-display.spec.ts` → PASS。

- [ ] **Step 3: i18n 键（zh/en 对称）**

`apps/web-agent/messages/zh.json` 的 `"session"` 对象内（与 `"compaction"` 平级）加：

```json
"subagent": {
  "fallbackTitle": "子任务",
  "starting": "启动中…",
  "running": "运行中",
  "done": "已完成",
  "error": "失败",
  "aborted": "已中止"
}
```

`apps/web-agent/messages/en.json` 同位置加：

```json
"subagent": {
  "fallbackTitle": "Subtask",
  "starting": "Starting…",
  "running": "Running",
  "done": "Done",
  "error": "Failed",
  "aborted": "Aborted"
}
```

（状态键会经 `t(status)` 动态取值，静态扫描会把它们记为 orphan——允许；missing/asymmetric 必须为 0，`tsx scripts/sync-locales.ts -- --check` 可提前自查。）

- [ ] **Step 4: MessageList nested 变体**

`message-list.tsx`：

`MessageListProps` 加（`usageByMessage` 之后）：

```ts
  /** 嵌套模式（子 Agent 卡内）：隐藏头像行/名字/重试/反馈/TodoPanel，仅保留内容与工具块。 */
  nested?: boolean;
```

函数签名解构加 `nested`：

```ts
export function MessageList({
  messages,
  sessionId,
  running,
  onRegenerateOptimisticCut,
  usageByMessage,
  nested,
}: MessageListProps) {
```

四处按 `!nested` 收敛（其余 JSX 不动）：

1）`<TodoPanel messages={messages} />` → `{!nested && <TodoPanel messages={messages} />}`

2）头像块（`m.role === "user" ? (...) : (...)` 那段三元）整体包裹：

```tsx
{!nested &&
  (m.role === "user" ? (
    <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] bg-[#16a34a] text-[12px] font-semibold text-white">
      {userInitial}
    </div>
  ) : (
    <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] bg-(--shell-accent) text-white">
      <Sparkles className="h-4 w-4" />
    </div>
  ))}
```

3）名字行：

```tsx
{!nested && (
  <div className="text-[13px] font-bold text-foreground">
    {m.role === "user" ? userName : assistantName}
  </div>
)}
```

4）两组操作按钮：`AssistantMessageActions` 的条件改为 `{!nested && m.role === "assistant" && m.content && !m.streaming && (...)}`；`UserMessageActions` 的条件改为 `{!nested && m.role === "user" && (...)}`。

- [ ] **Step 5: SubagentCard 组件**

新建 `apps/web-agent/src/components/session/subagent-card.tsx`：

```tsx
"use client";

import { cn } from "@meshbot/design";
import { ChevronDown, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { useSessionStream } from "@/hooks/use-session-stream";
import {
  isSubagentOpen,
  resolveSubagentStatus,
  resolveSubSessionId,
  type SubagentCollapse,
  subagentTitle,
  toggleSubagentOpen,
} from "@/lib/subagent-card";
import { MessageList, type ToolCallView } from "./message-list";

/**
 * dispatch_subagent 嵌套卡：折叠头（状态点 + 子任务标题 + 状态文案）+ 展开体
 * （子会话实时消息流：第二个 useSessionStream 实例 + MessageList nested 变体）。
 *
 * - 认领：resolveSubSessionId 三路来源；未认领时只显示「启动中」头，不渲染嵌套流。
 * - 折叠：子 run 运行中自动展开、结束自动收起；用户点击后转手动不再自动。
 * - 收起只隐藏展开体 DOM，不卸载流（避免反复退房/重拉历史）；卸载时 hook 自清理。
 */
export function SubagentCard({ tool }: { tool: ToolCallView }) {
  const t = useTranslations("session.subagent");
  const subSessionId = resolveSubSessionId(tool);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const sub = useSessionStream(subSessionId, scrollRef);
  const [collapse, setCollapse] = useState<SubagentCollapse>({ mode: "auto" });
  const childRunning = sub.running || tool.status === "running";
  const open = isSubagentOpen(collapse, childRunning);
  const status =
    subSessionId === null
      ? ("starting" as const)
      : resolveSubagentStatus(tool, sub.running);
  const title = subagentTitle(tool.args) || t("fallbackTitle");
  const active = status === "running" || status === "starting";
  // 子流有新内容且用户停在底部时吸底跟随（同 StreamBodyPre 逻辑）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: messages 是「内容变化触发器」，内容增长时吸底
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [sub.messages]);
  const dotColor = active
    ? "bg-primary/70"
    : status === "error"
      ? "bg-destructive"
      : "bg-muted-foreground/40";
  return (
    <div className="flex w-full flex-col overflow-hidden rounded-[8px] border border-border">
      <button
        type="button"
        onClick={() => setCollapse((s) => toggleSubagentOpen(s, childRunning))}
        className="group flex w-full items-center gap-2 bg-muted/40 px-2.5 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground"
        aria-expanded={open}
      >
        <span
          className={cn(
            "inline-block h-2 w-2 shrink-0 rounded-full",
            dotColor,
            active && "animate-pulse",
          )}
        />
        <span className="min-w-0 truncate font-medium text-foreground">
          {title}
        </span>
        <span className="shrink-0 text-muted-foreground/70">{t(status)}</span>
        {active && <Loader2 className="h-3 w-3 shrink-0 animate-spin text-primary/70" />}
        <ChevronDown
          className={cn(
            "ml-auto h-3 w-3 shrink-0 transition-transform",
            !open && "-rotate-90",
          )}
        />
      </button>
      {open && subSessionId && (
        <div
          ref={scrollRef}
          onScroll={() => {
            const el = scrollRef.current;
            if (el) {
              stickRef.current =
                el.scrollHeight - el.scrollTop - el.clientHeight <= 24;
            }
          }}
          className="max-h-96 overflow-y-auto border-t border-border px-3 py-2"
        >
          <MessageList
            nested
            messages={sub.messages}
            sessionId={subSessionId}
            running={sub.running}
            onRegenerateOptimisticCut={() => {}}
          />
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 6: tool-call-block 接入**

`tool-call-block.tsx`：import 区加 `import { SubagentCard } from "./subagent-card";`，特判链（`todo_write` 分支之后、`const streaming = ...` 之前）加：

```ts
if (tool.name === "dispatch_subagent" && tool.status !== "streaming") {
  return <SubagentCard tool={tool} />;
}
```

（streaming 阶段仍走通用块的打字预览，与其他特判卡一致。）

- [ ] **Step 7: 验证**

Run:
```bash
pnpm jest apps/web-agent/src/lib
pnpm --filter @meshbot/web-agent typecheck
pnpm biome check apps/web-agent/src/components/session/subagent-card.tsx \
  apps/web-agent/src/components/session/message-list.tsx \
  apps/web-agent/src/components/session/tool-call-block.tsx
tsx scripts/sync-locales.ts -- --check
```
Expected: 测试全绿；typecheck/biome 干净；locales missing=0、asymmetric=0。

- [ ] **Step 8: 提交**

```bash
git add apps/web-agent/src/components/session/subagent-card.tsx \
        apps/web-agent/src/components/session/message-list.tsx \
        apps/web-agent/src/components/session/tool-call-block.tsx \
        apps/web-agent/src/lib/tool-display.ts apps/web-agent/src/lib/tool-display.spec.ts \
        apps/web-agent/messages/zh.json apps/web-agent/messages/en.json
git commit -m "feat(web-agent): dispatch_subagent 嵌套实时卡（MessageList nested 变体 + 自动展开折叠）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: 集成验证（全量 + boot + 冒烟）

- [ ] **Step 1: 全量 typecheck + 全量根 jest**

Run: `pnpm typecheck && pnpm test`
Expected: typecheck 26/26；根 jest 全绿 + 1 skip（基线），无新增失败。**必须跑全量**（1a 教训）。

- [ ] **Step 2: 静态围栏 + Biome**

Run: `pnpm check && pnpm format && pnpm lint`
Expected: 围栏 0 问题（`listChildren` 单表读无事务、归属不变）；format 无改动；lint 无本分支文件的新告警。

- [ ] **Step 3: server-agent boot（保险）**

无新迁移/DI 装配，但 controller/service 改了，照 1a Task 8 Step 3 的隔离启动流程跑一遍（`MESHBOT_HOME="$(mktemp -d)"`，**勿碰仓库根 `.meshbot/`**）：确认启动无错、`/api/health` 200。端口以启动日志为准（PR #7 后自检，不再固定 3100）。

- [ ] **Step 4: 半自动冒烟（后端链路，需 dev 库已有模型配置）**

用 dev 环境（`pnpm dev:server-agent`，端口看启动日志）走 REST 验证认领链路：

```bash
# 1) 建会话并发消息，让主 Agent 派一个子任务（消息明确要求用 dispatch_subagent）
# （创建端点与请求体以 session.controller.ts / rest 层实际为准）
# 2) 轮询 GET /api/sessions/<父id>/history，直到出现 name=dispatch_subagent 的工具条目
# 3) 断言：该条目在子 run 进行中（status=running、result 为空）就已带 subSessionId
# 4) GET /api/sessions/<subSessionId>/history 返回子会话消息（≥1 条）
```

Expected: mid-run 即可拿到 `subSessionId`（Task 2 的核心验收）；子会话历史可拉取。若 dev 库无模型配置，此步降级为：直接对着 1a 的单测造数逻辑确认（Task 2 controller 单测已覆盖），并在报告中注明冒烟受限原因。

- [ ] **Step 5: UI 人工验收清单（交用户）**

起 `pnpm dev:web-agent` + `pnpm dev:server-agent`，人工核对并逐项记录：
1. 派发时嵌套卡出现、子 run 运行中自动展开、消息实时滴流；
2. 手动收起后不再自动展开；跑完自动收起、状态徽标「已完成」；
3. 子 run 进行中刷新父页面 → 卡还原并继续滴流（history 附带认领）；
4. 并行派发 ≥2 个 → 多卡并列互不串流；
5. 嵌套体内无头像/重试/反馈按钮；卡内滚动不影响父页面；
6. 中英文切换文案正常。

- [ ] **Step 6: 收尾提交（如有格式化改动）**

```bash
git add -A
git commit -m "chore: 派子 Agent Phase 1b 收尾（格式化 + 围栏）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review（计划自审）

- **Spec 覆盖**：三路认领 → T2（history 附带）+ T3（spawned 消费 + 结果兜底）；嵌套渲染 nested 变体 → T4；折叠策略（运行中自动展开）→ T3 状态机 + T4 组件；i18n → T4；错误边界（starting 占位 / error/aborted 徽标）→ T3 `resolveSubagentStatus` + T4；「收起不卸载」→ T4（open 只控渲染展开体，hook 常挂）；测试策略（纯函数 + 后端单测 + 全量 + 冒烟）→ T1-T5；明确不做清单 → Global Constraints。
- **占位符扫描**：无 TBD/TODO。「构造参数以文件实际为准」「创建端点以 rest 层实际为准」是现场核对点（依赖既有文件确切形态），非占位符。
- **类型一致性**：`subSessionId?: string` 贯穿 schema（T1）→ controller 组装（T2）→ `ToolCallView`/水合/claim（T3）→ `SubagentCard` 消费（T4）；`resolveSubSessionId/subagentTitle/resolveSubagentStatus/SubagentCollapse/isSubagentOpen/toggleSubagentOpen/claimSubagentOnTimeline` 的签名在 T3 定义、T4 按名消费一致；`MessageList` 的 `nested` prop 在 T4 内定义并消费。
- **范围**：单一 1b 增量，纯前端 + 一处后端组装增强，无迁移无新 Entity 无事务变化。
