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

/** `/` 命令下拉菜单的当前状态（见 `computeSlashMenu`）。 */
export interface SlashMenuState {
  open: boolean;
  /** 去掉前导 "/" 的过滤前缀（如输入 "/co" 时为 "co"）。 */
  query: string;
  /** 按 `query` 前缀过滤后的候选命令，保持 `commands` 原有顺序。 */
  filtered: SlashCommand[];
}

const CLOSED_SLASH_MENU: SlashMenuState = {
  open: false,
  query: "",
  filtered: [],
};

/**
 * 判定是否该浮出 `/` 命令下拉菜单，并按前缀过滤候选项。纯函数，独立导出
 * 便于单测（同 `matchSlashCommand` 的理由：tiptap 编辑器在 jsdom 下不便驱动）。
 *
 * 触发条件（比 `matchSlashCommand` 更严格，用于「输入中」而非「发送时」）：
 * 整个文本恰好是 "/" + 连续非空白字符，即光标仍在首词内、尚未出现空格后的
 * 正文——一旦打出空格，菜单就该收起（用户已经在打参数/正文，不再是选命令）。
 * 未传 `commands` 时恒返回关闭态，调用方在这类输入框上完全不会触发本行为。
 */
export function computeSlashMenu(
  text: string,
  commands?: SlashCommand[],
): SlashMenuState {
  if (!commands || commands.length === 0) return CLOSED_SLASH_MENU;
  if (!/^\/\S*$/.test(text)) return CLOSED_SLASH_MENU;
  const query = text.slice(1);
  const filtered = commands.filter((c) => c.name.startsWith(query));
  return { open: true, query, filtered };
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
  /**
   * `/` 命令下拉菜单在当前前缀无任何匹配项时的空态行文案（仅传入 `commands`
   * 时可能用到）。未传时不渲染空态行（菜单仍会打开，只是没有任何一行）——
   * 同 `commandUnknown` 的缺省降级约定。
   */
  commandMenuEmpty?: string;
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
    // menuKeyDownRef 同理：让同一个 handleKeyDown 始终能调用到最新的
    // handleMenuKeyDown（定义见下方，effect 里同步）。与 sendFnRef 一起在
    // useEditor 之前声明，避免 editorProps.handleKeyDown 里的闭包引用到
    // 声明顺序在它之后的变量（虽然实际调用发生在渲染完成之后，行为上没有
    // 问题，但放一起更符合本文件既有的书写习惯，读起来更直白）。
    const menuKeyDownRef = useRef<(key: string) => boolean>(() => false);

    // 编辑器空态镜像：驱动发送按钮 disabled。不能直接读 editor.isEmpty——
    // 受控同步走 emitUpdate:false 不触发重渲，直读会拿到陈旧渲染帧的值。
    const [isEmpty, setIsEmpty] = useState(true);

    // `/` 命令内联提示（未知命令 / run() 返回的文案）；输入框上方展示。
    const [commandHint, setCommandHint] = useState<string | null>(null);
    // 命令 run() 执行期：禁止重复触发（Enter 与按钮共用同一守卫）。
    const [commandRunning, setCommandRunning] = useState(false);

    // `/` 命令下拉菜单状态 + 高亮项索引。菜单状态需要在 ProseMirror 的
    // handleKeyDown（闭包在 useEditor 配置对象里固化，见下方 menuKeyDownRef
    // 注释）里同步读到最新值，React state 的渲染延迟不够用，所以每次
    // setState 都同步镜像一份到 ref，读写口径统一收敛在下面两个 setter。
    const menuStateRef = useRef<SlashMenuState>(CLOSED_SLASH_MENU);
    const [menuState, setMenuStateRaw] =
      useState<SlashMenuState>(CLOSED_SLASH_MENU);
    const setMenuState = useCallback((next: SlashMenuState) => {
      menuStateRef.current = next;
      setMenuStateRaw(next);
    }, []);
    const highlightIndexRef = useRef(0);
    const [highlightIndex, setHighlightIndexRaw] = useState(0);
    const setHighlightIndex = useCallback((next: number) => {
      highlightIndexRef.current = next;
      setHighlightIndexRaw(next);
    }, []);

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
          // IME 组合期间不拦截任何按键（含菜单的方向键/Enter/Esc）
          if (event.isComposing || event.keyCode === 229) return false;
          // 命令菜单开着时，↑↓/Enter/Esc 优先交给菜单；菜单没消费（未打开或
          // 非这几个键）才落到下面的普通发送/换行逻辑——menuKeyDownRef 同
          // sendFnRef 的道理：本对象在 useEditor 里固化，必须走 ref 转发才能
          // 读到最新的菜单状态与命令列表。
          if (menuKeyDownRef.current(event.key)) {
            event.preventDefault();
            return true;
          }
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            sendFnRef.current();
            return true;
          }
          return false;
        },
      },
      onUpdate: ({ editor: e }) => {
        const text = getMarkdown(e.storage);
        onChange(text);
        setIsEmpty(e.isEmpty);
        // 用户继续编辑即视为已看到/在处理提示，清掉旧的内联命令提示。
        setCommandHint(null);
        // 每次内容变化都重新判定命令菜单该不该开、过滤哪些项；过滤结果变了
        // 旧的高亮位置就没意义，统一回到第一项。
        setMenuState(computeSlashMenu(text, commands));
        setHighlightIndex(0);
      },
    });

    /**
     * 执行一条命令的唯一入口（菜单 Enter / 菜单点击 / 无菜单时的直接 Enter
     * 精确匹配三条路径共用）：运行中或已有命令在执行时忽略（同一守卫，双重
     * 兜底——handleSend 顶部已挡一次，这里再挡一次是因为菜单 Enter 走
     * menuKeyDownRef 直连，不经过 handleSend 那层）。
     */
    const executeCommand = useCallback(
      (command: SlashCommand) => {
        if (isLoading || commandRunning) return;
        editor?.commands.clearContent();
        onChange("");
        setCommandHint(null);
        setMenuState(CLOSED_SLASH_MENU);
        setCommandRunning(true);
        command
          .run()
          .then((result) => {
            if (result) setCommandHint(result);
          })
          .catch((err: unknown) => {
            setCommandHint(err instanceof Error ? err.message : String(err));
          })
          .finally(() => setCommandRunning(false));
      },
      [editor, onChange, isLoading, commandRunning, setMenuState],
    );

    /**
     * 菜单开着时处理 ↑↓/Enter/Esc；返回 true 表示已消费（调用方需
     * preventDefault，不再往下落到发送/换行/光标移动）。非这几个键或菜单
     * 未打开时返回 false，原样放行。
     */
    const handleMenuKeyDown = useCallback(
      (key: string): boolean => {
        const state = menuStateRef.current;
        if (!state.open) return false;
        const len = state.filtered.length;
        if (key === "ArrowDown") {
          setHighlightIndex(
            len === 0 ? 0 : (highlightIndexRef.current + 1) % len,
          );
          return true;
        }
        if (key === "ArrowUp") {
          setHighlightIndex(
            len === 0 ? 0 : (highlightIndexRef.current - 1 + len) % len,
          );
          return true;
        }
        if (key === "Escape") {
          // 只关菜单，不清输入——用户可能还想接着改这句命令。
          setMenuState(CLOSED_SLASH_MENU);
          return true;
        }
        if (key === "Enter") {
          const highlighted = state.filtered[highlightIndexRef.current];
          if (highlighted) executeCommand(highlighted);
          // 空态（无匹配项）时也吞掉 Enter：菜单开着就不该落到发送/换行。
          return true;
        }
        return false;
      },
      [executeCommand, setMenuState, setHighlightIndex],
    );

    // 每次 handleMenuKeyDown 更新时同步到 ref（声明见组件顶部），让
    // handleKeyDown 读到最新版本。
    useEffect(() => {
      menuKeyDownRef.current = handleMenuKeyDown;
    }, [handleMenuKeyDown]);

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
        // 命中命令：交给 executeCommand 统一处理（不触发 onSend、清空输入、
        // run() 执行期禁止重复触发）。这条路径主要覆盖菜单已经关闭的场景
        // （如文本末尾带了空格——见 computeSlashMenu 的触发条件），菜单开着
        // 时 Enter 已被 handleMenuKeyDown 先一步消费，走不到这里。
        executeCommand(match.command);
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
    }, [
      editor,
      onSend,
      onChange,
      isLoading,
      commands,
      commandRunning,
      labels,
      executeCommand,
    ]);

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
      <div className="relative">
        {/* `/` 命令下拉菜单：浮在输入框上方（不在 UnifiedSheet 内，z-50 足够）。
            仅 `commands` 非空且 computeSlashMenu 判定 open 时渲染；未传 commands
            的输入框（dock/远程会话/新消息页）永远不会走到这里。
            ⚠️ 必须挂在 overflow-hidden 容器**之外**（bottom-full 往上弹 +
            overflow-hidden 会把它整个裁掉——「渲染了但不可见」同族坑）。 */}
        {menuState.open && (
          <div
            role="listbox"
            aria-label="/ commands"
            className="absolute inset-x-0 bottom-full z-50 mb-1 max-h-60 overflow-y-auto rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-md"
          >
            {menuState.filtered.length === 0
              ? labels.commandMenuEmpty && (
                  <div className="px-2 py-1.5 text-muted-foreground text-xs">
                    {labels.commandMenuEmpty}
                  </div>
                )
              : menuState.filtered.map((cmd, i) => (
                  <button
                    key={cmd.name}
                    type="button"
                    role="option"
                    aria-selected={i === highlightIndex}
                    onMouseEnter={() => setHighlightIndex(i)}
                    onClick={() => executeCommand(cmd)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-popover-foreground transition-colors",
                      i === highlightIndex &&
                        "bg-accent text-accent-foreground",
                    )}
                  >
                    <span className="shrink-0 font-mono text-xs">
                      /{cmd.name}
                    </span>
                    <span className="truncate text-muted-foreground text-xs">
                      {cmd.description}
                    </span>
                  </button>
                ))}
          </div>
        )}

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
      </div>
    );
  },
);
