"use client";

import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";

export interface CompactionRowLabels {
  /** 折叠行标题：`已压缩 {count} 条早期消息`（count 由调用方插值）。 */
  rowTitle: (count: number) => string;
}

export interface CompactionRowProps {
  removedCount: number;
  summary: string;
  labels: CompactionRowLabels;
}

/**
 * 时间线压缩占位行（折叠可展开看摘要）。
 *
 * 从 `apps/web-agent/src/components/session/compaction-row.tsx` 迁入
 * （Task 9 骨干批，随 `MessageList` 一并迁移——message-list 渲染压缩占位行
 * 时唯一消费方）。`useTranslations` 改 `labels` props；`rowTitle` 因带
 * `{count}` 插值参数，labels 里是函数而非静态字符串。
 *
 * 在 session_messages 中以 role=system + metadata.kind="compaction" 标识，
 * message-list 识别后用本组件渲染代替普通系统消息。
 */
export function CompactionRow({
  removedCount,
  summary,
  labels,
}: CompactionRowProps) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="flex flex-col gap-1 border-l-2 border-muted-foreground/30 pl-3 text-xs text-muted-foreground">
      <button
        type="button"
        className="flex items-center gap-1.5 hover:text-foreground"
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        <span>{labels.rowTitle(removedCount)}</span>
      </button>
      {expanded && (
        <pre className="mt-1 whitespace-pre-wrap text-[11px] leading-relaxed">
          {summary}
        </pre>
      )}
    </div>
  );
}
