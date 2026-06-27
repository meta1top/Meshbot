# 会话级 todo（agent 任务规划/跟踪）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 加一个 `todo_write` 工具，让 agent 把稍长任务规划成一份可更新状态的待办清单；前端在消息流里渲染每次更新的 todo 卡，并在会话顶部常驻一个显示「当前最新」清单的面板。

**Architecture:** todos 是 `todo_write` 工具的参数（覆盖式整表），活在 LangGraph checkpointer 消息历史里（零 state schema / DB 改动）。前端从 `stream.messages` 派生最新一次 todo_write 的 todos 渲染常驻面板；tool-call-block 特判 `todo_write` 渲染消息流卡。

**Tech Stack:** TypeScript / NestJS（libs/agent，vitest）/ Next.js + Jotai（web-agent，jest）/ Zod。

## Global Constraints

- 持久层 = message 历史；**不碰** GraphState（当前仅 `messages` 单通道）、不加 entity/migration。
- libs/agent 框架无关：`todo_write` 是纯 `@Tool()`，无端口、无 I/O、无副作用。
- libs/types-* 纯 Zod/TS（schema + 类型放 types-agent，前后端共享）。
- 公开方法中文 JSDoc；不在 `if` 前一行放注释；中文提交（conventional commits）；commit 前 `pnpm check`。
- 单向：todo 只渲染、无用户交互回传。
- 状态枚举固定 `"pending" | "in_progress" | "completed"`；每项 `content` + `status` + `activeForm` 三字段必填非空。

---

## File Structure

**新建：**
- `libs/types-agent/src/todo.ts` — `todoItemSchema` / `todoWriteSchema` + `TodoItem` / `TodoWriteInput`。
- `libs/types-agent/src/todo.spec.ts` — schema jest 单测。
- `libs/agent/src/tools/builtins/todo-write.tool.ts` — `TodoWriteTool`。
- `libs/agent/tests/unit/todo-write.tool.test.ts` — 工具 vitest。
- `apps/web-agent/src/lib/todo.ts` — `selectLatestTodos` + `todoStatusMeta` 纯函数。
- `apps/web-agent/src/lib/todo.test.ts` — 纯函数 jest 单测。
- `apps/web-agent/src/components/session/todo-list.tsx` — 渲染 `TodoItem[]` 的共享展示组件。
- `apps/web-agent/src/components/session/todo-panel.tsx` — 会话常驻面板（从 messages 派生）。

**修改：**
- `libs/types-agent/src/index.ts` — re-export `./todo`。
- `libs/agent/src/agent.module.ts` — providers 注册 `TodoWriteTool`。
- `apps/web-agent/src/components/session/tool-call-block.tsx` — 特判 `todo_write` 渲染消息流卡。
- `apps/web-agent/src/components/session/message-list.tsx` — 顶部挂 `TodoPanel`。

---

## Task 1: types-agent — todoWriteSchema

**Files:**
- Create: `libs/types-agent/src/todo.ts`
- Test: `libs/types-agent/src/todo.spec.ts`
- Modify: `libs/types-agent/src/index.ts`

**Interfaces:**
- Produces: `todoItemSchema`、`todoWriteSchema` → `{ todos: TodoItem[] }`（todos 非空）；`TodoItem` = `{ content: string; status: "pending"|"in_progress"|"completed"; activeForm: string }`；`TodoWriteInput`。

- [ ] **Step 1: 写失败单测**

创建 `libs/types-agent/src/todo.spec.ts`：

```ts
import { describe, expect, it } from "@jest/globals";
import { todoWriteSchema } from "./todo";

describe("todoWriteSchema", () => {
  it("接受合法 todos（三字段 + 合法 status）", () => {
    const parsed = todoWriteSchema.parse({
      todos: [
        { content: "修复登录 bug", status: "in_progress", activeForm: "正在修复登录 bug" },
        { content: "写测试", status: "pending", activeForm: "正在写测试" },
      ],
    });
    expect(parsed.todos).toHaveLength(2);
    expect(parsed.todos[0].status).toBe("in_progress");
  });

  it("todos 不能为空数组", () => {
    expect(() => todoWriteSchema.parse({ todos: [] })).toThrow();
  });

  it("status 限三枚举", () => {
    expect(() =>
      todoWriteSchema.parse({
        todos: [{ content: "x", status: "doing", activeForm: "y" }],
      }),
    ).toThrow();
  });

  it("content / activeForm 必填非空", () => {
    expect(() =>
      todoWriteSchema.parse({
        todos: [{ content: "", status: "pending", activeForm: "y" }],
      }),
    ).toThrow();
    expect(() =>
      todoWriteSchema.parse({
        todos: [{ content: "x", status: "pending", activeForm: "" }],
      }),
    ).toThrow();
    expect(() =>
      todoWriteSchema.parse({ todos: [{ content: "x", status: "pending" }] }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test -- libs/types-agent/src/todo.spec.ts`
