"use client";

import { cn } from "@meshbot/design";
import { Send, Square } from "lucide-react";
import type { ReactNode } from "react";
import { useRef } from "react";

export interface RemoteChatInputLabels {
  send: string;
  stop: string;
}

interface RemoteChatInputProps {
  /** 受控值，父组件维护 draft state（发送成功后由调用方清空）。 */
  value: string;
  onChange: (next: string) => void;
  onSend: (text: string) => void;
  onInterrupt?: () => void;
  /** 有 run 在跑：显示中断按钮而非发送按钮。 */
  isLoading?: boolean;
  /** 禁用整个输入（设备离线 / 会话创建中）。 */
  disabled?: boolean;
  placeholder?: string;
  /** 右下角附加控件（模型选择器）。 */
  trailingActions?: ReactNode;
  labels: RemoteChatInputLabels;
}

/**
 * 远程会话简版输入框（web-main）：纯 `<textarea>`（不引入 tiptap——web-main
 * 无该依赖，且远程会话不需要富文本/斜杠命令等本地语境功能），Enter 发送 /
 * Shift+Enter 换行，运行中显示中断按钮。
 *
 * 相比 web-agent `ChatInput` 的取舍（详见任务报告）：不做技能/连应用/权限
 * 下拉（`leadingActions`，web-main 无本地语境）、不做 token 用量环（web-main
 * 无 usage atoms 接线）、不做附件上传 mock；`trailingActions` 插槽保留给
 * 模型选择器（`RemoteModelSelect`）。
 */
export function RemoteChatInput({
  value,
  onChange,
  onSend,
  onInterrupt,
  isLoading = false,
  disabled = false,
  placeholder,
  trailingActions,
  labels,
}: RemoteChatInputProps) {
  const taRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = () => {
    if (isLoading || disabled) return;
    const text = value.trim();
    if (!text) return;
    onSend(text);
  };

  return (
    <div className="overflow-hidden rounded-[10px] border border-border bg-card">
      <div className="px-3 pt-2.5 pb-1">
        <textarea
          ref={taRef}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder={placeholder}
          rows={1}
          className="max-h-[200px] w-full resize-none overflow-y-auto bg-transparent py-1.5 text-sm text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-60"
        />
      </div>
      <div className="flex items-center gap-2 px-2.5 pb-2">
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {trailingActions}
          {isLoading ? (
            <button
              type="button"
              onClick={onInterrupt}
              title={labels.stop}
              className="flex h-8 w-8 shrink-0 items-center justify-center text-destructive transition-colors hover:text-destructive/80"
            >
              <Square className="h-4 w-4 fill-current" />
            </button>
          ) : (
            <button
              type="button"
              onClick={handleSend}
              disabled={disabled || !value.trim()}
              title={labels.send}
              className={cn(
                "flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors",
                !disabled && value.trim()
                  ? "bg-(--shell-accent) text-white"
                  : "text-muted-foreground",
              )}
            >
              <Send className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
