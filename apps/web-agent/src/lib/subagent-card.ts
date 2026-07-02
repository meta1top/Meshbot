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