Expected: FAIL —— `Cannot find module './todo'`。

- [ ] **Step 3: 实现**

创建 `libs/types-agent/src/todo.ts`：

```ts
import { z } from "zod";

/** 单条待办：描述 + 状态 + 进行中标签。 */
export const todoItemSchema = z.object({
  content: z.string().min(1),
  status: z.enum(["pending", "in_progress", "completed"]),
  activeForm: z.string().min(1),
});
export type TodoItem = z.infer<typeof todoItemSchema>;

/** todo_write 入参：覆盖式整表（非空）。 */
export const todoWriteSchema = z.object({
  todos: z.array(todoItemSchema).min(1),
});
export type TodoWriteInput = z.infer<typeof todoWriteSchema>;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test -- libs/types-agent/src/todo.spec.ts`
Expected: PASS。

- [ ] **Step 5: 导出 + 提交**

在 `libs/types-agent/src/index.ts` 现有 `export * from "./quick-assistant";` 同处追加 `export * from "./todo";`。

```bash
pnpm turbo typecheck --filter=@meshbot/types-agent
git add libs/types-agent/src/todo.ts libs/types-agent/src/todo.spec.ts libs/types-agent/src/index.ts
git commit -m "feat(types-agent): todoWriteSchema（content/status/activeForm）"
```

---

## Task 2: libs/agent — todo_write 工具 + 注册

**Files:**
- Create: `libs/agent/src/tools/builtins/todo-write.tool.ts`
- Test: `libs/agent/tests/unit/todo-write.tool.test.ts`
- Modify: `libs/agent/src/agent.module.ts`

**Interfaces:**
- Consumes: `todoWriteSchema` / `TodoWriteInput`（Task 1）；`MeshbotTool` / `ToolContext`（`../tool.types`）；`@Tool`（`../tool.decorator`）。
- Produces: 工具名 `todo_write`，`execute` 返回当前进度摘要字符串。

- [ ] **Step 1: 写失败单测**

创建 `libs/agent/tests/unit/todo-write.tool.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { TodoWriteTool } from "../../src/tools/builtins/todo-write.tool";

describe("todo_write tool", () => {
  it("返回含进度（完成数/总数）与各项状态的摘要", async () => {
    const tool = new TodoWriteTool();
    expect(tool.name).toBe("todo_write");
    const out = await tool.execute(
      {
        todos: [
          { content: "A", status: "completed", activeForm: "正在 A" },
          { content: "B", status: "in_progress", activeForm: "正在 B" },
          { content: "C", status: "pending", activeForm: "正在 C" },
        ],
      },
      {} as never,
    );
    expect(out).toContain("1/3");
    expect(out).toContain("正在 B");
    expect(out).toContain("C");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd libs/agent && npx vitest run tests/unit/todo-write.tool.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

创建 `libs/agent/src/tools/builtins/todo-write.tool.ts`：

```ts
import { type TodoWriteInput, todoWriteSchema } from "@meshbot/types-agent";
import { Injectable } from "@nestjs/common";
import { Tool } from "../tool.decorator";
import type { MeshbotTool, ToolContext } from "../tool.types";

@Injectable()
@Tool()
export class TodoWriteTool implements MeshbotTool<TodoWriteInput, string> {
  readonly name = "todo_write";
  readonly description =
    "Plan and track a multi-step task as a todo list. Pass the COMPLETE list every " +
    "call (it overwrites). Mark a task in_progress right before you start it and " +
    "completed as soon as it's done; keep at most one in_progress. Skip this for " +
    "trivial single-step tasks. Each item: content (imperative), status, activeForm " +
    "(present-tense label shown while in progress).";
  readonly schema = todoWriteSchema;

