"use client";

import {
  extractPartialString,
  parsePartialToolArgs,
} from "@meshbot/web-common";

/**
 * LLM 正在「打字」生成 write_file/edit_file 内容时的实时预览块。
 * 对未闭合的 args JSON 尽力部分解析，抽出 file_path + content/new_string 逐字展示。
 */
export function ToolCallArgsPreview({
  name,
  argsText,
}: {
  name?: string;
  argsText: string;
}) {
  const parsed = parsePartialToolArgs(argsText);
  const filePath = typeof parsed.file_path === "string" ? parsed.file_path : "";
  const body =
    extractPartialString(argsText, "content") ||
    extractPartialString(argsText, "new_string");
  const label = name ?? "tool";
  return (
    <div className="flex w-full flex-col rounded-[8px] border border-border overflow-hidden">
      <div className="flex w-full items-center gap-2 bg-muted/40 px-2.5 py-1.5 text-xs text-muted-foreground">
        <span className="inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-primary/70" />
        <span className="font-mono text-foreground">{label}</span>
        {filePath && (
          <span className="min-w-0 truncate font-mono text-muted-foreground/70">
            ({filePath})
          </span>
        )}
      </div>
      {body && (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap px-2.5 py-2 font-mono text-[11px] leading-relaxed text-foreground">
          {body}
          <span className="animate-pulse">▋</span>
        </pre>
      )}
    </div>
  );
}
