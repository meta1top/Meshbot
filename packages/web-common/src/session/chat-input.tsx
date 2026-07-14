"use client";

import { cn, Tooltip, TooltipContent, TooltipTrigger } from "@meshbot/design";
import Placeholder from "@tiptap/extension-placeholder";
import { EditorContent, useEditor } from "@tiptap/react";
import { StarterKit } from "@tiptap/starter-kit";
import { Paperclip, Send, Square } from "lucide-react";
import {
  forwardRef,
  type ReactNode,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { Markdown } from "tiptap-markdown";
import { formatTokens } from "./format-tokens";

/** editor.storage 在挂载 tiptap-markdown 后的实际形态（类型断言辅助） */
interface MarkdownEditorStorage {
  markdown: { getMarkdown(): string };
}

/** 从 editor.storage 中安全取出 markdown 字符串 */
function getMarkdown(storage: unknown): string {
  return (storage as MarkdownEditorStorage).markdown.getMarkdown();
}

/**
 * 文案注入（原 `useTranslations("chatInput")` / `useTranslations("session")`
 * 内部调用，Task 1 迁入 web-common 后改调用方传入）。`attachment`/`interrupt`
 * 始终渲染（底部动作栏固定按钮）；`placeholder`/`send`/`usage` 均可选——
 * `placeholder` 仅在未传 `placeholder` prop 时兜底；`send` 缺省时发送按钮
 * 无 title；`usage` 仅在 `tokenUsage.breakdown` 存在时用于渲染明细 tooltip，
 * 缺省时该场景退化为简单的「当前/上限」展示。
 */
export interface ChatInputLabels {
  /** tiptap 空态占位符兜底文案（未传 `placeholder` prop 时使用）。 */
  placeholder?: string;
  /** 上传按钮 title。 */
  attachment: string;
  /** 中断按钮 title。 */
  interrupt: string;
  /** 发送按钮 title。 */
  send?: string;
  /** token 用量 tooltip 明细文案（仅 `tokenUsage.breakdown` 存在时用到）。 */
  usage?: {
    nextRequestLabel: string;
    inputLabel: string;
    cacheLabel: string;
    outputLabel: string;
    reasoningLabel: string;
    cumulativeLabel: string;
    callCount: (count: number) => string;
  };
}

export interface ChatInputProps {
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
  /** 右下动作区（token 环左侧）的选择器（如模型选择）；不传不渲染。 */
  trailingActions?: ReactNode;
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
  labels: ChatInputLabels;
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

/**
 * 会话输入框：tiptap markdown 编辑器 + 底部动作栏（前导动作 / 模型选择 /
 * token 用量环 / 上传 / 发送-中断）。
 *
 * 从 `apps/web-agent/src/components/common/chat-input.tsx` 迁入（Task 1）——
 * `useTranslations` 改 `labels` props；其余 props 逐字不变。
 */
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
      trailingActions,
      modelName,
      tokenUsage,
      labels,
    },
    ref,
  ) {
    // sendFnRef 让 handleKeyDown（在 useEditor 配置对象中捕获）
    // 始终能调用到最新的 handleSend，绕开闭包陈旧问题。
    const sendFnRef = useRef<() => void>(() => {});

    // 编辑器空态镜像：驱动发送按钮 disabled。不能直接读 editor.isEmpty——
    // 受控同步走 emitUpdate:false 不触发重渲，直读会拿到陈旧渲染帧的值。
    const [isEmpty, setIsEmpty] = useState(true);

    const editor = useEditor({
      immediatelyRender: false,
      extensions: [
        StarterKit,
        Placeholder.configure({
          placeholder: placeholder ?? labels.placeholder ?? "",
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
        setIsEmpty(e.isEmpty);
      },
    });

    const handleSend = useCallback(() => {
      // 运行中禁止发送（与发送按钮隐藏一致）：Enter 快捷键与按钮同一守卫，
      // 避免「按钮没了但快捷键还能发」的不一致。
      if (isLoading) return;
      if (!editor) return;
      const md = getMarkdown(editor.storage).trim();
      if (!md) return;
      onSend?.(md);
      editor.commands.clearContent();
      onChange("");
    }, [editor, onSend, onChange, isLoading]);

    // 每次 handleSend 更新时同步到 ref，让 handleKeyDown 读到最新版本
    useEffect(() => {
      sendFnRef.current = handleSend;
    }, [handleSend]);

    // 编辑器就绪时校准一次空态（初始 content 与 value 一致时下方同步不会跑）
    useEffect(() => {
      if (editor) setIsEmpty(editor.isEmpty);
    }, [editor]);

    // 受控 value 同步守卫：防自身 onChange 回环 + 光标跳。
    // emitUpdate:false 不触发 onUpdate → React 不重渲，isEmpty 必须手动刷新，
    // 否则外部填入草稿（建议 chips）后发送按钮仍按旧空态禁用（快捷键路径
    // 直读编辑器所以能发，恰好掩盖此 bug）。
    useEffect(() => {
      if (!editor) return;
      const current = getMarkdown(editor.storage);
      if (value !== current) {
        editor.commands.setContent(value, { emitUpdate: false });
        setIsEmpty(editor.isEmpty);
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

    const hasContent = !!editor && !isEmpty;

    const tokenPercent = tokenUsage
      ? Math.min((tokenUsage.current / tokenUsage.max) * 100, 100)
      : 0;

    return (
      <div className="overflow-hidden rounded-[10px] border border-border bg-card">
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
            {trailingActions}
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
                    {tokenUsage.breakdown && labels.usage ? (
                      <div className="space-y-0.5 text-xs">
                        <div>
                          {labels.usage.nextRequestLabel}{" "}
                          {formatTokens(tokenUsage.current)} /{" "}
                          {formatTokens(tokenUsage.max)}
                        </div>
                        <div>
                          {labels.usage.inputLabel}{" "}
                          {formatTokens(tokenUsage.breakdown.inputTokens)}
                          {tokenUsage.breakdown.cacheReadTokens > 0 &&
                            `（${labels.usage.cacheLabel} ${formatTokens(tokenUsage.breakdown.cacheReadTokens)}）`}
                        </div>
                        <div>
                          {labels.usage.outputLabel}{" "}
                          {formatTokens(tokenUsage.breakdown.outputTokens)}
                          {tokenUsage.breakdown.reasoningTokens > 0 &&
                            `（${labels.usage.reasoningLabel} ${formatTokens(tokenUsage.breakdown.reasoningTokens)}）`}
                        </div>
                        {tokenUsage.breakdown.cumulativeTokens !==
                          undefined && (
                          <div>
                            {labels.usage.cumulativeLabel}{" "}
                            {formatTokens(
                              tokenUsage.breakdown.cumulativeTokens,
                            )}
                          </div>
                        )}
                        <div>
                          {labels.usage.callCount(
                            tokenUsage.breakdown.callCount,
                          )}
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
              title={labels.attachment}
            >
              <Paperclip className="h-4 w-4" />
            </button>

            {/* 运行中只显示中断（发送隐藏，Enter 同步禁用——见 handleSend
                守卫）；想发新消息先停止当前 run。排队追加的后端能力保留，
                仅不再从此入口暴露。 */}
            {isLoading ? (
              <button
                type="button"
                onClick={handleInterrupt}
                className="flex h-8 w-8 shrink-0 items-center justify-center text-destructive transition-colors hover:text-destructive/80"
                title={labels.interrupt}
              >
                <Square className="h-4 w-4 fill-current" />
              </button>
            ) : (
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
                title={labels.send}
              >
                <Send className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
      </div>
    );
  },
);