  /** 覆盖式写待办清单；返回当前进度摘要（回灌 agent 上下文）。 */
  async execute(args: TodoWriteInput, _ctx: ToolContext): Promise<string> {
    const done = args.todos.filter((t) => t.status === "completed").length;
    const lines = args.todos.map((t) => {
      const mark =
        t.status === "completed"
          ? "[x]"
          : t.status === "in_progress"
            ? "[~]"
            : "[ ]";
      const text = t.status === "in_progress" ? t.activeForm : t.content;
      return `${mark} ${text}`;
    });
    return `待办已更新（${done}/${args.todos.length} 完成）：\n${lines.join("\n")}`;
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd libs/agent && npx vitest run tests/unit/todo-write.tool.test.ts`
Expected: PASS。

- [ ] **Step 5: 注册到 AgentModule**

`libs/agent/src/agent.module.ts`：顶部加 `import { TodoWriteTool } from "./tools/builtins/todo-write.tool";`；在 providers 数组 `DateTool,` 之后加 `TodoWriteTool,`。

- [ ] **Step 6: typecheck + 提交**

```bash
pnpm turbo typecheck --filter=@meshbot/agent
git add libs/agent/src/tools/builtins/todo-write.tool.ts libs/agent/tests/unit/todo-write.tool.test.ts libs/agent/src/agent.module.ts
git commit -m "feat(agent): todo_write 工具（覆盖式待办 + 进度摘要）"
```

---

## Task 3: web-agent — selectLatestTodos / todoStatusMeta 纯函数

**Files:**
- Create: `apps/web-agent/src/lib/todo.ts`
- Test: `apps/web-agent/src/lib/todo.test.ts`

**Interfaces:**
- Consumes: `TodoItem`（`@meshbot/types-agent`）。
- Produces:
  - `selectLatestTodos(messages): TodoItem[]` —— 从消息历史取最新一次 `todo_write` 的 `args.todos`，无则 `[]`。参数用最小鸭子类型 `{ role: string; toolCalls?: { name: string; args?: unknown }[] }[]`（兼容 `TimelineMessage[]`）。
  - `todoStatusMeta(status): { label: string; className: string }` —— 状态 → 展示元信息。

- [ ] **Step 1: 写失败单测**

创建 `apps/web-agent/src/lib/todo.test.ts`：

```ts
import { describe, expect, it } from "@jest/globals";
import { selectLatestTodos, todoStatusMeta } from "./todo";

const tc = (name: string, todos: unknown) => ({
  role: "assistant",
  toolCalls: [{ name, args: { todos } }],
});

describe("selectLatestTodos", () => {
  it("取最新一次 todo_write 的 todos", () => {
    const messages = [
      tc("todo_write", [{ content: "旧", status: "pending", activeForm: "x" }]),
      { role: "user" },
      tc("todo_write", [
        { content: "新", status: "completed", activeForm: "y" },
      ]),
    ];
    const todos = selectLatestTodos(messages as never);
    expect(todos).toHaveLength(1);
    expect(todos[0].content).toBe("新");
  });

  it("无 todo_write → 空数组", () => {
    expect(
      selectLatestTodos([
        { role: "assistant", toolCalls: [{ name: "date", args: {} }] },
        { role: "user" },
      ] as never),
    ).toEqual([]);
  });
});

describe("todoStatusMeta", () => {
  it("三状态各有 label", () => {
    expect(todoStatusMeta("pending").label).toBeTruthy();
    expect(todoStatusMeta("in_progress").label).toBeTruthy();
    expect(todoStatusMeta("completed").label).toBeTruthy();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test -- apps/web-agent/src/lib/todo.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

创建 `apps/web-agent/src/lib/todo.ts`：

```ts
import type { TodoItem } from "@meshbot/types-agent";

type ToolCallLike = { name: string; args?: unknown };
type MessageLike = { role: string; toolCalls?: ToolCallLike[] };

/** 从消息历史取最新一次 todo_write 的 todos；无则空数组。 */
export function selectLatestTodos(messages: MessageLike[]): TodoItem[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const tcs = messages[i].toolCalls;
    if (!tcs) {
      continue;
    }
    for (let j = tcs.length - 1; j >= 0; j--) {
      if (tcs[j].name !== "todo_write") {
        continue;
      }
      const args = tcs[j].args as { todos?: TodoItem[] } | undefined;
      if (args?.todos) {
        return args.todos;
      }
    }
  }
  return [];
}

/** 状态 → 展示元信息（label + 文案 className）。 */
export function todoStatusMeta(status: TodoItem["status"]): {
  label: string;
  className: string;
} {
  switch (status) {
    case "completed":
      return { label: "已完成", className: "text-muted-foreground line-through" };
    case "in_progress":
      return { label: "进行中", className: "text-foreground font-medium" };
    default:
      return { label: "待办", className: "text-muted-foreground" };
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test -- apps/web-agent/src/lib/todo.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
pnpm turbo typecheck --filter=@meshbot/web-agent
git add apps/web-agent/src/lib/todo.ts apps/web-agent/src/lib/todo.test.ts
git commit -m "feat(web-agent): selectLatestTodos / todoStatusMeta 纯函数"
```

---

## Task 4: web-agent — TodoList 展示 + 消息流卡 + 常驻面板

**Files:**
- Create: `apps/web-agent/src/components/session/todo-list.tsx`
- Create: `apps/web-agent/src/components/session/todo-panel.tsx`
- Modify: `apps/web-agent/src/components/session/tool-call-block.tsx`
- Modify: `apps/web-agent/src/components/session/message-list.tsx`

**Interfaces:**
- Consumes: `TodoItem`（`@meshbot/types-agent`）；`selectLatestTodos` / `todoStatusMeta`（Task 3）；`ToolCallView`（`./message-list`，字段 `name`/`args`/`status`）。

- [ ] **Step 1: 共享展示组件 TodoList**

创建 `apps/web-agent/src/components/session/todo-list.tsx`：

```tsx
"use client";

import { cn } from "@meshbot/design";
import type { TodoItem } from "@meshbot/types-agent";
import { Circle, CircleCheck, CircleDot } from "lucide-react";
import { todoStatusMeta } from "@/lib/todo";

/** 渲染一份 todo 清单：状态图标 + 文案（进行中显示 activeForm）。 */
export function TodoList({ todos }: { todos: TodoItem[] }) {
  return (
    <div className="flex flex-col gap-1">
      {todos.map((t, i) => {
        const meta = todoStatusMeta(t.status);
        const Icon =
          t.status === "completed"
            ? CircleCheck
            : t.status === "in_progress"
              ? CircleDot
              : Circle;
        return (
          <div key={`${i}-${t.content}`} className="flex items-start gap-2 text-sm">
            <Icon
              className={cn(
                "mt-0.5 h-3.5 w-3.5 shrink-0",
                t.status === "completed"
                  ? "text-(--shell-accent)"
                  : t.status === "in_progress"
                    ? "text-primary"
                    : "text-muted-foreground/50",
              )}
            />
            <span className={meta.className}>
              {t.status === "in_progress" ? t.activeForm : t.content}
            </span>
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: 消息流卡 —— tool-call-block 特判**

`apps/web-agent/src/components/session/tool-call-block.tsx`：
1. import：`import { TodoList } from "./todo-list";` 与 `import type { TodoItem } from "@meshbot/types-agent";`
2. 在现有 `if (tool.name === "im_send_message" && tool.status !== "streaming")` 特判**之后**（同样在 `useState(open)` 之后、其余逻辑之前）加：

```tsx
  if (tool.name === "todo_write" && tool.status !== "streaming") {
    const todos = ((tool.args ?? {}) as { todos?: TodoItem[] }).todos ?? [];
    return (
      <div className="flex w-full flex-col gap-1.5 rounded-[8px] border border-border bg-muted/30 px-3 py-2">
        <div className="text-xs font-medium text-muted-foreground">待办清单</div>
        <TodoList todos={todos} />
      </div>
    );
  }
```

- [ ] **Step 3: 常驻面板 TodoPanel**

创建 `apps/web-agent/src/components/session/todo-panel.tsx`：

```tsx
"use client";

import { ListTodo } from "lucide-react";
import { selectLatestTodos } from "@/lib/todo";
import { TodoList } from "./todo-list";
import type { TimelineMessage } from "./message-list";

/** 会话常驻待办面板：从消息历史派生「当前最新」清单；空则不渲染。 */
export function TodoPanel({ messages }: { messages: TimelineMessage[] }) {
  const todos = selectLatestTodos(messages);
  if (todos.length === 0) {
    return null;
  }
  const done = todos.filter((t) => t.status === "completed").length;
  return (
    <div className="sticky top-0 z-10 mb-2 flex flex-col gap-1.5 rounded-[8px] border border-border bg-background/95 px-3 py-2 backdrop-blur">
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <ListTodo className="h-3.5 w-3.5" />
        待办（{done}/{todos.length} 完成）
      </div>
      <TodoList todos={todos} />
    </div>
  );
}
```

（若 `TimelineMessage` 未从 `message-list.tsx` 导出，则在 message-list 给该 interface 加 `export`，再 import；先 `rg -n "interface TimelineMessage|export interface TimelineMessage" apps/web-agent/src/components/session/message-list.tsx` 确认。）

- [ ] **Step 4: 在 MessageList 顶部挂 TodoPanel**

`apps/web-agent/src/components/session/message-list.tsx`：
1. import：`import { TodoPanel } from "./todo-panel";`
2. 在 `return (` 的最外层 `<div className="flex flex-col gap-1 pb-6">` 内、`{messages.filter(...)` 之前插入：

```tsx
      <TodoPanel messages={messages} />
```

- [ ] **Step 5: typecheck + 提交**

Run: `pnpm turbo typecheck --filter=@meshbot/web-agent`
Expected: 全绿。

```bash
git add apps/web-agent/src/components/session/todo-list.tsx apps/web-agent/src/components/session/todo-panel.tsx apps/web-agent/src/components/session/tool-call-block.tsx apps/web-agent/src/components/session/message-list.tsx
git commit -m "feat(web-agent): todo 消息流卡 + 会话常驻 TodoPanel"
```

---

## Task 5: 集成验证

**Files:** 无（验证）。

- [ ] **Step 1: 全包 typecheck**

Run: `pnpm typecheck`
Expected: 全绿。

- [ ] **Step 2: 全量 jest**

Run: `pnpm test`
Expected: 新增 todo 单测绿；2 个失败套件仍是预存在基线（`session.e2e`、`use-global-events.spec`），零新增其它失败。

- [ ] **Step 3: libs/agent vitest 基线**

Run: `cd libs/agent && npx vitest run`
Expected: 9 个预存在基线失败不变 + 新增 todo-write.tool.test 绿；passed 数增加。

- [ ] **Step 4: 静态围栏**

Run: `pnpm check`
Expected: exit 0（tx-fence 仍是 `conversation.service.ts:280` 预存在基线 `unchanged=1`）。

- [ ] **Step 5: 手动冒烟（可选，需登录）**

启 server-agent + web-agent，给助手一个稍长任务（如「分三步帮我重构 X」），观察：① agent 调 `todo_write`、消息流出现待办卡 ② 会话顶部常驻面板显示当前清单、随 agent 推进刷新状态 ③ 完成项弱化/打勾。

> 无 boot DI 验证必要：纯加工具，无 provider/module 结构变更、无 entity/迁移。

---

## Self-Review（已核对）

- **Spec 覆盖**：§2 持久层（message 历史，无 GraphState/DB 改动 —— 全程无 entity/migration/state 改动）；§3 工具（Task 1/2）；§4.1 消息流卡（Task 4 Step 2）+ §4.2 常驻面板从 messages 派生（Task 3 selectLatestTodos + Task 4 Step 3/4）；§6 单向（无 confirm 端点/HITL）；§7 测试（types-agent schema、工具 vitest、前端纯函数 jest）。
- **占位符**：无 TBD/TODO；每代码步给完整代码 + 命令 + 预期。
- **类型一致**：`TodoItem`（content/status/activeForm）在 types-agent 定义，libs/agent 工具、web-agent selectLatestTodos/TodoList/TodoPanel 三处消费一致；`selectLatestTodos` 返回 `TodoItem[]` 与 TodoList/TodoPanel 入参一致；工具名 `"todo_write"` 在工具定义、tool-call-block 特判、selectLatestTodos 过滤三处一致。
