# WYSIWYG 富文本输入(全套 markdown 化) 实施计划

> REQUIRED SUB-SKILL: subagent-driven-development。Steps 用 `- [ ]`。

**Goal:** 把共享 `ChatInput` 从「textarea + 插 markdown 语法」改为 **TipTap 所见即所得富文本编辑器**(加粗即显示加粗,而非 `****`);发送仍输出 **markdown 字符串**(后端/存储零改);私信/频道消息改为按 markdown 渲染,全局一致。

**Architecture:** 纯前端 `apps/web-agent`。TipTap v3 (ProseMirror) WYSIWYG;`tiptap-markdown` 负责 doc⇄markdown 双向;`ChatInput` 公开契约 `{value,onChange,onSend?,onInterrupt?,isLoading?,placeholder?,modelName?,tokenUsage?}` + `ref.focus(withText?)` **完全不变** → 5 个调用页零改动。

**Tech Stack:** React 19、Next.js App Router、TipTap v3、Tailwind v4、lucide-react。

## Global Constraints
- 仅改 `apps/web-agent`,不碰后端/`libs/*`。
- 依赖:`@tiptap/react@^3 @tiptap/starter-kit@^3 @tiptap/pm@^3 tiptap-markdown@^0.9`(StarterKit v3 已含 Link/列表/marks + 输入规则;无需单独装 extension-link,如缺再 configure)。
- `ChatInput` 公开契约 + ref 句柄保持不变;调用页(assistant/page、session/assistant-conversation-body、im/im-conversation-body、im/new-message-view、im/assistant-dock)不得改。
- 编辑器值语义对外仍是 **markdown 字符串**(发送内容、草稿持久化均 markdown)。
- IME 安全:组合期(`isComposing`/keyCode 229)不拦 Enter;Enter 发送、Shift+Enter 换行。
- Next.js App Router:`useEditor({ immediatelyRender: false, ... })` 防 hydration 报错。
- 保留:自适应高度(max-h 200 内部滚动)、附件按钮、token 环、model 标、中断/发送键、placeholder、空内容禁用发送。
- 配色 `--shell-*` / `border-border` / `bg-card`;i18n 走 `chatInput` 命名空间,无裸字符串。
- 提交中文 conventional;结尾 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。

---

### Task 1: ChatInput → TipTap WYSIWYG(核心)
**Files:** Modify `apps/web-agent/src/components/common/chat-input.tsx`

要点:
- `useEditor`:extensions = `StarterKit`(配 bold/italic/strike/code/codeBlock/bulletList/orderedList/link)+ `Markdown`(tiptap-markdown,`transformPastedText:true`)。`immediatelyRender:false`。`editorProps.attributes.class` 给排版样式(prose 风,贴 design token:text-sm、列表缩进、代码块 bg-muted 等)。
- **受控 value 同步守卫**:外部 `value`(markdown)变化时,仅当 `value !== editor.storage.markdown.getMarkdown()` 才 `editor.commands.setContent(value)`(防自身 onChange 回环 + 光标跳)。`onUpdate` → `onChange(editor.storage.markdown.getMarkdown())`。
- **发送**:序列化 `editor.storage.markdown.getMarkdown()`.trim() → `onSend`;成功后 `editor.commands.clearContent()` + `onChange("")`。
- **键盘**:`editorProps.handleKeyDown` 或 `handleDOMEvents` 实现:组合期不拦;Cmd/Ctrl+B/I/K 走 TipTap 命令;Enter(非 shift、非组合)发送、Shift+Enter 换行(TipTap 默认 hardBreak)。
- **ref.focus(withText?)**:`editor.commands.focus("end")`。
- **工具栏**:8 个按钮改成 `editor.chain().focus().toggleBold()...run()` 等真实 toggle;按 `editor.isActive("bold")` 高亮激活态(`text-foreground bg-muted` vs 默认)。markdown 输入规则由 StarterKit 自带(打 `**x**`/`- ` 自动转)。
- **自适应高度**:编辑器容器 `max-h-[200px] overflow-y-auto`,内容自然撑高;移除原 textarea 的 scrollHeight effect。
- 保留底部栏(附件/token 环/model)与中断/发送键、空内容禁用逻辑完全不变。
- `hasContent` 用 `!editor?.isEmpty`。

验证:`pnpm --filter @meshbot/web-agent typecheck` + `pnpm lint`。富文本交互靠人工目检。

### Task 2: 私信/频道消息渲染 markdown
**Files:** Modify `apps/web-agent/src/components/im/im-message-list.tsx`
- 把消息正文 `<div className="whitespace-pre-wrap …">{m.content}</div>` 换成 `<MarkdownContent text={m.content} />`(import from `@/components/session/markdown-content`)。保留外层文字色/字号容器。验证 typecheck/lint。

### Task 3: 清理 + 全量校验
**Files:** Delete `apps/web-agent/src/lib/markdown-format.ts` + `markdown-format.test.ts`;移除 chat-input 里对它的 import。
- 确认 5 个调用页未改动仍编译。
- `pnpm --filter @meshbot/web-agent typecheck` + `pnpm lint` + 改动文件 `biome check --write`。
- jest:`pnpm test -- markdown-format` 应因文件删除而无用例(确认没有别处 import 它)。
