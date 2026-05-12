"use client";

import { cn } from "@meshbot/design";
import { Paperclip, Send, Square } from "lucide-react";
import { useCallback, useRef, useState } from "react";

interface ChatInputProps {
  onSend?: (message: string) => void;
  onInterrupt?: () => void;
  isLoading?: boolean;
  placeholder?: string;
  tokenUsage?: { current: number; max: number };
}

export function ChatInput({
  onSend,
  onInterrupt,
  isLoading = false,
  placeholder = "Describe a task or ask a question",
  tokenUsage,
}: ChatInputProps) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const adjustHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    const newHeight = Math.min(Math.max(textarea.scrollHeight, 24), 200);
    textarea.style.height = `${newHeight}px`;
  }, []);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setValue(e.target.value);
      adjustHeight();
    },
    [adjustHeight],
  );

  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || isLoading) return;
    onSend?.(trimmed);
    setValue("");
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = "auto";
    }
  }, [value, isLoading, onSend]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
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
      <div className="flex items-end gap-2 px-3 py-2">
        <button
          type="button"
          className="flex h-8 w-8 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
          title="Attach file"
        >
          <Paperclip className="h-4 w-4" />
        </button>

        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          rows={1}
          className={cn(
            "min-h-[24px] max-h-[200px] w-full resize-none bg-transparent py-1 text-sm text-foreground outline-none placeholder:text-muted-foreground",
          )}
          style={{ height: "auto" }}
        />

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
          title="Attach file"
        >
          <Paperclip className="h-3.5 w-3.5" />
        </button>

        {tokenUsage && (
          <div className="flex items-center gap-2">
            <div className="h-1.5 w-16 overflow-hidden bg-border">
              <div
                className="h-full bg-accent transition-all"
                style={{ width: `${tokenPercent}%` }}
              />
            </div>
            <span className="text-xs text-muted-foreground">
              {tokenUsage.current.toLocaleString()} /{" "}
              {tokenUsage.max.toLocaleString()}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
