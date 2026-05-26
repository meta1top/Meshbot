"use client";

import { ChevronDown, ChevronRight } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

interface CompactionRowProps {
  removedCount: number;
  summary: string;
}

/**
 * 时间线压缩占位行（折叠可展开看摘要）。
 *
 * 在 session_messages 中以 role=system + metadata.kind="compaction" 标识，
 * message-list 识别后用本组件渲染代替普通系统消息。
 */
export function CompactionRow({ removedCount, summary }: CompactionRowProps) {
  const [expanded, setExpanded] = useState(false);
  const t = useTranslations("session.compaction");
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
        <span>{t("rowTitle", { count: removedCount })}</span>
      </button>
      {expanded && (
        <pre className="mt-1 whitespace-pre-wrap text-[11px] leading-relaxed">
          {summary}
        </pre>
      )}
    </div>
  );
}
