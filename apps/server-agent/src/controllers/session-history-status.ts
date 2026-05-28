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
