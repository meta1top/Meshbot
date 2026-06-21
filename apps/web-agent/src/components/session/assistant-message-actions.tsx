"use client";

import { cn, Tooltip, TooltipContent, TooltipTrigger } from "@meshbot/design";
import type { MessageUsage } from "@meshbot/types-agent";
import { Check, Copy, Info, ThumbsDown, ThumbsUp } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useState } from "react";
import { formatTokens } from "@/lib/format-tokens";
import { setMessageFeedback } from "@/rest/session";

interface Props {
  sessionId: string;
  messageId: string;
  content: string;
  /** 该条 assistant 的单次 LLM 用量；无则不显示用量图标。 */
  usage?: MessageUsage;
  /** 初始反馈态（来自 history）。 */
  feedback?: "up" | "down" | null;
}

const BTN =
  "flex h-5 w-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40";

/**
 * assistant 气泡下方操作行：复制 / 用量 tooltip / 点赞 / 不喜欢。
 * hover 消息容器（外层 .group）才显示。点赞/不喜欢互斥 toggle，乐观 + 持久化。
 */
export function AssistantMessageActions({
  sessionId,
  messageId,
  content,
  usage,
  feedback,
}: Props) {
  const t = useTranslations("session");
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
        await setMessageFeedback(sessionId, messageId, target);
      } catch (err) {
        console.error("反馈失败", err);
        setCurrent(prev);
      } finally {
        setBusy(false);
      }
    },
    [busy, current, sessionId, messageId],
  );

  return (
    <div className="absolute top-1 right-2 z-10 hidden items-center gap-0.5 rounded-md border border-border bg-background p-0.5 shadow-xs group-hover:flex">
      <button
        type="button"
        onClick={handleCopy}
        title={copied ? t("actions.copied") : t("actions.copy")}
        className={BTN}
      >
        {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      </button>

      {usage && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" title={t("actions.usage")} className={BTN}>
              <Info className="h-3 w-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent>
            <div className="space-y-0.5 text-xs">
              <div>{usage.model}</div>
              <div>
                {t("usage.inputLabel")} {formatTokens(usage.inputTokens)}
                {usage.cacheReadTokens > 0 &&
                  `（${t("usage.cacheLabel")} ${formatTokens(usage.cacheReadTokens)}）`}
              </div>
              <div>
                {t("usage.outputLabel")} {formatTokens(usage.outputTokens)}
                {usage.reasoningTokens > 0 &&
                  `（${t("usage.reasoningLabel")} ${formatTokens(usage.reasoningTokens)}）`}
              </div>
              <div>
                {t("usage.totalLabel")} {formatTokens(usage.totalTokens)}
              </div>
            </div>
          </TooltipContent>
        </Tooltip>
      )}

      <button
        type="button"
        onClick={() => handleFeedback("up")}
        disabled={busy}
        title={t("actions.like")}
        className={cn(BTN, current === "up" && "text-accent hover:text-accent")}
      >
        <ThumbsUp className="h-3 w-3" />
      </button>
      <button
        type="button"
        onClick={() => handleFeedback("down")}
        disabled={busy}
        title={t("actions.dislike")}
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
