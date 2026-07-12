"use client";

import { cn } from "@meshbot/design";
import Placeholder from "@tiptap/extension-placeholder";
import { EditorContent, useEditor } from "@tiptap/react";
import { StarterKit } from "@tiptap/starter-kit";
import { Paperclip, Send } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Markdown } from "tiptap-markdown";

/** editor.storage 在挂载 tiptap-markdown 后的实际形态（类型断言辅助）。 */
interface MarkdownEditorStorage {
  markdown: { getMarkdown(): string };
}

/** 从 editor.storage 中安全取出 markdown 字符串。 */
function getMarkdown(storage: unknown): string {
  return (storage as MarkdownEditorStorage).markdown.getMarkdown();
}

export interface MessageInputLabels {
  /** 附件按钮 title/aria（当前为占位 mock，点击无副作用）。 */
  attachment?: string;
  /** 发送按钮 title。 */
  send?: string;
}

export interface MessageInputProps {
  onSend: (text: string) => void;
  /** 禁用整个输入（编辑器只读 + 发送按钮禁用）。默认 false。 */
  disabled?: boolean;
  placeholder?: string;
  labels?: MessageInputLabels;
}

/**
 * IM 消息输入框：tiptap 富文本编辑器（markdown 输出）+ 附件占位按钮 + 发送按钮。
 * 内部持有草稿状态（发送后自清空），非受控——调用方只关心 onSend 拿到的最终文本。
 * Enter 发送 / Shift+Enter 换行 / IME 组合期间不拦截，与 web-agent 会话输入框一致。
 */
export function MessageInput({
  onSend,
  disabled = false,
  placeholder,
  labels,
}: MessageInputProps) {
  // sendFnRef 让 handleKeyDown（在 useEditor 配置对象中捕获）始终能调用到最新的
  // handleSend，绕开闭包陈旧问题。
  const sendFnRef = useRef<() => void>(() => {});

  // 编辑器空态镜像：驱动发送按钮 disabled。不能直接读 editor.isEmpty——
  // 受控同步走 emitUpdate:false 不触发重渲，直读会拿到陈旧渲染帧的值。
  const [isEmpty, setIsEmpty] = useState(true);

  const editor = useEditor({
    immediatelyRender: false,
    editable: !disabled,
    extensions: [
      StarterKit,
      Placeholder.configure({ placeholder: placeholder ?? "" }),
      Markdown.configure({
        transformPastedText: true,
        transformCopiedText: true,
      }),
    ],
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
      setIsEmpty(e.isEmpty);
    },
  });

  const handleSend = useCallback(() => {
    if (disabled) return;
    if (!editor) return;
    const md = getMarkdown(editor.storage).trim();
    if (!md) return;
    onSend(md);
    editor.commands.clearContent();
  }, [editor, onSend, disabled]);

  // 每次 handleSend 更新时同步到 ref，让 handleKeyDown 读到最新版本
  useEffect(() => {
    sendFnRef.current = handleSend;
  }, [handleSend]);

  // 编辑器就绪时校准一次空态
  useEffect(() => {
    if (editor) setIsEmpty(editor.isEmpty);
  }, [editor]);

  // disabled 变化时同步编辑器只读态
  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [editor, disabled]);

  const hasContent = !!editor && !isEmpty;

  return (
    <div className="overflow-hidden rounded-[10px] border border-border bg-card">
      {/* 编辑区（tiptap；StarterKit 输入规则让 markdown 边打边可视化） */}
      <div className="px-3 pt-2.5 pb-1">
        <div className="max-h-[200px] w-full overflow-y-auto py-1.5">
          <EditorContent editor={editor} />
        </div>
      </div>

      {/* 底部动作栏：右=上传占位 + 发送 */}
      <div className="flex items-center gap-2 px-2.5 pb-2">
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {/* 上传（mock 占位，点击无副作用；真实上传 L1 不做） */}
          <button
            type="button"
            className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            title={labels?.attachment}
          >
            <Paperclip className="h-4 w-4" />
          </button>

          <button
            type="button"
            onClick={handleSend}
            disabled={!hasContent || disabled}
            className={cn(
              "flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors",
              hasContent && !disabled
                ? "bg-(--shell-accent) text-white"
                : "text-muted-foreground",
            )}
            title={labels?.send}
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
