# 消息壳重构 · Plan 2：共享富文本输入（Markdown 辅助）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把共享 `ChatInput` 的装饰性工具条变成可用的 **Markdown 辅助** 工具条（选区包裹 markdown 语法），频道/私信/助手统一受益；消息侧已用 react-markdown 渲染，无需改后端。

**Architecture:** 纯前端（`apps/web-agent`）。采用 **Markdown 辅助**：编辑器内容始终是纯文本 markdown 源；工具条按钮对当前选区做纯字符串变换（`**粗**`、`*斜*`、`~~删~~`、`` `码` ``、代码块、`[文字](url)`、`- `/`1. ` 列表）。为让选区操作稳健且可单测，把编辑器从 contentEditable 改为**自适应高度的 `<textarea>`**（值仍是纯文本，`selectionStart/End` 是扁平偏移，变换逻辑可纯函数化 + TDD）；`ChatInput` 对外接口完全不变，三个调用页零改动。附件本期不做（零后端基建，拆独立后端项目）。

**Tech Stack:** React 19、next-intl 4、Tailwind v4、lucide-react；纯逻辑用根 Jest（`testEnvironment: node`，`*.test.ts`，roots 含 apps）做 TDD。

## Global Constraints

- 目标包：仅 `apps/web-agent`，不改后端 / `libs/*`。
- `ChatInput` 公开接口**保持不变**：props `{value,onChange,onSend?,onInterrupt?,isLoading?,placeholder?,modelName?,tokenUsage?}` 与 `ref` 句柄 `focus(withText?)`。调用页（`app/messages/page.tsx`、`app/session/page.tsx`、`app/assistant/page.tsx`）不得需要改动。
- 编辑器值语义：纯文本 markdown 源（与现状一致，发送内容不变）。不引入新运行时依赖（不加富文本编辑器库）。
- i18n：新增工具条 aria-label / 提示走 next-intl `chatInput` 命名空间，**同时**改 `apps/web-agent/messages/zh.json` 与 `en.json`；遵循仓库已知「扁平 stub」工作流（新增嵌套 `t()` 后若 `sync:locales --check` 报 MISSING，按既有模式在根补空扁平 stub；空扁平值是正常的）。`missing=0, asymmetric=0` 必须保持。无裸字符串。
- 配色沿用 `--shell-*` 变量；强调色 `bg-(--shell-accent)`。
- IME 安全：保留现有「组合期不拦截 Enter」逻辑（`e.nativeEvent.isComposing || e.keyCode===229`）。Enter 发送 / Shift+Enter 换行不变。
- 提交信息中文、conventional commits，结尾加 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
- 每个 Task 后跑 `pnpm --filter @meshbot/web-agent typecheck` 与 `pnpm lint` 必须过。

---

### Task 1: Markdown 变换纯函数 + TDD

把工具条要用的字符串变换抽成纯函数，输入 `{text, start, end}`（扁平偏移），输出新的 `{text, start, end}`（含变换后应选中的范围）。全部用根 Jest 单测。

**Files:**
- Create: `apps/web-agent/src/lib/markdown-format.ts`
- Create: `apps/web-agent/src/lib/markdown-format.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface EditState { text: string; start: number; end: number; }
  export function wrapInline(s: EditState, marker: string): EditState;     // 切换式：已包裹则去除
  export function applyLinePrefix(s: EditState, prefix: string): EditState; // 整行加/去前缀（列表）
  export function applyCodeBlock(s: EditState): EditState;                  // ``` 围栏
  export function applyLink(s: EditState, url: string): EditState;          // [sel](url)，选中 url 占位
  ```
- Consumes: 无。

- [ ] **Step 1: 写失败测试**

`apps/web-agent/src/lib/markdown-format.test.ts`：

```ts
import {
  applyCodeBlock,
  applyLinePrefix,
  applyLink,
  wrapInline,
} from "./markdown-format";

describe("wrapInline", () => {
  it("包裹非空选区", () => {
    expect(wrapInline({ text: "abc", start: 0, end: 3 }, "**")).toEqual({
      text: "**abc**",
      start: 2,
      end: 5,
    });
  });
  it("空选区插入成对标记并把光标放中间", () => {
    expect(wrapInline({ text: "ab", start: 1, end: 1 }, "*")).toEqual({
      text: "a*ab".slice(0, 1) + "**" + "ab".slice(1), // 见下方等价断言
      start: 2,
      end: 2,
    });
  });
  it("已包裹则切换去除", () => {
    expect(wrapInline({ text: "**abc**", start: 2, end: 5 }, "**")).toEqual({
      text: "abc",
      start: 0,
      end: 3,
    });
  });
});

