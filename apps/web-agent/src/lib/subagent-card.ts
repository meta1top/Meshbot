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

/** 嵌套卡展示状态：运行中 / 成功 / 出错 / 被中止。 */
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
      if (parsed.status === "running") {
        // 后台派发的立即返回态：子流在跑时入口的 childRunning 早退已返回
        // "running"，能走到这里说明子流已停——settled 尚未到/行未重写的
        // 毫秒级间隙按 done 兜底。
        return "done";
      }
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

/**
 * 未认领（subSessionId 解析为 null）时的终局兜底：排队期 abort/父会话缺失，
 * dispatch 会直接返回 `{subSessionId:"",status:"error"|"aborted",...}`——卡拿不到
 * 子会话 id，走不到 resolveSubagentStatus，会永远停在「启动中」（脉动）。
 * 从 tool.result 解析出终态（error/aborted）则返回，否则返回 null
 * （真处于排队中/无结果，调用方兜底为 starting）。
 */
export function resolveUnclaimedStatus(tool: {
  result?: string;
}): SubagentStatus | null {
  if (!tool.result) return null;
  try {
    const parsed = JSON.parse(tool.result) as { status?: unknown };
    return parsed.status === "error" || parsed.status === "aborted"
      ? parsed.status
      : null;
  } catch {
    return null;
  }
}

/** 折叠状态：auto 跟随子 run（运行→展开、结束→收起）；用户点击后转 manual 不再自动。 */
export type SubagentCollapse =
  | { mode: "auto" }
  | { mode: "manual"; open: boolean };

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
  T extends {
    toolCalls?: Array<{ toolCallId: string; subSessionId?: string }>;
  },
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

/**
 * 后台子任务终态打标：按 toolCallId 把工具条目的 result 重写为终局 JSON
 * （消费 run.subagent_settled）。未命中返回原数组引用。
 */
export function settleSubagentOnTimeline<
  T extends { toolCalls?: Array<{ toolCallId: string; result?: string }> },
>(prev: T[], toolCallId: string, resultJson: string): T[] {
  let changed = false;
  const next = prev.map((m) => {
    if (!m.toolCalls?.some((t) => t.toolCallId === toolCallId)) return m;
    changed = true;
    // 泛型展开覆写属性后 TS 无法证明仍是 T，运行时结构未变，安全收窄
    return {
      ...m,
      toolCalls: m.toolCalls.map((t) =>
        t.toolCallId === toolCallId ? { ...t, result: resultJson } : t,
      ),
    } as T;
  });
  return changed ? next : prev;
}

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

/**
 * 按 Unicode 代码点安全截断（`Array.from` 逐码点切分，不劈开代理对/emoji），
 * 超出 max 时追加省略号；未超出原样返回。
 */
export function truncate(str: string, max: number): string {
  const codePoints = Array.from(str);
  return codePoints.length > max
    ? `${codePoints.slice(0, max).join("")}…`
    : str;
}

/** args 浅层 k:v 单行摘要（字符串带引号，其余 String 化），整体截断 40 字符。 */
function summarizeArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const parts = Object.entries(args as Record<string, unknown>).map(([k, v]) =>
    typeof v === "string" ? `${k}: "${v}"` : `${k}: ${String(v)}`,
  );
  return truncate(parts.join(", "), 40);
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
        return {
          kind: "tool",
          name: tc.name,
          argsSummary: summarizeArgs(tc.args),
        };
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
      text: truncate(last, 80),
    };
  }
  return null;
}

/** 取首个非空行并按 max 截断（终态结果行用）。 */
export function firstLineOf(text: string, max = 80): string {
  const line = text.split("\n").find((l) => l.trim() !== "") ?? "";
  return truncate(line, max);
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
