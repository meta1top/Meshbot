"use client";

import { cn, Tooltip, TooltipContent, TooltipTrigger } from "@meshbot/design";
import { Paperclip, Send, Square } from "lucide-react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";

interface ChatInputProps {
  /** 受控值。父组件维护 draft state。 */
  value: string;
  /** 受控 change。 */
  onChange: (next: string) => void;
  onSend?: (message: string) => void;
  onInterrupt?: () => void;
  isLoading?: boolean;
  placeholder?: string;
  modelName?: string;
  tokenUsage?: {
    current: number;
    max: number;
    /** 分项明细（可选）—— 提供时 Tooltip 展示详细分解。 */
    breakdown?: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      reasoningTokens: number;
      callCount: number;
    };
  };
}

/** 父组件通过 ref 调用的方法。 */
export interface ChatInputHandle {
  focus: () => void;
}

export const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(
  function ChatInput(
    {
      value,
      onChange,
      onSend,
      onInterrupt,
      isLoading = false,
      placeholder = "Describe a task or ask a question",
      modelName,
      tokenUsage,
    },
    ref,
  ) {
    const editorRef = useRef<HTMLDivElement>(null);

    // 当外部 value 与 DOM innerText 不一致时同步（外部灌 draft 时触发）
    useEffect(() => {
      const el = editorRef.current;
      if (!el) return;
      if (el.innerText !== value) {
        el.innerText = value;
      }
    }, [value]);

    useImperativeHandle(ref, () => ({
      focus: () => {
        editorRef.current?.focus();
      },
    }));

    const handleInput = useCallback(() => {
      const el = editorRef.current;
      if (!el) return;
      onChange(el.innerText);
    }, [onChange]);

    const handleSend = useCallback(() => {
      const trimmed = value.trim();
      if (!trimmed) return;
      onSend?.(trimmed);
      onChange("");
      const el = editorRef.current;
      if (el) {
        el.innerText = "";
      }
    }, [value, onSend, onChange]);

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          handleSend();
        }
      },
      [handleSend],
    );

    const handleInterrupt = useCallback(() => {
      onInterrupt?.();
    }, [onInterrupt]);

    const hasContent = value.trim().length > 0;

    const tokenPercent = tokenUsage
      ? Math.min((tokenUsage.current / tokenUsage.max) * 100, 100)
      : 0;

    return (
      <div className="rounded-none border border-border bg-card">
        <div className="flex items-center gap-2 px-3 py-2">
          <div className="relative w-full">
            {!hasContent && (
              <div className="pointer-events-none absolute left-0 top-0 py-1.5 text-sm text-muted-foreground">
                {placeholder}
              </div>
            )}
            <div
              ref={editorRef}
              role="textbox"
              aria-multiline="true"
              tabIndex={0}
              contentEditable
              onInput={handleInput}
              onKeyDown={handleKeyDown}
              className={cn(
                "min-h-[24px] max-h-[200px] w-full overflow-y-auto bg-transparent py-1.5 text-sm text-foreground outline-none empty:before:text-muted-foreground",
              )}
              style={{ wordBreak: "break-word" }}
            />
          </div>

          {isLoading && (
            <button
              type="button"
              onClick={handleInterrupt}
              className="flex h-8 w-8 shrink-0 items-center justify-center text-destructive transition-colors hover:text-destructive/80"
              title="Stop generating"
            >
              <Square className="h-4 w-4 fill-current" />
            </button>
          )}
          <button
            type="button"
            onClick={handleSend}
            disabled={!hasContent}
            className={cn(
              "flex h-8 w-8 shrink-0 items-center justify-center transition-colors",
              hasContent
                ? "text-foreground hover:text-foreground/80"
                : "text-muted-foreground",
            )}
            title="Send message"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>

        <div className="flex items-center justify-between border-t border-border px-3 py-1.5">
          <button
            type="button"
            className="flex h-5 w-5 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
            title="添加附件"
          >
            <Paperclip className="h-3.5 w-3.5" />
          </button>

          {tokenUsage && (
            <div className="flex items-center gap-2">
              {modelName && (
                <span className="text-xs text-muted-foreground">
                  {modelName}
                </span>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="h-4 w-4 cursor-pointer">
                    <svg
                      className="h-full w-full -rotate-90"
                      viewBox="0 0 36 36"
                      role="img"
                      aria-label="Token usage"
                    >
                      <path
                        className="text-border"
                        d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="4"
                      />
                      <path
                        className="text-accent transition-all"
                        d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                        fill="none"
                        stroke="currentColor"
                        strokeDasharray={`${tokenPercent}, 100`}
                        strokeWidth="4"
                      />
                    </svg>
                  </div>
                </TooltipTrigger>
                <TooltipContent>
                  {tokenUsage.breakdown ? (
                    <div className="space-y-0.5 text-xs">
                      <div>
                        总计 {tokenUsage.current.toLocaleString()} /{" "}
                        {tokenUsage.max.toLocaleString()}
                      </div>
                      <div>
                        输入 {tokenUsage.breakdown.inputTokens.toLocaleString()}
                        {tokenUsage.breakdown.cacheReadTokens > 0 &&
                          `（缓存 ${tokenUsage.breakdown.cacheReadTokens.toLocaleString()}）`}
                      </div>
                      <div>
                        输出{" "}
                        {tokenUsage.breakdown.outputTokens.toLocaleString()}
                        {tokenUsage.breakdown.reasoningTokens > 0 &&
                          `（推理 ${tokenUsage.breakdown.reasoningTokens.toLocaleString()}）`}
                      </div>
                      <div>{tokenUsage.breakdown.callCount} 次调用</div>
                    </div>
                  ) : (
                    <>
                      {tokenUsage.current.toLocaleString()} /{" "}
                      {tokenUsage.max.toLocaleString()}
                    </>
                  )}
                </TooltipContent>
              </Tooltip>
            </div>
          )}
        </div>
      </div>
    );
  },
);
