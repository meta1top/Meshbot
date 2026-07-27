"use client";

import { json, jsonParseLinter } from "@codemirror/lang-json";
import { linter, lintGutter } from "@codemirror/lint";
import { Alert, AlertDescription, Button } from "@meshbot/design";
import CodeMirror, { EditorView } from "@uiw/react-codemirror";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

interface McpEditorProps {
  /** 当前 mcp.json 原始文本（受控）。 */
  value: string;
  /** 文本变化回调，由调用方负责落地到自己的 state（含脏判定）。 */
  onChange: (value: string) => void;
  /** 内联校验错误（JSON 语法错误 / 后端结构校验失败）；由调用方在保存前校验
   *  后传入，就地展示，不再像旧版那样切换 tab。 */
  error?: string | null;
  /** 加载中（编辑态首次拉取既有 mcp.json）。 */
  loading?: boolean;
  /** 加载失败。 */
  loadFailed?: boolean;
  /** 相对已保存基线是否有改动——驱动保存按钮的可用态（未改动禁用，隐式提示
   *  「已保存」，与提示词 tab 的保存按钮同一套语义）。 */
  dirty: boolean;
  /** 保存请求是否在途。 */
  saving?: boolean;
  /** 保存按钮点击回调——本组件不做提交，只触发调用方（`AgentEditorSheet`）
   *  编排好的保存动作。 */
  onSave: () => void;
}

/**
 * CodeMirror 主题：只写最小暖色适配，颜色全部取 CSS 变量（`var(--background)`
 * 等），天然跟随 `.dark` 类切换——不引入 @uiw 自带主题包，避免与壳的暖炭配橙
 * 视觉打架。选区/激活行/gutter 刻意用低对比度，避免刺眼。
 */
const mcpEditorTheme = EditorView.theme({
  "&": {
    backgroundColor: "var(--background)",
    color: "var(--foreground)",
    fontSize: "12.5px",
  },
  ".cm-content": {
    fontFamily:
      "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
    caretColor: "var(--foreground)",
  },
  "&.cm-focused": {
    outline: "none",
  },
  ".cm-gutters": {
    backgroundColor: "var(--background)",
    color: "var(--muted-foreground)",
    borderRight: "1px solid var(--border)",
  },
  ".cm-activeLine": {
    backgroundColor: "var(--muted)",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "var(--muted)",
  },
  "&.cm-editor .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--accent)",
  },
  ".cm-lintRange-error": {
    textDecoration: "underline wavy var(--destructive)",
  },
});

/**
 * Agent 的 mcp.json 编辑区：受控 CodeMirror（JSON 语言高亮 + 行号 + 实时
 * lint 标注）+ 格式化按钮 + 自带保存按钮——MCP tab 自管保存（不再随基本信息
 * 一起走 footer 提交），JSON 语法校验失败就地内联报错。
 */
export function McpEditor({
  value,
  onChange,
  error,
  loading,
  loadFailed,
  dirty,
  saving,
  onSave,
}: McpEditorProps) {
  const t = useTranslations("agent.editor");
  // 格式化失败的内联提示，与外部 error（保存时后端校验失败）共用同一展示位，
  // 但独立状态——格式化失败不应该覆盖/清空上一次保存报错，两者在同一渲染帧
  // 只展示一个（优先展示格式化失败，因为它是用户刚触发的动作反馈）。
  const [formatError, setFormatError] = useState<string | null>(null);

  // 用户继续编辑即视为对上一次格式化失败提示的确认——清掉，避免残留误导。
  const handleChange = (next: string) => {
    onChange(next);
    setFormatError(null);
  };

  const handleFormat = () => {
    try {
      const parsed = JSON.parse(value);
      onChange(JSON.stringify(parsed, null, 2));
      setFormatError(null);
    } catch (err) {
      setFormatError(
        t("mcpJsonInvalid", {
          detail: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <span className="text-[13px] font-medium text-foreground/85">
          {t("mcpTitle")}
        </span>
        <span className="text-xs text-muted-foreground">
          {t("mcpDescription")}
        </span>
      </div>

      {loading ? (
        <div className="flex h-32 items-center justify-center text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      ) : loadFailed ? (
        <Alert variant="destructive">
          <AlertDescription>{t("mcpLoadFailed")}</AlertDescription>
        </Alert>
      ) : (
        <>
          <div className="flex shrink-0 justify-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleFormat}
            >
              {t("mcpFormat")}
            </Button>
          </div>
          {/* min-h 沿用旧 Textarea 的 min-h-48（12rem）；超出 maxHeight 后编辑器
              内部自行滚动，外层面板（agent-editor-sheet 的 overflow-y-auto 容器）
              继续兜住整体溢出，双层滚动互不冲突。 */}
          <div className="overflow-hidden rounded-md border border-border">
            <CodeMirror
              value={value}
              onChange={handleChange}
              minHeight="192px"
              maxHeight="420px"
              placeholder={t("mcpPlaceholder")}
              theme={mcpEditorTheme}
              extensions={[
                json(),
                linter(jsonParseLinter()),
                lintGutter(),
                EditorView.lineWrapping,
              ]}
              basicSetup={{
                lineNumbers: true,
                foldGutter: true,
                highlightActiveLine: true,
              }}
            />
          </div>
          {(formatError || error) && (
            <Alert variant="destructive">
              <AlertDescription>{formatError ?? error}</AlertDescription>
            </Alert>
          )}
          <div className="flex shrink-0 justify-end">
            <Button type="button" onClick={onSave} disabled={!dirty || saving}>
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {saving ? t("mcpSaving") : t("mcpSave")}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
