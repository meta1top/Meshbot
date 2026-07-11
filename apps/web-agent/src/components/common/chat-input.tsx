"use client";

import { cn, Tooltip, TooltipContent, TooltipTrigger } from "@meshbot/design";
import Placeholder from "@tiptap/extension-placeholder";
import { EditorContent, useEditor } from "@tiptap/react";
import { StarterKit } from "@tiptap/starter-kit";
import { Paperclip, Send, Square } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  forwardRef,
  type ReactNode,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import { Markdown } from "tiptap-markdown";
import { formatTokens } from "@/lib/format-tokens";

/** editor.storage 在挂载 tiptap-markdown 后的实际形态（类型断言辅助） */
interface MarkdownEditorStorage {
  markdown: { getMarkdown(): string };
}

/** 从 editor.storage 中安全取出 markdown 字符串 */
function getMarkdown(storage: unknown): string {
  return (storage as MarkdownEditorStorage).markdown.getMarkdown();
}

interface ChatInputProps {
  /** 受控值。父组件维护 draft state。 */
  value: string;
  /** 受控 change。 */
  onChange: (next: string) => void;
  onSend?: (message: string) => void;
  onInterrupt?: () => void;
  isLoading?: boolean;
  placeholder?: string;
  /** 底部动作栏左侧的前导动作（如 ComposerActions 的 技能/连应用/权限 mock 链）。 */
  leadingActions?: ReactNode;
  /** 输入区上方左侧的选择器行（如模型选择）；不传不渲染。 */
  topLeading?: ReactNode;
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
      leadingActions,
      topLeading,
      modelName,
      tokenUsage,
    },
    ref,
  ) {
    const tChat = useTranslations("chatInput");
    const tSession = useTranslations("session");

    // sendFnRef 让 handleKeyDown（在 useEditor 配置对象中捕获）
    // 始终能调用到最新的 handleSend，绕开闭包陈旧问题。
    const sendFnRef = useRef<() => void>(() => {});

    const editor = useEditor({
      immediatelyRender: false,
      extensions: [
        StarterKit,
        Placeholder.configure({
          placeholder: placeholder ?? tChat("placeholder"),
        }),
        Markdown.configure({
          transformPastedText: true,
          transformCopiedText: true,
        }),
      ],
      content: value,
      editorProps: {
        attributes: {
          class:
            "prose-none w-full text-sm text-foreground outline-none [&_p]:my-0 [&_ul]:my-1 [&_ul]:ml-4 [&_ul]:list-disc [&_ol]:my-1 [&_ol]:ml-4 [&_ol]:list-decimal [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_pre]:rounded [&_pre]:bg-muted [&_pre]:p-2 [&_a]:text-accent [&_a]:underline",
        },
        // 粘贴富文本时剥掉源站内联样式（style/class/color/bgcolor/align），
        // 避免「白字 + 背景」等样式感染；标签结构保留给 Markdown 提取语义。
        transformPastedHTML: (html) =>
          html.replace(/\s(?:style|class|bgcolor|color|align)="[^"]*"/gi, ""),
        handleKeyDown: (_view, event) => {
          // IME 组合期间不拦截 Enter
          if (event.isComposing || event.keyCode === 229) return false;
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            sendFnRef.current();
            return true;
          }
          return false;
        },
      },
      onUpdate: ({ editor: e }) => {
        onChange(getMarkdown(e.storage));
      },
    });

    const handleSend = useCallback(() => {
      if (!editor) return;
      const md = getMarkdown(editor.storage).trim();
      if (!md) return;
      onSend?.(md);
      editor.commands.clearContent();
      onChange("");
    }, [editor, onSend, onChange]);

    // 每次 handleSend 更新时同步到 ref，让 handleKeyDown 读到最新版本
    useEffect(() => {
      sendFnRef.current = handleSend;
    }, [handleSend]);

    // 受控 value 同步守卫：防自身 onChange 回环 + 光标跳
    useEffect(() => {
      if (!editor) return;
      const current = getMarkdown(editor.storage);
      if (value !== current) {
        editor.commands.setContent(value, { emitUpdate: false });
      }
    }, [value, editor]);

    useImperativeHandle(
      ref,
      () => ({
        focus: (_withText?: string) => {
          requestAnimationFrame(() => {
            editor?.commands.focus("end");
          });
        },
      }),
      [editor],
    );

    const handleInterrupt = useCallback(() => {
      onInterrupt?.();
    }, [onInterrupt]);

    const hasContent = !!editor && !editor.isEmpty;

    const tokenPercent = tokenUsage
      ? Math.min((tokenUsage.current / tokenUsage.max) * 100, 100)
      : 0;

    return (
      <div className="overflow-hidden rounded-[10px] border border-border bg-card">
        {/* 顶部左侧选择器行（如模型选择）：输入区上方，左对齐 */}
        {topLeading && (
          <div className="flex items-center gap-2 px-3 pt-2">{topLeading}</div>
        )}
        {/* 编辑区（tiptap；StarterKit 输入规则让 markdown 边打边可视化） */}
        <div className="px-3 pt-2.5 pb-1">
          <div className="max-h-[200px] w-full overflow-y-auto py-1.5">
            <EditorContent editor={editor} />
          </div>
        </div>

        {/* 底部动作栏：左=前导动作（父传 mock 链）；右=token 环 + 上传 + 发送/中断 */}
        <div className="flex items-center gap-2 px-2.5 pb-2">
          {leadingActions && (
            <div className="flex min-w-0 items-center gap-1">
              {leadingActions}
            </div>
          )}

          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {tokenUsage && (
              <>
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
                        {tokenUsage.breakdown.cumulativeTokens !==
                          undefined && (
                          <div>
                            {tSession("usage.cumulativeLabel")}{" "}
                            {formatTokens(
                              tokenUsage.breakdown.cumulativeTokens,
                            )}
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
              </>
            )}

            {/* 上传（mock 占位，点击无副作用；真实上传 L1 不做） */}
            <button
              type="button"
              className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              title={tChat("attachment")}
            >
              <Paperclip className="h-4 w-4" />
            </button>

            {/* 运行中显示中断；再显示发送键 */}
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
        </div>
      </div>
    );
  },
);
