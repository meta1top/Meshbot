"use client";

import { cn, Tooltip, TooltipContent, TooltipTrigger } from "@meshbot/design";
import { Paperclip, Send, Square } from "lucide-react";
import { useCallback, useRef, useState } from "react";

interface ChatInputProps {
  onSend?: (message: string) => void;
  onInterrupt?: () => void;
  isLoading?: boolean;
  placeholder?: string;
  modelName?: string;
  tokenUsage?: { current: number; max: number };
}

export function ChatInput({
  onSend,
  onInterrupt,
  isLoading = false,
  placeholder = "Describe a task or ask a question",
  modelName,
  tokenUsage,
}: ChatInputProps) {
  const [value, setValue] = useState("");
  const editorRef = useRef<HTMLDivElement>(null);

  const handleInput = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    const text = el.innerText;
    setValue(text);
  }, []);

  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || isLoading) return;
    onSend?.(trimmed);
    setValue("");
    const el = editorRef.current;
    if (el) {
      el.innerText = "";
    }
  }, [value, isLoading, onSend]);

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

        {isLoading ? (
          <button
            type="button"
            onClick={handleInterrupt}
            className="flex h-8 w-8 shrink-0 items-center justify-center text-destructive transition-colors hover:text-destructive/80"
            title="Stop generating"
          >
            <Square className="h-4 w-4 fill-current" />
          </button>
        ) : (
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
        )}
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
              <span className="text-xs text-muted-foreground">{modelName}</span>
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
                {tokenUsage.current.toLocaleString()} /{" "}
                {tokenUsage.max.toLocaleString()}
              </TooltipContent>
            </Tooltip>
          </div>
        )}
      </div>
    </div>
  );
}
