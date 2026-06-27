"use client";

import { cn } from "@meshbot/design";
import { stripLlmuse } from "@meshbot/types-agent";
import { Check, Copy, Loader2, RotateCcw } from "lucide-react";
import { useCallback, useState } from "react";
import { regenerateMessage } from "@/rest/session";

interface Props {
  sessionId: string;
  messageId: string;
  content: string;
  /** 失败状态：按钮默认可见（不需要 hover），label 「重试」。 */
  failed?: boolean;
  /** 会话有 inflight run：重试按钮 disabled，避免触发双 run。 */
  running?: boolean;
  /**
   * 触发重生成前的乐观截断：父组件从 timeline 移除该消息之后的所有 message。
   * 提供即时反馈，让用户不必等服务端响应才看到「之前的回复消失」。
   */
  onOptimisticCut: () => void;
  /** 失败时父组件可弹 toast / log。 */
  onError?: (err: unknown) => void;
}

/**
 * user 气泡下方的操作按钮组：复制 + 重生成。
 *
 * - hover 气泡才显（failed 状态默认显，引导用户重试）
 * - 重试请求飞行期间 spinner + disabled，避免双击
 * - copy 总是可点（无网络）
 */
export function UserMessageActions({
  sessionId,
  messageId,
  content,
  failed,
  running,
  onOptimisticCut,
  onError,
}: Props) {
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(stripLlmuse(content));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      onError?.(err);
    }
  }, [content, onError]);

  const handleRegenerate = useCallback(async () => {
    if (busy || running) return;
    setBusy(true);
    onOptimisticCut();
    try {
      await regenerateMessage(sessionId, messageId);
    } catch (err) {
      onError?.(err);
    } finally {
      setBusy(false);
    }
  }, [busy, running, sessionId, messageId, onOptimisticCut, onError]);

  return (
    <div
      className={cn(
        "absolute top-1 right-2 z-10 items-center gap-0.5 rounded-md border border-border bg-background p-0.5 shadow-xs",
        failed ? "flex" : "hidden group-hover:flex",
      )}
    >
      <button
        type="button"
        onClick={handleCopy}
        title="复制"
        className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      </button>
      <button
        type="button"
        onClick={handleRegenerate}
        disabled={busy || running}
        title={failed ? "重试" : "重新生成"}
        className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
      >
        {busy ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <RotateCcw className="h-3 w-3" />
        )}
      </button>
    </div>
  );
}
