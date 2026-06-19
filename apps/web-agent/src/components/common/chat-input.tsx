"use client";

import { cn, Tooltip, TooltipContent, TooltipTrigger } from "@meshbot/design";
import { Paperclip, Send, Square } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import { formatTokens } from "@/lib/format-tokens";

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
    /**
     * 进度环主显示分子。语义：「下次 LLM 请求预估 input token」
     * （= 最近一次 LlmCall.input_tokens，作为下次请求的代理）。
     */
    current: number;
    max: number;
    /** 分项明细（可选）—— 提供时 Tooltip 展示详细分解。 */
    breakdown?: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      reasoningTokens: number;
      callCount: number;
      /** 会话累计 token（所有调用 input+output 之和）；只在 tooltip 辅助行显示。 */
      cumulativeTokens?: number;
    };
  };
}

/** 父组件通过 ref 调用的方法。 */
export interface ChatInputHandle {
  /**
   * 聚焦输入框，光标置于内容末尾。
   *
   * 可选传入 `withText`：调用方刚 setDraft(text) 时，React state 提交是异步的，
   * 若不传值则 focus 时光标会停在旧内容末尾。
   * 传入 withText 让组件用该值计算末尾位置，再 focus 并将光标移到末尾。
   */
  focus: (withText?: string) => void;
}

export const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(
  function ChatInput(
    {
      value,
      onChange,
      onSend,
      onInterrupt,
      isLoading = false,
      placeholder,
      modelName,
      tokenUsage,
    },
    ref,
  ) {
    const tChat = useTranslations("chatInput");
    const tSession = useTranslations("session");
    const editorRef = useRef<HTMLTextAreaElement>(null);

    // 自适应高度：每次 value 变化，先复位再撑到 scrollHeight（CSS max-h 封顶后内部滚动）
    // biome-ignore lint/correctness/useExhaustiveDependencies: value 是触发条件，effect 读 DOM scrollHeight（而非 value 本身）
    useEffect(() => {
      const el = editorRef.current;
      if (!el) return;
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    }, [value]);

    useImperativeHandle(
      ref,
      () => ({
        focus: (withText?: string) => {
          const el = editorRef.current;
          if (!el) return;
          el.focus();
          const pos = (withText ?? value).length;
          el.setSelectionRange(pos, pos);
        },
      }),
      [value],
    );

    const handleSend = useCallback(() => {
      const trimmed = value.trim();
      if (!trimmed) return;
      onSend?.(trimmed);
      onChange("");
    }, [value, onSend, onChange]);

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        // IME 组合期间（中文/日文/韩文输入法未确认）不拦截 Enter——让 IME
        // 自己用回车 confirm 候选词。nativeEvent.isComposing / keyCode===229
        // 任一为 true 都视为组合中。
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
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
      <div className="overflow-hidden rounded-[10px] border border-border bg-card">
        {/* Decorative formatting toolbar — visual only, no editing logic */}
        <div className="flex items-center gap-3 border-b border-border px-3 py-1.5 text-muted-foreground">
          <span className="text-[13px] font-bold">B</span>
          <span className="text-[13px] italic">I</span>
          <span className="text-[13px] underline">U</span>
          <span className="text-[13px]">≡</span>
          <span className="font-mono text-[12px]">{"</>"}</span>
        </div>

        <div className="flex items-center gap-2 px-3 py-2">
          <textarea
            ref={editorRef}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
            placeholder={placeholder ?? tChat("placeholder")}
            className="max-h-[200px] min-h-[24px] w-full resize-none overflow-y-auto bg-transparent py-1.5 text-sm text-foreground outline-none placeholder:text-muted-foreground"
            style={{ wordBreak: "break-word" }}
          />

          {isLoading && (
            <button
              type="button"
              onClick={handleInterrupt}
              className="flex h-8 w-8 shrink-0 items-center justify-center text-destructive transition-colors hover:text-destructive/80"
              title={tChat("interrupt")}
            >
              <Square className="h-4 w-4 fill-current" />
            </button>
          )}
          <button
            type="button"
            onClick={handleSend}
            disabled={!hasContent}
            className={cn(
              "flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors",
              hasContent
                ? "bg-(--shell-accent) text-white"
                : "text-muted-foreground",
            )}
            title={tChat("send")}
          >
            <Send className="h-4 w-4" />
          </button>
        </div>

        <div className="flex items-center justify-between border-t border-border px-3 py-1.5">
          <button
            type="button"
            className="flex h-5 w-5 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
            title={tChat("attachment")}
          >
            <Paperclip className="h-3.5 w-3.5" />
          </button>

          {tokenUsage && (
            <div className="flex items-center gap-2">
              {modelName && (
                <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
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
                        {tSession("usage.nextRequestLabel")}{" "}
                        {formatTokens(tokenUsage.current)} /{" "}
                        {formatTokens(tokenUsage.max)}
                      </div>
                      <div>
                        {tSession("usage.inputLabel")}{" "}
                        {formatTokens(tokenUsage.breakdown.inputTokens)}
                        {tokenUsage.breakdown.cacheReadTokens > 0 &&
                          `（${tSession("usage.cacheLabel")} ${formatTokens(tokenUsage.breakdown.cacheReadTokens)}）`}
                      </div>
                      <div>
                        {tSession("usage.outputLabel")}{" "}
                        {formatTokens(tokenUsage.breakdown.outputTokens)}
                        {tokenUsage.breakdown.reasoningTokens > 0 &&
                          `（${tSession("usage.reasoningLabel")} ${formatTokens(tokenUsage.breakdown.reasoningTokens)}）`}
                      </div>
                      {tokenUsage.breakdown.cumulativeTokens !== undefined && (
                        <div>
                          {tSession("usage.cumulativeLabel")}{" "}
                          {formatTokens(tokenUsage.breakdown.cumulativeTokens)}
                        </div>
                      )}
                      <div>
                        {tSession("usage.callCount", {
                          count: tokenUsage.breakdown.callCount,
                        })}
                      </div>
                    </div>
                  ) : (
                    <>
                      {formatTokens(tokenUsage.current)} /{" "}
                      {formatTokens(tokenUsage.max)}
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