describe("applyLinePrefix", () => {
  it("给选中的多行加前缀", () => {
    expect(
      applyLinePrefix({ text: "a\nb", start: 0, end: 3 }, "- "),
    ).toEqual({ text: "- a\n- b", start: 0, end: 7 });
  });
  it("整块已带前缀则去除（切换）", () => {
    expect(
      applyLinePrefix({ text: "- a\n- b", start: 0, end: 7 }, "- "),
    ).toEqual({ text: "a\nb", start: 0, end: 3 });
  });
  it("光标在行中也作用于整行", () => {
    expect(
      applyLinePrefix({ text: "hello", start: 2, end: 2 }, "1. "),
    ).toEqual({ text: "1. hello", start: 0, end: 8 });
  });
});

describe("applyCodeBlock", () => {
  it("用围栏包裹选区", () => {
    expect(applyCodeBlock({ text: "x", start: 0, end: 1 })).toEqual({
      text: "```\nx\n```",
      start: 4,
      end: 5,
    });
  });
});

describe("applyLink", () => {
  it("把选区变链接并选中 url 占位", () => {
    // before="", sel="t" → "[t](url)"，选中 "url"（位于 index 4..7）
    expect(applyLink({ text: "t", start: 0, end: 1 }, "url")).toEqual({
      text: "[t](url)",
      start: 4,
      end: 7,
    });
  });
});
```

> 注：上面 `wrapInline` 空选区那条断言里的 `text` 表达式等价于 `"a**b"`；如嫌绕，直接写 `text: "a**b"`。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test -- markdown-format`
Expected: FAIL（`Cannot find module './markdown-format'`）。

- [ ] **Step 3: 写实现**

`apps/web-agent/src/lib/markdown-format.ts`：

```ts
/** 文本 + 选区（扁平偏移）。所有变换返回新文本与变换后应选中的范围。 */
export interface EditState {
  text: string;
  start: number;
  end: number;
}

/** 行内标记包裹；若选区紧邻外侧已是该标记则切换去除。空选区插入成对标记，光标居中。 */
export function wrapInline(s: EditState, marker: string): EditState {
  const before = s.text.slice(0, s.start);
  const sel = s.text.slice(s.start, s.end);
  const after = s.text.slice(s.end);
  if (before.endsWith(marker) && after.startsWith(marker)) {
    const nb = before.slice(0, before.length - marker.length);
    const na = after.slice(marker.length);
    return { text: nb + sel + na, start: nb.length, end: nb.length + sel.length };
  }
  const text = before + marker + sel + marker + after;
  return {
    text,
    start: s.start + marker.length,
    end: s.end + marker.length,
  };
}

/** 对选区覆盖的整行加前缀；若所有行都已有该前缀则去除（切换）。 */
export function applyLinePrefix(s: EditState, prefix: string): EditState {
  const lineStart = s.text.lastIndexOf("\n", s.start - 1) + 1;
  let lineEnd = s.text.indexOf("\n", s.end);
  if (lineEnd === -1) lineEnd = s.text.length;
  const block = s.text.slice(lineStart, lineEnd);
  const lines = block.split("\n");
  const allPrefixed = lines.every((l) => l.startsWith(prefix));
  const newLines = allPrefixed
    ? lines.map((l) => l.slice(prefix.length))
    : lines.map((l) => prefix + l);
  const newBlock = newLines.join("\n");
  const text = s.text.slice(0, lineStart) + newBlock + s.text.slice(lineEnd);
  return { text, start: lineStart, end: lineStart + newBlock.length };
}

/** 用 ``` 围栏包裹选区。 */
export function applyCodeBlock(s: EditState): EditState {
  const before = s.text.slice(0, s.start);
  const sel = s.text.slice(s.start, s.end);
  const after = s.text.slice(s.end);
  const fenced = "```\n" + sel + "\n```";
  return {
    text: before + fenced + after,
    start: before.length + 4,
    end: before.length + 4 + sel.length,
  };
}

