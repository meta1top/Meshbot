# subagent「Agent 任务卡」UI 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按已确认设计稿把 dispatch_subagent 嵌套卡从「普通工具块样式」重做为「Agent 任务卡」：专属图标/状态胶囊/工具计数与耗时/折叠态当前动作行/终态结果行/footer/后台签。

**Architecture:** 纯前端（web-agent），后端零改动。新增展示派生纯函数入 `lib/subagent-card.ts`（零 import，根 jest 可测）；`SubagentCard` 组件整体重写（对外 props 与 tool-call-block 接入点不变）；认领/折叠/停止/settled 既有逻辑全部复用。

**Tech Stack:** React + Tailwind（web-agent 既有 token）、next-intl、内联 SVG、Jest（根配置纯函数测试）。

**设计 spec:** `docs/superpowers/specs/2026-07-03-subagent-task-card-design.md`（设计稿 artifact 链接在 spec §1）

## Global Constraints

- 分支 `feat/dispatch-subagent-background`（**直接做在 PR #10 分支上**，用户指定）。不自行 push——收尾由控制者推送更新 PR。
- `lib/subagent-card.ts` 零 import 纪律不变（根 jest node 环境）；新纯函数全部可测。
- 组件对外契约不变：`<SubagentCard tool={ToolCallView} />`，tool-call-block 特判不动；`useSessionStream` 用法（null 惰性、收起不卸载、吸底）不变；停止按钮条件与 sibling 结构语义不变。
- 视觉走既有 token（primary/destructive/muted/border）；语义绿允许 `#3D8A4E` 系（仓库有 bg-[#16a34a] 硬编码先例）；动效尊重 `prefers-reduced-motion`（Tailwind `motion-reduce:animate-none`）。
- i18n zh/en 键对称（pre-commit 强制；`session.subagent` 命名空间；既有键 `fallbackTitle/starting/running/done/error/aborted/stop` 复用不重定义）。
- 耗时为**前端本地计时**：仅当卡在挂载期间观察到 running 才起算/显示；刷新后已终态的卡不显示耗时（无起点）。
- 公开函数中文 JSDoc；Biome `if` 前一行不放注释；中文 conventional commits + 结尾 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
- 只跑本任务相关测试；全量根 jest 留 Task 3。

---

## File Structure

**修改：**
- `apps/web-agent/src/lib/subagent-card.ts`（+5 个纯函数）、`apps/web-agent/src/lib/subagent-card.spec.ts`
- `apps/web-agent/src/components/session/subagent-card.tsx`（整体重写）
- `apps/web-agent/messages/zh.json`、`apps/web-agent/messages/en.json`

---

## Task 1: 纯函数 — 展示派生（动作行/结果行/计数/耗时/后台签）

**Files:**
- Modify: `apps/web-agent/src/lib/subagent-card.ts`、`apps/web-agent/src/lib/subagent-card.spec.ts`

**Interfaces（Task 2 按名消费，签名 verbatim）:**

```ts
export interface SubagentStreamSlice {
  role: string;
  content: string;
  toolCalls?: Array<{ name: string; args?: unknown; status: string }>;
}
export type LiveAction =
  | { kind: "tool"; name: string; argsSummary: string }
  | { kind: "text"; text: string }
  | null;
export function deriveLiveAction(messages: SubagentStreamSlice[]): LiveAction;
export function firstLineOf(text: string, max?: number): string; // 默认 max=80
export function countToolCalls(messages: SubagentStreamSlice[]): number;
export function formatElapsed(ms: number): string; // 0:23 / 12:05 / 1:02:33
export function isBackgroundDispatch(args: unknown): boolean;
```

- [ ] **Step 1: 写失败测试**

`subagent-card.spec.ts` 追加（import 行补上述 5 个名字与 `LiveAction` 类型）：

```ts
describe("deriveLiveAction", () => {
  const msgs = (
    ...m: Array<{ role?: string; content?: string; toolCalls?: Array<{ name: string; args?: unknown; status: string }> }>
  ) => m.map((x) => ({ role: x.role ?? "assistant", content: x.content ?? "", toolCalls: x.toolCalls }));

  it("优先取最后一个 running/streaming 工具（含 args 摘要）", () => {
    const r = deriveLiveAction(
      msgs(
        { toolCalls: [{ name: "bash", args: { command: "ls" }, status: "ok" }] },
        { content: "中间文本" },
        { toolCalls: [{ name: "read_file", args: { file_path: "a.md" }, status: "running" }] },
      ),
    );
    expect(r).toEqual({ kind: "tool", name: "read_file", argsSummary: 'file_path: "a.md"' });
  });
  it("streaming 工具同样命中；args 缺省摘要为空串", () => {
    const r = deriveLiveAction(msgs({ toolCalls: [{ name: "bash", status: "streaming" }] }));
    expect(r).toEqual({ kind: "tool", name: "bash", argsSummary: "" });
  });
  it("无进行中工具 → 最后一条非空 assistant 正文的末行截断", () => {
    const r = deriveLiveAction(
      msgs({ content: "第一行\n对比三家的定价页后，主要差异在按席位与按用量两种模式" }, { role: "user", content: "无视我" }),
    );
    expect(r).toEqual({ kind: "text", text: "对比三家的定价页后，主要差异在按席位与按用量两种模式" });
  });
  it("末行超 80 字符截断加省略号", () => {
    const long = "a".repeat(100);
    const r = deriveLiveAction(msgs({ content: long }));
    expect(r).toEqual({ kind: "text", text: `${"a".repeat(80)}…` });
  });
  it("既无工具也无正文 → null", () => {
    expect(deriveLiveAction(msgs({ content: "" }))).toBeNull();
    expect(deriveLiveAction([])).toBeNull();
  });
  it("args 摘要多键拼接并整体截断 40 字符", () => {
    const r = deriveLiveAction(
      msgs({ toolCalls: [{ name: "bash", args: { command: "sleep 10 && echo 一段很长很长很长很长很长很长的命令", timeout: 5 }, status: "running" }] }),
    );
    expect(r?.kind).toBe("tool");
    if (r?.kind === "tool") {
      expect(r.argsSummary.length).toBeLessThanOrEqual(41); // 40 + 省略号
      expect(r.argsSummary.startsWith('command: "sleep 10')).toBe(true);
    }
  });
});

describe("firstLineOf", () => {
  it("取首个非空行并截断", () => {
    expect(firstLineOf("\n\n后台任务完成！Fri Jul 3\n第二行")).toBe("后台任务完成！Fri Jul 3");
    expect(firstLineOf("b".repeat(90))).toBe(`${"b".repeat(80)}…`);
    expect(firstLineOf("", 80)).toBe("");
  });
});

describe("countToolCalls / formatElapsed / isBackgroundDispatch", () => {
  it("countToolCalls 汇总 assistant 消息的工具数", () => {
    expect(
      countToolCalls([
        { role: "assistant", content: "", toolCalls: [{ name: "a", status: "ok" }, { name: "b", status: "ok" }] },
        { role: "user", content: "x" },
        { role: "assistant", content: "y", toolCalls: [{ name: "c", status: "running" }] },
      ]),
    ).toBe(3);
  });
  it("formatElapsed 三档格式", () => {
    expect(formatElapsed(23_000)).toBe("0:23");
    expect(formatElapsed(725_000)).toBe("12:05");
    expect(formatElapsed(3_753_000)).toBe("1:02:33");
  });
  it("isBackgroundDispatch 只认 args.background === true", () => {
    expect(isBackgroundDispatch({ background: true, task: "t" })).toBe(true);
    expect(isBackgroundDispatch({ task: "t" })).toBe(false);
    expect(isBackgroundDispatch(undefined)).toBe(false);
    expect(isBackgroundDispatch({ background: "true" })).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm jest apps/web-agent/src/lib/subagent-card.spec.ts`
Expected: FAIL（导出不存在）。

- [ ] **Step 3: 实现**

`subagent-card.ts` 末尾追加：

```ts
/** 子流消息的最小切片（展示派生用；结构化类型，避免 import 组件模块）。 */
export interface SubagentStreamSlice {
  role: string;
  content: string;
  toolCalls?: Array<{ name: string; args?: unknown; status: string }>;
}

/** 折叠态「当前动作行」：进行中工具 或 正文末行；两者皆无为 null。 */
export type LiveAction =
  | { kind: "tool"; name: string; argsSummary: string }
  | { kind: "text"; text: string }
  | null;

/** args 浅层 k:v 单行摘要（字符串带引号，其余 String 化），整体截断 40 字符。 */
function summarizeArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const parts = Object.entries(args as Record<string, unknown>).map(([k, v]) =>
    typeof v === "string" ? `${k}: "${v}"` : `${k}: ${String(v)}`,
  );
  const text = parts.join(", ");
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

/**
 * 派生折叠态「当前动作行」：从尾部找最后一个 running/streaming 工具调用
 * （名称原样返回，组件侧走 toolDisplayName 汉化）；没有则取最后一条非空
 * assistant 正文的末行（截 80）；两者皆无返回 null。
 */
export function deriveLiveAction(messages: SubagentStreamSlice[]): LiveAction {
  for (let i = messages.length - 1; i >= 0; i--) {
    const tcs = messages[i].toolCalls;
    if (!tcs) continue;
    for (let j = tcs.length - 1; j >= 0; j--) {
      const tc = tcs[j];
      if (tc.status === "running" || tc.status === "streaming") {
        return { kind: "tool", name: tc.name, argsSummary: summarizeArgs(tc.args) };
      }
    }
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant" || !m.content) continue;
    const lines = m.content.split("\n").filter((l) => l.trim() !== "");
    const last = lines[lines.length - 1];
    if (!last) continue;
    return {
      kind: "text",
      text: last.length > 80 ? `${last.slice(0, 80)}…` : last,
    };
  }
  return null;
}

/** 取首个非空行并按 max 截断（终态结果行用）。 */
export function firstLineOf(text: string, max = 80): string {
  const line = text.split("\n").find((l) => l.trim() !== "") ?? "";
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** 子流 assistant 消息的工具调用总数（meta 区计数）。 */
export function countToolCalls(messages: SubagentStreamSlice[]): number {
  return messages.reduce(
    (n, m) => (m.role === "assistant" ? n + (m.toolCalls?.length ?? 0) : n),
    0,
  );
}

/** 毫秒 → 0:23 / 12:05 / 1:02:33（本地计时展示）。 */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${sec}`;
  return `${m}:${sec}`;
}

