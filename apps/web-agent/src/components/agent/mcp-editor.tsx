"use client";

import { Alert, AlertDescription, Button, Textarea } from "@meshbot/design";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";

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
 * Agent 的 mcp.json 编辑区：受控 Textarea + 自带保存按钮——MCP tab 自管保存
 * （不再随基本信息一起走 footer 提交），JSON 语法校验失败就地内联报错。
 *
 * 不做语法高亮/Monaco——现阶段体量小，纯文本编辑区足够，真需要再升级。
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
          <Textarea
            value={value}
            onChange={(e) => onChange(e.target.value)}
            rows={12}
            className="min-h-48 resize-y font-mono text-[12.5px] leading-relaxed"
            placeholder={t("mcpPlaceholder")}
          />
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
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