/** 把选区变成 [文字](url)；选中 url 占位便于继续输入。空选区用 "文字" 作占位文本。 */
export function applyLink(s: EditState, url: string): EditState {
  const before = s.text.slice(0, s.start);
  const sel = s.text.slice(s.start, s.end) || "文字";
  const after = s.text.slice(s.end);
  const inserted = `[${sel}](${url})`;
  const urlStart = before.length + 1 + sel.length + 2; // "[" + sel + "](" 之后
  return {
    text: before + inserted + after,
    start: urlStart,
    end: urlStart + url.length,
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test -- markdown-format`
Expected: PASS（全部用例绿）。如 `applyLink` 空选区占位文本「文字」长度影响断言，按实现的中文占位调整测试中相应数值——以上测试用例均为非空选区或不含中文占位，应直接通过。

- [ ] **Step 5: typecheck + 提交**

Run: `pnpm --filter @meshbot/web-agent typecheck && pnpm lint`
Expected: 通过。

```bash
git add apps/web-agent/src/lib/markdown-format.ts apps/web-agent/src/lib/markdown-format.test.ts
git commit -m "feat(web-agent): 新增 Markdown 选区变换纯函数（含单测）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: ChatInput 编辑器改为自适应 textarea（接口不变）

把 `ChatInput` 内部的 contentEditable 编辑器换成受控 `<textarea>` + 自适应高度，保留全部对外接口与行为（Enter 发送 / Shift+Enter 换行 / IME 安全 / `focus(withText)` 句柄 / token 环 / 中断键 / 发送键）。本 Task **不加**格式化逻辑（Task 3 做），工具条暂保持现有装饰外观。

**Files:**
- Modify: `apps/web-agent/src/components/common/chat-input.tsx`

**Interfaces:**
- Consumes: 无新增。
- Produces: `ChatInput` 接口不变（见 Global Constraints）。

- [ ] **Step 1: 确认调用方，锁定接口**

Run: `grep -rn --include='*.tsx' "<ChatInput" apps/web-agent/src`
Expected: 仅 `app/messages/page.tsx`、`app/session/page.tsx`、`app/assistant/page.tsx`。记录它们传的 props，确保改造后签名一致、这三个文件**不需要改**。

- [ ] **Step 2: 用 textarea 重写编辑区**

在 `chat-input.tsx` 中，把当前 contentEditable 块（现约 162-182 行的 `<div className="relative w-full">…contentEditable…</div>`）替换为受控自适应 textarea。要点：

- `editorRef` 类型从 `HTMLDivElement` 改为 `HTMLTextAreaElement`。
- 受控：`value={value}`，`onChange={(e)=>onChange(e.target.value)}`（删除原 `handleInput` 读 `innerText` 的逻辑）。
- 用原生 `placeholder`（删除原 `!hasContent && <div>…overlay</div>` 占位层）。
- 自适应高度：加一个随 `value` 变化把 `height` 复位再设为 `scrollHeight`（上限 200px，超出 `overflow-y:auto`）的副作用；以及在 `onChange` 时同步执行。
- 删除「外部 value 与 DOM innerText 不一致时同步」的旧 effect（受控 textarea 不需要）。
- `focus(withText)` 句柄改为：`el.focus()` 后 `const pos=(withText ?? value).length; el.setSelectionRange(pos,pos)`（光标置末尾）。
- `handleKeyDown` 保留：IME 组合判断 + Enter 发送 / Shift+Enter 换行（`<textarea>` 上同样适用）。
- `handleSend` 保留：trim、`onSend`、`onChange("")`（不再手动清 DOM——受控）。

替换后的编辑区 JSX（嵌在现有 `<div className="flex items-center gap-2 px-3 py-2">` 内，取代原 `<div className="relative w-full">…</div>`）：

```tsx
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
```

自适应高度副作用（放在组件体内，紧随 refs 定义后；用一个小工具避免重复）：

```tsx
    // 自适应高度：每次 value 变化，先复位再撑到 scrollHeight（CSS max-h 封顶后内部滚动）
    useEffect(() => {
      const el = editorRef.current;
      if (!el) return;
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    }, [value]);
```

`focus` 句柄改写（替换 `useImperativeHandle` 内实现）：

```tsx
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
```

删除：旧的 `handleInput`、旧的「同步 innerText」effect、旧的 `hasContent &&` placeholder 覆盖层。保留 `hasContent`（发送键 disabled 仍用）。

- [ ] **Step 3: typecheck + lint**

Run: `pnpm --filter @meshbot/web-agent typecheck && pnpm lint`
Expected: 通过（`editorRef` 类型已改为 `HTMLTextAreaElement`；无残留 `innerText` 引用）。

- [ ] **Step 4: 视觉/交互确认**

`pnpm dev:web-agent`，在频道、私信、助手三处分别：输入多行（看自适应增高到上限后内部滚动）、Enter 发送、Shift+Enter 换行、中文输入法回车确认候选词不误发、点会话从 draft 灌入时光标在末尾。

- [ ] **Step 5: 提交**

```bash
git add apps/web-agent/src/components/common/chat-input.tsx
git commit -m "refactor(web-agent): ChatInput 编辑器改为自适应 textarea（接口不变）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: 工具条接入 Markdown 变换 + 快捷键

把装饰性工具条（B/I/U/≡/</>）替换为可用按钮，点击对 textarea 当前选区应用 Task 1 的变换；补常用快捷键（⌘/Ctrl+B 粗、+I 斜、+K 链接）。

**Files:**
- Modify: `apps/web-agent/src/components/common/chat-input.tsx`
- Modify: `apps/web-agent/messages/zh.json`、`apps/web-agent/messages/en.json`（`chatInput` 工具条 aria-label）

**Interfaces:**
- Consumes: `wrapInline`/`applyLinePrefix`/`applyCodeBlock`/`applyLink`（Task 1）；lucide-react 图标 `Bold,Italic,Strikethrough,Code,Link,List,ListOrdered`。

- [ ] **Step 1: 加 i18n key**

`zh.json` 的 `chatInput` 命名空间补：

```json
"format": {
  "bold": "加粗",
  "italic": "斜体",
  "strikethrough": "删除线",
  "code": "行内代码",
  "codeBlock": "代码块",
  "link": "链接",
  "bulletList": "无序列表",
  "numberedList": "有序列表"
}
```

`en.json` 同步：

```json
"format": {
  "bold": "Bold",
  "italic": "Italic",
  "strikethrough": "Strikethrough",
  "code": "Inline code",
  "codeBlock": "Code block",
  "link": "Link",
  "bulletList": "Bulleted list",
  "numberedList": "Numbered list"
}
```

若 `pnpm sync:locales --check` 报 MISSING（命名空间裸 key 扫描），按仓库既有「扁平 stub」做法在两文件根补对应空 stub（空值正常）。保持 `missing=0, asymmetric=0`。

- [ ] **Step 2: 写一个应用变换的内部函数**

在 `chat-input.tsx` 内加（依赖 `editorRef`、`value`、`onChange`）：

```tsx
    // 对 textarea 当前选区应用一个 EditState 变换，更新值并恢复选区
    const applyFormat = useCallback(
      (fn: (s: EditState) => EditState) => {
        const el = editorRef.current;
        if (!el) return;
        const next = fn({ text: value, start: el.selectionStart, end: el.selectionEnd });
        onChange(next.text);
        // 值受控更新是异步的；下一帧恢复选区
        requestAnimationFrame(() => {
          el.focus();
          el.setSelectionRange(next.start, next.end);
        });
      },
      [value, onChange],
    );
```

import 顶部加：`import { type EditState, applyCodeBlock, applyLinePrefix as _x } ...`（实际按需引入；见下）。正确 import：

```tsx
import {
  applyCodeBlock,
  applyLinePrefix,
  applyLink,
  type EditState,
  wrapInline,
} from "@/lib/markdown-format";
```

- [ ] **Step 3: 替换工具条 JSX**

把现有装饰工具条（约 153-160 行 `<div className="flex items-center gap-3 border-b …">…B I U ≡ </></div>`）替换为可点击按钮组：

```tsx
        <div className="flex items-center gap-1 border-b border-border px-2 py-1 text-muted-foreground">
          {(
            [
              { key: "bold", Icon: Bold, run: () => applyFormat((s) => wrapInline(s, "**")) },
              { key: "italic", Icon: Italic, run: () => applyFormat((s) => wrapInline(s, "*")) },
              { key: "strikethrough", Icon: Strikethrough, run: () => applyFormat((s) => wrapInline(s, "~~")) },
              { key: "code", Icon: Code, run: () => applyFormat((s) => wrapInline(s, "`")) },
              { key: "codeBlock", Icon: SquareCode, run: () => applyFormat(applyCodeBlock) },
              { key: "link", Icon: Link, run: () => applyFormat((s) => applyLink(s, "url")) },
              { key: "bulletList", Icon: List, run: () => applyFormat((s) => applyLinePrefix(s, "- ")) },
              { key: "numberedList", Icon: ListOrdered, run: () => applyFormat((s) => applyLinePrefix(s, "1. ")) },
            ] as const
          ).map(({ key, Icon, run }) => (
            <button
              key={key}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={run}
              title={tChat(`format.${key}`)}
              aria-label={tChat(`format.${key}`)}
              className="flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-muted hover:text-foreground"
            >
              <Icon className="h-3.5 w-3.5" />
            </button>
          ))}
        </div>
```

> `onMouseDown` preventDefault 防止点击工具条时 textarea 失焦丢选区。`link` 用占位 `"url"`（`applyLink` 会选中它便于改写），v1 不弹 prompt。

import 顶部加图标：

```tsx
import {
  Bold,
  Code,
  Italic,
  Link,
  List,
  ListOrdered,
  Paperclip,
  Send,
  Square,
  SquareCode,
  Strikethrough,
} from "lucide-react";
```

（`Paperclip`/`Send`/`Square` 已在用，保留；`SquareCode` 作代码块图标。）

- [ ] **Step 4: 快捷键**

在 `handleKeyDown` 里，IME 判断之后、Enter 处理之前，加：

```tsx
        const mod = e.metaKey || e.ctrlKey;
        if (mod && !e.shiftKey) {
          const k = e.key.toLowerCase();
          if (k === "b") { e.preventDefault(); applyFormat((s) => wrapInline(s, "**")); return; }
          if (k === "i") { e.preventDefault(); applyFormat((s) => wrapInline(s, "*")); return; }
          if (k === "k") { e.preventDefault(); applyFormat((s) => applyLink(s, "url")); return; }
        }
```

`handleKeyDown` 的依赖数组加入 `applyFormat`。

- [ ] **Step 5: typecheck + lint**

Run: `pnpm --filter @meshbot/web-agent typecheck && pnpm lint`
Expected: 通过。

- [ ] **Step 6: 交互确认**

`pnpm dev:web-agent`：选中文字点 B → 变 `**文字**`；空选点 B → `****` 光标居中；多行选中点列表 → 每行加 `- `；⌘B/⌘I/⌘K 生效；点工具条不丢选区；发送后内容按 markdown 渲染（频道/私信/助手一致）。

- [ ] **Step 7: 提交**

```bash
git add apps/web-agent/src/components/common/chat-input.tsx apps/web-agent/messages/zh.json apps/web-agent/messages/en.json
git commit -m "feat(web-agent): ChatInput 工具条接入 Markdown 辅助 + 快捷键

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 非本计划范围

- 附件全栈（上传端点 + 对象存储 + 消息 attachments 字段 + 前端选择/预览）——零后端基建，拆独立后端项目；本期工具条不含附件按钮逻辑（现有装饰 Paperclip 保留外观，不接行为）。
- WYSIWYG（所见即所得）富文本——本期为 Markdown 辅助；若日后要 WYSIWYG 再单独评估引入编辑器库。
- 统一「新消息」、随手问面板、对话区精修——各自后续计划。

## Self-Review（对照 spec + 决策）

- **覆盖**：spec「富文本输入（加粗/斜体/删除线/链接/有序·无序列表/行内代码·代码块）+ 自适应高度」→ Task 1（变换）+ Task 2（自适应 textarea）+ Task 3（工具条+快捷键）。附件按既定决策**显式排除**。
- **接口不变**：Task 2 保证三个调用页零改动（Step 1 grep 锁定 + 接口约束）。
- **占位符扫描**：无 TBD；`applyLink` 用 `"url"` 占位是明确设计（v1 不弹 prompt）。
- **类型一致**：`EditState` 贯穿 Task 1/3；四个变换函数名（`wrapInline`/`applyLinePrefix`/`applyCodeBlock`/`applyLink`）在 Task 3 调用处一致。
- **风险**：受控 textarea 选区恢复用 `requestAnimationFrame`（值更新异步）；`onMouseDown preventDefault` 防失焦；自适应高度 effect 依赖 `value`。这些在 Task 2/3 已显式写出。i18n 扁平 stub 行为按仓库既有工作流处理。