/** 是否后台派发：只认工具 args.background === true（args 持久化，live/刷新皆可靠）。 */
export function isBackgroundDispatch(args: unknown): boolean {
  return (
    !!args &&
    typeof args === "object" &&
    (args as { background?: unknown }).background === true
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm jest apps/web-agent/src/lib/subagent-card.spec.ts`
Expected: 全绿（既有 17 + 新增 12）。

- [ ] **Step 5: 提交**

```bash
git add apps/web-agent/src/lib/subagent-card.ts apps/web-agent/src/lib/subagent-card.spec.ts
git commit -m "feat(web-agent): 任务卡展示派生纯函数（动作行/结果行/计数/耗时/后台签）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: SubagentCard 组件重写 + i18n

**Files:**
- Modify: `apps/web-agent/src/components/session/subagent-card.tsx`（整体重写）、`apps/web-agent/messages/zh.json`、`apps/web-agent/messages/en.json`

**Interfaces:**
- Consumes: Task 1 全部纯函数；既有 `resolveSubSessionId/subagentTitle/resolveSubagentStatus/SubagentCollapse/isSubagentOpen/toggleSubagentOpen`；`toolDisplayName`（`@/lib/tool-display`）；`useSessionStream`。
- Produces: 对外不变——`<SubagentCard tool={ToolCallView} />`。

- [ ] **Step 1: i18n 键（zh/en 对称）**

`zh.json` 的 `session.subagent` 内补（既有键不动）：

```json
"backgroundTag": "后台",
"toolsCount": "{count} 工具",
"elapsed": "用时 {elapsed}",
"runningAction": "正在执行",
"streamFooterRunning": "子会话 · {count} 条消息 · 输出实时滴流中",
"streamFooterDone": "子会话 · {count} 条消息",
"abortedResult": "已手动停止；已完成部分保留在子会话中",
"errorResult": "子 Agent 运行失败，未产出结果"
```

`en.json` 同位置：

```json
"backgroundTag": "Background",
"toolsCount": "{count} tools",
"elapsed": "{elapsed} elapsed",
"runningAction": "Running",
"streamFooterRunning": "Sub-session · {count} messages · streaming live",
"streamFooterDone": "Sub-session · {count} messages",
"abortedResult": "Stopped manually; partial results remain in the sub-session",
"errorResult": "Sub-agent failed to produce a result"
```

（若 sync-locales 对嵌套命名空间误报 missing，照 1b 先例按脚本提示补根层级空占位键。）

- [ ] **Step 2: 组件整体重写**

`subagent-card.tsx` 全文替换为：

```tsx
"use client";

import { cn } from "@meshbot/design";
import { ChevronDown, Square } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { useSessionStream } from "@/hooks/use-session-stream";
import {
  countToolCalls,
  deriveLiveAction,
  firstLineOf,
  formatElapsed,
  isBackgroundDispatch,
  isSubagentOpen,
  resolveSubagentStatus,
  resolveSubSessionId,
  type SubagentCollapse,
  subagentTitle,
  toggleSubagentOpen,
} from "@/lib/subagent-card";
import { toolDisplayName } from "@/lib/tool-display";
import { MessageList, type ToolCallView } from "./message-list";

/** 状态胶囊的样式与文案键（语义色不抢主 accent，运行中带呼吸点）。 */
const CHIP_STYLES: Record<string, string> = {
  starting: "text-muted-foreground bg-muted",
  running: "text-primary bg-primary/10",
  done: "text-[#3D8A4E] bg-[#3D8A4E]/10",
  error: "text-destructive bg-destructive/10",
  aborted: "text-muted-foreground bg-muted",
};
/** 专属图标底色按终态换语义色（主信号仍是胶囊）。 */
const GLYPH_STYLES: Record<string, string> = {
  starting: "bg-primary/50",
  running: "bg-primary",
  done: "bg-[#3D8A4E]",
  error: "bg-destructive",
  aborted: "bg-muted-foreground/60",
};

/** 子 Agent 专属图标：嵌套方块（外框 + 内实心），与普通工具块区分身份。 */
function SubagentGlyph({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "grid h-[22px] w-[22px] shrink-0 place-items-center rounded-[6px]",
        GLYPH_STYLES[status] ?? "bg-primary",
      )}
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <rect x="1" y="1" width="10" height="10" rx="2" stroke="#fff" strokeWidth="1.5" />
        <rect x="4.5" y="4.5" width="5" height="5" rx="1" fill="#fff" />
      </svg>
    </span>
  );
}

/**
 * dispatch_subagent「Agent 任务卡」：子 Agent 以迷你任务面板呈现——
 * 专属图标/状态胶囊/工具计数与本地耗时/折叠态当前动作行/终态结果行/footer。
 *
 * - 认领/折叠/停止/settled 逻辑全部复用既有纯函数与 hook，语义不变。
 * - 耗时为本地计时：挂载期间观察到 running 才起算，终态冻结；刷新后已
 *   终态的卡无起点、不显示。
 * - 收起只隐藏展开体 DOM，不卸载流；卸载时 hook 自清理。
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
  const active = status === "running" || status === "starting";
  const title = subagentTitle(tool.args) || t("fallbackTitle");
  const background = isBackgroundDispatch(tool.args);
  const toolCount = countToolCalls(sub.messages);

  // 本地耗时：首次观察到 running 起算，离开 running 冻结；每秒强制重渲染刷新读数。
  const startedAtRef = useRef<number | null>(null);
  const frozenRef = useRef<number | null>(null);
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (status === "running" && startedAtRef.current === null) {
      startedAtRef.current = Date.now();
    }
    if (
      status !== "running" &&
      status !== "starting" &&
      startedAtRef.current !== null &&
      frozenRef.current === null
    ) {
      frozenRef.current = Date.now() - startedAtRef.current;
    }
    if (status !== "running") return;
    const id = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [status]);
  const elapsedMs =
    frozenRef.current ??
    (startedAtRef.current !== null ? Date.now() - startedAtRef.current : null);

  // 子流有新内容且用户停在底部时吸底跟随。
  // biome-ignore lint/correctness/useExhaustiveDependencies: messages 是「内容变化触发器」，内容增长时吸底
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [sub.messages]);

  // 折叠态第二行：运行中=当前动作；终态=结果一句话。
  const liveAction = !open && status === "running" ? deriveLiveAction(sub.messages) : null;
  const resultLine = (() => {
    if (open || active) return null;
    if (status === "aborted") return t("abortedResult");
    if (status === "error") {
      const parsed = parseOutput(tool.result);
      return parsed ? firstLineOf(parsed) : t("errorResult");
    }
    const parsed = parseOutput(tool.result);
    return parsed ? firstLineOf(parsed) : null;
  })();

  return (
    <div
      className={cn(
        "flex w-full flex-col overflow-hidden rounded-[8px] border",
        status === "running" ? "border-primary/30" : "border-border",
      )}
    >
      <div
        className={cn(
          "flex w-full items-center",
          status === "running"
            ? "bg-gradient-to-r from-primary/10 to-muted/40"
            : "bg-muted/40",
        )}
      >
        <button
          type="button"
          onClick={() => setCollapse((s) => toggleSubagentOpen(s, childRunning))}
          className="group flex min-w-0 flex-1 items-center gap-2 px-2.5 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground"
          aria-expanded={open}
          disabled={subSessionId === null}
        >
          <SubagentGlyph status={status} />
          <span className="min-w-0 truncate text-[13px] font-semibold text-foreground">
            {title}
          </span>
          {background && (
            <span className="shrink-0 rounded-full border border-border px-2 py-px text-[11px]">
              {t("backgroundTag")}
            </span>
          )}
          <span
            className={cn(
              "flex shrink-0 items-center gap-1.5 rounded-full px-2 py-px text-[11px] font-medium",
              CHIP_STYLES[status],
            )}
          >
            {active && (
              <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse motion-reduce:animate-none" />
            )}
            {status === "done" && "✓ "}
            {status === "error" && "✗ "}
            {t(status)}
          </span>
          {(toolCount > 0 || elapsedMs !== null) && (
            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/60">
              {toolCount > 0 && t("toolsCount", { count: toolCount })}
              {toolCount > 0 && elapsedMs !== null && " · "}
              {elapsedMs !== null && formatElapsed(elapsedMs)}
            </span>
          )}
          <ChevronDown
            className={cn(
              "ml-auto h-3 w-3 shrink-0 transition-transform",
              !open && "-rotate-90",
            )}
          />
        </button>
        {active && subSessionId && (
          <button
            type="button"
            onClick={() => sub.interrupt()}
            title={t("stop")}
            className="shrink-0 px-2 py-1.5 text-muted-foreground hover:text-destructive"
          >
            <Square className="h-3 w-3" />
          </button>
        )}
      </div>
      {liveAction && (
        <div className="flex items-center gap-2 overflow-hidden border-t border-dashed border-border py-1.5 pl-10 pr-3 text-xs text-muted-foreground">
          <span className="h-2.5 w-2.5 shrink-0 animate-spin rounded-full border-[1.5px] border-muted-foreground/40 border-t-primary motion-reduce:animate-none" />
          {liveAction.kind === "tool" ? (
            <>
              <span className="shrink-0">{t("runningAction")}</span>
              <span className="truncate font-mono text-[11px]">
                {toolDisplayName(liveAction.name)}
                {liveAction.argsSummary && `（${liveAction.argsSummary}）`}
              </span>
            </>
          ) : (
            <span className="truncate">{liveAction.text}</span>
          )}
        </div>
      )}
      {resultLine && (
        <div className="flex gap-2 border-t border-dashed border-border py-1.5 pl-10 pr-3 text-xs text-muted-foreground">
          <span
            className={cn(
              "shrink-0",
              status === "done" && "text-[#3D8A4E]",
              status === "error" && "text-destructive",
            )}
          >
            →
          </span>
          <span className="truncate">{resultLine}</span>
        </div>
      )}
      {open && subSessionId && (
        <>
          <div
            ref={scrollRef}
            onScroll={() => {
              const el = scrollRef.current;
              if (el) {
                stickRef.current =
                  el.scrollHeight - el.scrollTop - el.clientHeight <= 24;
              }
            }}
            className="max-h-96 overflow-y-auto border-t border-border bg-muted/20 px-3 py-2"
          >
            <MessageList
              nested
              messages={sub.messages}
              sessionId={subSessionId}
              running={sub.running}
              onRegenerateOptimisticCut={() => {}}
            />
          </div>
          <div className="flex items-center gap-2 border-t border-border px-3 py-1 text-[11px] tabular-nums text-muted-foreground/60">
            {status === "running"
              ? t("streamFooterRunning", { count: sub.messages.length })
              : `${t("streamFooterDone", { count: sub.messages.length })}${
                  elapsedMs !== null
                    ? ` · ${t("elapsed", { elapsed: formatElapsed(elapsedMs) })}`
                    : ""
                }`}
          </div>
        </>
      )}
    </div>
  );
}

/** 解析工具结果 JSON 的 output 字段；非 JSON/缺失返回 null。 */
function parseOutput(result: string | undefined): string | null {
  if (!result) return null;
  try {
    const parsed = JSON.parse(result) as { output?: unknown };
    return typeof parsed.output === "string" && parsed.output
      ? parsed.output
      : null;
  } catch {
    return null;
  }
}
```

（`sub.messages` 传入 Task 1 纯函数处 TS 结构兼容：`TimelineMessage` 的 role/content/toolCalls 满足 `SubagentStreamSlice` 结构化类型；若 role 枚举与 string 不兼容按需 `as SubagentStreamSlice[]` 收窄并注释。）

- [ ] **Step 3: 验证**

Run:
```bash
pnpm jest apps/web-agent/src/lib
pnpm --filter @meshbot/web-agent typecheck
pnpm biome check apps/web-agent/src/components/session/subagent-card.tsx
tsx scripts/sync-locales.ts -- --check
```
Expected: 全绿；locales missing=0/asymmetric=0。

- [ ] **Step 4: 提交**

```bash
git add apps/web-agent/src/components/session/subagent-card.tsx \
        apps/web-agent/messages/zh.json apps/web-agent/messages/en.json
git commit -m "feat(web-agent): subagent 嵌套卡重做为 Agent 任务卡（六状态+动作行+结果行+footer）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 收尾验证

- [ ] **Step 1: 全量**

Run: `pnpm typecheck && pnpm test`
Expected: typecheck 26/26；根 jest 全绿+1 skip 无新增失败。

- [ ] **Step 2: 围栏 + Biome**

Run: `pnpm check && pnpm format && pnpm lint`
Expected: 全 0 问题、无改动残留。

- [ ] **Step 3: UI 人工验收清单（交用户，对照设计稿）**

1. 运行中·折叠：专属图标橙底、胶囊呼吸点、当前动作行实时滚动（工具名+args / 正文末行）、工具计数与秒表走字；
2. 运行中·展开：嵌套流正常 + footer「输出实时滴流中」；停止按钮可用；
3. 已完成/失败/已中止·折叠：图标换语义色、胶囊 ✓/✗/⏹、结果一句话正确（output 首行 / 既有错误文案 / 手动停止文案）；
4. 后台任务：「后台」描边签显示；前台不显示；
5. 启动中占位：图标半透明、胶囊「启动中」、不可展开、无停止；
6. 刷新：终态卡不显示耗时（无起点）；mid-run 刷新计时从刷新时刻重新起算（本地计时语义）；
7. 中英文切换文案正常；`prefers-reduced-motion` 下无动效。

- [ ] **Step 4: 收尾提交（如有格式化改动）**

```bash
git add -A
git commit -m "chore: 任务卡 UI 收尾（格式化）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review（计划自审）

- **Spec 覆盖**：§2.1 头部全要素（图标/签/胶囊/meta/停止/升温描边渐变）→T2；§2.2 动作行（派生规则三分支）→T1+T2；§2.3 结果行→T1 firstLineOf+T2；§2.4 footer→T2；§2.5 启动中→T2（disabled 展开）；§3 约束（零 import、args 摘要独立实现、i18n、reduced-motion）→T1/T2；§4 测试→T1 单测+T3 全量+人工清单。
- **占位符扫描**：无 TBD；「结构化类型兼容按需收窄」为现场核对点。
- **类型一致性**：T1 五个导出签名 = T2 import 与调用一致；`LiveAction` 判别联合在 T2 的 kind 分支使用一致；既有函数签名未动。
- **设计稿差异说明**：终态图标底色/胶囊配色按设计稿；「N 工具」计数条件渲染（0 工具不显示）为合理细化。
