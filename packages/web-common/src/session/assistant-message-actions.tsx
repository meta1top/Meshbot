"use client";

import { cn, Tooltip, TooltipContent, TooltipTrigger } from "@meshbot/design";
import type { MessageUsage } from "@meshbot/types-agent";
import { Check, Copy, Info, ThumbsDown, ThumbsUp } from "lucide-react";
import { useCallback, useState } from "react";
import { formatTokens } from "./format-tokens";
import { type ModelConfigLike, resolveModelName } from "./model-name";

export interface AssistantMessageActionsLabels {
  copy: string;
  copied: string;
  usage: string;
  like: string;
  dislike: string;
  /** usage.model 未命中任何配置行且是雪花 id 形态：配置已被删除的兜底文案。 */
  deletedModel: string;
  inputLabel: string;
  cacheLabel: string;
  outputLabel: string;
  reasoningLabel: string;
  totalLabel: string;
}

export interface AssistantMessageActionsProps {
  sessionId: string;
  messageId: string;
  content: string;
  /** 该条 assistant 的单次 LLM 用量；无则不显示用量图标。 */
  usage?: MessageUsage;
  /** 初始反馈态（来自 history）。 */
  feedback?: "up" | "down" | null;
  /** 用量 tooltip 解析模型友好名所需的配置列表（原 `useModelConfigs()`，调用方注入）。 */
  modelConfigs?: ModelConfigLike[];
  /** 反馈提交（原 REST `setMessageFeedback`，调用方注入）。 */
  onFeedback: (
    sessionId: string,
    messageId: string,
    value: "up" | "down" | null,
  ) => Promise<unknown>;
  labels: AssistantMessageActionsLabels;
}

const BTN =
  "flex h-5 w-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40";

/**
 * assistant 气泡下方操作行：复制 / 用量 tooltip / 点赞 / 不喜欢。
 *
 * 从 `apps/web-agent/src/components/session/assistant-message-actions.tsx`
 * 迁入（Task 7）——`useTranslations` 改 `labels` props；`useModelConfigs()`
 * 改 `modelConfigs` props；`setMessageFeedback` REST 调用改 `onFeedback`
 * props 回调；`resolveModelName`/`formatTokens` 纯函数随迁本目录。
 *
 * hover 消息容器（外层 .group）才显示。点赞/不喜欢互斥 toggle，乐观 + 持久化。
 */
export function AssistantMessageActions({
  sessionId,
  messageId,
  content,
  usage,
  feedback,
  modelConfigs,
  onFeedback,
  labels,
}: AssistantMessageActionsProps) {
  const [copied, setCopied] = useState(false);
  const [current, setCurrent] = useState<"up" | "down" | null>(
    feedback ?? null,
  );
  const [busy, setBusy] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("复制失败", err);
    }
  }, [content]);

  const handleFeedback = useCallback(
    async (next: "up" | "down") => {
      if (busy) return;
      const target = current === next ? null : next;
      const prev = current;
      setCurrent(target);
      setBusy(true);
      try {
        await onFeedback(sessionId, messageId, target);
      } catch (err) {
        console.error("反馈失败", err);
        setCurrent(prev);
      } finally {
        setBusy(false);
      }
    },
    [busy, current, sessionId, messageId, onFeedback],
  );

  return (
    <div className="absolute top-1 right-2 z-10 hidden items-center gap-0.5 rounded-md border border-border bg-background p-0.5 shadow-xs group-hover:flex">
      <button
        type="button"
        onClick={handleCopy}
        title={copied ? labels.copied : labels.copy}
        className={BTN}
      >
        {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      </button>

      {usage && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" title={labels.usage} className={BTN}>
              <Info className="h-3 w-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent>
            <div className="space-y-0.5 text-xs">
              <div>
                {usage.modelName ??
                  resolveModelName(modelConfigs, usage.model) ??
                  labels.deletedModel}
              </div>
              <div>
                {labels.inputLabel} {formatTokens(usage.inputTokens)}
                {usage.cacheReadTokens > 0 &&
                  `（${labels.cacheLabel} ${formatTokens(usage.cacheReadTokens)}）`}
              </div>
              <div>
                {labels.outputLabel} {formatTokens(usage.outputTokens)}
                {usage.reasoningTokens > 0 &&
                  `（${labels.reasoningLabel} ${formatTokens(usage.reasoningTokens)}）`}
              </div>
              <div>
                {labels.totalLabel} {formatTokens(usage.totalTokens)}
              </div>
            </div>
          </TooltipContent>
        </Tooltip>
      )}

      <button
        type="button"
        onClick={() => handleFeedback("up")}
        disabled={busy}
        title={labels.like}
        className={cn(BTN, current === "up" && "text-accent hover:text-accent")}
      >
        <ThumbsUp className="h-3 w-3" />
      </button>
      <button
        type="button"
        onClick={() => handleFeedback("down")}
        disabled={busy}
        title={labels.dislike}
        className={cn(
          BTN,
          current === "down" && "text-accent hover:text-accent",
        )}
      >
        <ThumbsDown className="h-3 w-3" />
      </button>
    </div>
  );
}
