import {
  disableErrorLogging,
  parse as parseBestEffort,
} from "best-effort-json-parser";

// 我们本就是故意解析流式（未闭合/带多余 token）的 tool_call args——库内部对
// 「多余 token」会 console.error（非致命，解析结果照常返回），但 Next dev overlay
// 会把它弹成报错、且我们的 try/catch 抓不到它。流式场景下这是预期噪声，静音。
disableErrorLogging();

/**
 * 尽力解析流式（可能未闭合）的 tool_call args JSON。
 * 任何异常都吞掉，返回空对象 —— 调用方据此「退回上一次成功值」。
 */
export function parsePartialToolArgs(text: string): Record<string, unknown> {
  if (!text || !text.trim()) return {};
  try {
    const v = parseBestEffort(text) as unknown;
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** 从流式 args 里取某个字符串字段（content / new_string），取不到返回空串。 */
export function extractPartialString(text: string, key: string): string {
  const v = parsePartialToolArgs(text)[key];
  return typeof v === "string" ? v : "";
}
