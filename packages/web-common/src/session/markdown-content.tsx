"use client";

import { cn } from "@meshbot/design";
import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

/**
 * 流式 markdown 内容渲染器。assistant content 用，reasoning 仍走纯文本。
 *
 * 从 `apps/web-agent/src/components/session/markdown-content.tsx` 迁入
 * （Task 7）——组件本身零外部依赖（无 atom/next-intl/apiClient），整体搬迁。
 *
 * - GFM：表格、删除线、task list、自动链接
 * - highlight.js：fenced code 自动识别语言并加 .hljs 类，依赖调用方
 *   globals.css 里导入的 github.css 主题
 * - 组件映射：让常用 md 元素贴合 design token（直角、无大色块、字号阶梯）
 * - memo：流式输出每个 chunk 都 setState，节点未变化的子树跳过重渲
 */
const components: Components = {
  p: ({ className, ...p }) => (
    <p className={cn("mb-2 last:mb-0", className)} {...p} />
  ),
  ul: ({ className, ...p }) => (
    <ul
      className={cn("mb-2 ml-4 list-disc space-y-0.5 last:mb-0", className)}
      {...p}
    />
  ),
  ol: ({ className, ...p }) => (
    <ol
      className={cn("mb-2 ml-4 list-decimal space-y-0.5 last:mb-0", className)}
      {...p}
    />
  ),
  li: ({ className, ...p }) => <li className={cn("", className)} {...p} />,
  h1: ({ className, ...p }) => (
    <h1
      className={cn("mb-2 mt-3 text-base font-semibold first:mt-0", className)}
      {...p}
    />
  ),
  h2: ({ className, ...p }) => (
    <h2
      className={cn("mb-2 mt-3 text-base font-semibold first:mt-0", className)}
      {...p}
    />
  ),
  h3: ({ className, ...p }) => (
    <h3
      className={cn("mb-1.5 mt-2 text-sm font-semibold first:mt-0", className)}
      {...p}
    />
  ),
  a: ({ className, ...p }) => (
    <a
      className={cn("text-foreground underline underline-offset-2", className)}
      target="_blank"
      rel="noreferrer noopener"
      {...p}
    />
  ),
  blockquote: ({ className, ...p }) => (
    <blockquote
      className={cn(
        "my-2 border-l-2 border-border/60 pl-3 text-muted-foreground",
        className,
      )}
      {...p}
    />
  ),
  hr: ({ className, ...p }) => (
    <hr className={cn("my-3 border-border/60", className)} {...p} />
  ),
  table: ({ className, ...p }) => (
    <div className="my-2 overflow-x-auto">
      <table
        className={cn("w-full border-collapse text-xs", className)}
        {...p}
      />
    </div>
  ),
  th: ({ className, ...p }) => (
    <th
      className={cn(
        "border border-border/60 bg-muted/40 px-2 py-1 text-left font-medium",
        className,
      )}
      {...p}
    />
  ),
  td: ({ className, ...p }) => (
    <td className={cn("border border-border/60 px-2 py-1", className)} {...p} />
  ),
  code: ({ className, children, ...p }) => {
    // 行内 code：无 className（react-markdown 给 fenced code 加 language-*）
    const isInline = !className;
    if (isInline) {
      return (
        <code className="bg-muted px-1 py-0.5 font-mono text-[0.85em]" {...p}>
          {children}
        </code>
      );
    }
    return (
      <code className={cn(className, "font-mono text-[0.85em]")} {...p}>
        {children}
      </code>
    );
  },
  pre: ({ className, ...p }) => (
    <pre
      className={cn(
        "my-2 overflow-x-auto bg-muted px-3 py-2 text-xs leading-relaxed",
        className,
      )}
      {...p}
    />
  ),
};

/**
 * 渲染流式 markdown。每次 props.children 变化（每个 chunk）会重新解析。
 * react-markdown 内部 memo 单元素子树，逐 chunk 增长时只有末尾节点改变。
 *
 * `streaming=true` 时，CSS 用 `::after` 给最后一个块级子元素尾部注入光标，
 * 避免 inline `<span>` 光标被块级渲染推到新一行。
 */
function MarkdownContentInner({
  text,
  streaming,
}: {
  text: string;
  streaming?: boolean;
}) {
  return (
    <div className={cn("space-y-0", streaming && "md-streaming")}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

export const MarkdownContent = memo(MarkdownContentInner);
