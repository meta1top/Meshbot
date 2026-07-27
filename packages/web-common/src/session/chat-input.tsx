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
 * `/` 命令（小而可扩展机制的首个消费者，`/compact` 见调用方接线）。
 * `name` 不带前导斜杠；`run()` 返回 string 时作为内联提示展示，返回
 * undefined 视为静默成功（如压缩卡片自己会经 WS 出现在消息流，无需额外提示）。
 */
export interface SlashCommand {
  name: string;
  description: string;
  run: () => Promise<string | undefined>;
}

/**
 * 发送拦截判定结果：
 * - "none"：未传 `commands`，或文本不构成命令——按现状原样发送（不改变行为）。
 * - "command"：首词精确匹配到已注册命令。
 * - "unknown"：文本以 `/` 开头但首词未匹配任何已注册命令。
 */
export type SlashCommandMatch =
  | { kind: "none" }
  | { kind: "command"; command: SlashCommand }
  | { kind: "unknown"; name: string };

/**
 * 判定发送文本是否命中 `/` 命令。纯函数，独立导出便于单测（tiptap 编辑器在
 * jsdom 下不便驱动，逻辑与渲染分离）。
 *
 * 匹配规则：trim 后以 "/" 开头，取首词（按空白切分取第一段）去掉前导 "/"
 * 作为命令名，在 `commands` 里精确匹配 `name`。当前唯一命令 `/compact` 无
 * 参数，首词精确匹配即可；未来若命令带参数，参数解析下沉到各命令的
 * `run()` 自己处理（此处只切首词，不假设参数形态）。
 */
export function matchSlashCommand(
  text: string,
  commands?: SlashCommand[],
): SlashCommandMatch {
  if (!commands || commands.length === 0) return { kind: "none" };
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return { kind: "none" };
  const firstWord = trimmed.split(/\s+/)[0] ?? "";
  const name = firstWord.slice(1);
  const command = commands.find((c) => c.name === name);
  return command ? { kind: "command", command } : { kind: "unknown", name };
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
  /**
   * 观察态下停止按钮被禁用时的 title（Bug 1 修复）：`canInterrupt=false`
   * 时用它替代 `interrupt`，向用户解释「这个按钮点了没用」，而不是让它看起来
   * 像个失灵的按钮。可选：本地分支的停止按钮恒可用，永远用不上这个兜底，
   * 缺省回退到 `interrupt`。
   */
  interruptUnavailable?: string;
  /** 发送按钮 title。 */
  send?: string;
  /**
   * `/xxx` 未匹配到任何已注册命令时的内联提示文案（仅传入 `commands` 时可能
   * 用到）。入参 `name` 含前导斜杠（如 `"/foo"`）。未传时静默不提示——与其余
   * 可选 label 缺省即降级展示的约定一致，不在组件内硬编码兜底文案。
   */
  commandUnknown?: (name: string) => string;
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
  /**
   * 运行中时停止按钮是否可用（默认 `true`）。观察态下（remote 且当前没有
   * 可路由的 streamId——见 `useSessionStream().canInterrupt` 文档）调用方
   * 应传 `false`：按钮改渲染为禁用态而非可点击，防止用户以为点了就能停、
   * 实际这个 run 还在继续跑（Bug 1）。
   */
  canInterrupt?: boolean;
  placeholder?: string;
  /**
   * `/` 命令注册表（小而可扩展机制，首个消费者 `/compact`）。未传（默认）时
   * 行为与现状完全一致——`/` 开头的文本照常当普通消息发送，不做任何拦截。
   * 传入后：发送文本首词精确匹配到某条命令 → 调用其 `run()`（不触发
   * `onSend`、清空输入、执行期禁止重复触发）；未匹配任何命令 → 内联提示
   * （见 `labels.commandUnknown`），同样不发送。
   */
  commands?: SlashCommand[];
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
      canInterrupt = true,
      placeholder,
      commands,
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

    // `/` 命令内联提示（未知命令 / run() 返回的文案）；输入框上方展示。
    const [commandHint, setCommandHint] = useState<string | null>(null);
    // 命令 run() 执行期：禁止重复触发（Enter 与按钮共用同一守卫）。
    const [commandRunning, setCommandRunning] = useState(false);

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
        // 用户继续编辑即视为已看到/在处理提示，清掉旧的内联命令提示。
        setCommandHint(null);
      },
    });

    const handleSend = useCallback(() => {
      // 运行中禁止发送（与发送按钮隐藏一致）：Enter 快捷键与按钮同一守卫，
      // 避免「按钮没了但快捷键还能发」的不一致。
      if (isLoading) return;
      // 命令执行期禁止重复触发（Enter 与按钮共用同一守卫）。
      if (commandRunning) return;
      if (!editor) return;
      const md = getMarkdown(editor.storage).trim();
      if (!md) return;

      const match = matchSlashCommand(md, commands);
      if (match.kind === "command") {
        // 命中命令：不触发 onSend，立即清空输入（与普通发送一致的即时反馈），
        // run() 异步执行期间禁止重复触发。
        editor.commands.clearContent();
        onChange("");
        setCommandHint(null);
        setCommandRunning(true);
        match.command
          .run()
          .then((result) => {
            if (result) setCommandHint(result);
          })
          .catch((err: unknown) => {
            setCommandHint(err instanceof Error ? err.message : String(err));
          })
          .finally(() => setCommandRunning(false));
        return;
      }
      if (match.kind === "unknown") {
        // 未匹配到任何已注册命令：不发送，仅内联提示（未提供 commandUnknown
        // label 时静默——不在组件内硬编码兜底文案，见该字段的文档）。
        if (labels.commandUnknown) {
          setCommandHint(labels.commandUnknown(`/${match.name}`));
        }
        return;
      }

      onSend?.(md);
      editor.commands.clearContent();
      onChange("");
      setCommandHint(null);
    }, [editor, onSend, onChange, isLoading, commands, commandRunning, labels]);

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
      <div className="overflow-hidden rounded-md border border-border bg-card">
        {/* `/` 命令内联提示（未知命令 / run() 返回的文案）；未命中过任何命令时不渲染。 */}
        {commandHint && (
          <div className="border-b border-border px-3 py-1.5 text-muted-foreground text-xs">
            {commandHint}
          </div>
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
                仅不再从此入口暴露。
                观察态（`canInterrupt=false`，Bug 1 修复）：按钮仍然占位
                （保持底部动作栏布局不跳动），但改为禁用态——不接 onClick、
                变灰、title 换成解释文案，不能让用户点了以为真的停了但设备上
                那个 run 其实还在继续跑。 */}
            {isLoading ? (
              canInterrupt ? (
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
                  disabled
                  aria-disabled="true"
                  className="flex h-8 w-8 shrink-0 cursor-not-allowed items-center justify-center text-muted-foreground/40"
                  title={labels.interruptUnavailable ?? labels.interrupt}
                >
                  <Square className="h-4 w-4 fill-current" />
                </button>
              )
            ) : (
              <button
                type="button"
                onClick={handleSend}
                disabled={!hasContent || commandRunning}
                className={cn(
                  "flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors",
                  hasContent && !commandRunning
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
