"use client";

import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";

export interface SystemEventRowLabels {
  /** 压缩文案：`已压缩 {count} 条早期消息`（count 由调用方插值）。 */
  compactionTitle: (count: number) => string;
  /** 切模型文案：`已切换模型：{from} → {to}`（from/to 由调用方插值）。 */
  modelSwitch: (from: string, to: string) => string;
}

export interface SystemEventRowProps {
  /**
   * 系统事件种类（来自 `HistoryMessage.metadata.kind` / `RunSystemEvent.kind`）。
   * 目前识别 `"compaction"` / `"model_switch"`；其余取值（未来新 kind）安全跳过。
   */
  kind: string;
  /**
   * 展示文案来源（`HistoryMessage.content` 同源）。仅 `compaction` 使用——展开后
   * 显示完整摘要正文；`model_switch` 不使用（改用 `metadata.fromModel`/`toModel`
   * 走前端 i18n 模板，服务端为非 i18n 场景预生成的中文 content 仅供兜底/调试，
   * 不在此渲染，避免绕开多语言）。
   */
  content: string;
  /** 结构化附加数据（不含 kind），与 `HistoryMessage.metadata` 除 kind 外的部分同源。 */
  metadata: Record<string, unknown> | null | undefined;
  labels: SystemEventRowLabels;
}

/**
 * 时间线里的居中系统事件行：一行极小灰字 + 两侧 `flex-1` 淡分隔线
 * （`── 文案 ──`），对齐 Claude Code 的系统提示呈现范式。
 *
 * 取代原先的 `CompactionRow`（左对齐竖线占位行）+ 顶部 `CompactionBanner`：
 * - `kind="compaction"`：可点击展开/收起完整摘要（`content`），标题按
 *   `metadata.removedCount` 插值。
 * - `kind="model_switch"`：纯文案提示，不可点击，按 `metadata.fromModel`/
 *   `metadata.toModel` 插值。
 * - 未知 kind（向后兼容未来新种类）：安全跳过，不渲染任何 DOM——调用方
 *   （`MessageList`）不需要预先过滤，直接把 `role==="system"` 的消息交给本
 *   组件即可。
 */
export function SystemEventRow({
  kind,
  content,
  metadata,
  labels,
}: SystemEventRowProps) {
  const [expanded, setExpanded] = useState(false);

  if (kind === "compaction") {
    const removedCount =
      typeof metadata?.removedCount === "number" ? metadata.removedCount : 0;
    return (
      <div className="flex flex-col gap-1 py-1.5">
        <div className="flex items-center gap-3">
          <span aria-hidden className="h-px flex-1 bg-border" />
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            aria-expanded={expanded}
          >
            {expanded ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            <span>{labels.compactionTitle(removedCount)}</span>
          </button>
          <span aria-hidden className="h-px flex-1 bg-border" />
        </div>
        {expanded && (
          <pre className="mx-auto max-w-prose whitespace-pre-wrap text-[11px] leading-relaxed text-muted-foreground">
            {content}
          </pre>
        )}
      </div>
    );
  }

  if (kind === "model_switch") {
    const fromModel =
      typeof metadata?.fromModel === "string" ? metadata.fromModel : "";
    const toModel =
      typeof metadata?.toModel === "string" ? metadata.toModel : "";
    return (
      <div className="flex items-center gap-3 py-1.5">
        <span aria-hidden className="h-px flex-1 bg-border" />
        <span className="shrink-0 text-xs text-muted-foreground">
          {labels.modelSwitch(fromModel, toModel)}
        </span>
        <span aria-hidden className="h-px flex-1 bg-border" />
      </div>
    );
  }

  // 未知 kind：安全跳过，向后兼容未来新增的系统行种类（见 spec §四）。
  return null;
}
