"use client";

import { Alert, AlertDescription, Textarea } from "@meshbot/design";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";

interface McpEditorProps {
  /** 当前 mcp.json 原始文本（受控）。 */
  value: string;
  /** 文本变化回调，由调用方负责落地到自己的 state（含脏判定 / 创建流程）。 */
  onChange: (value: string) => void;
  /** 内联校验错误（JSON 语法错误 / 后端结构校验失败）；由调用方在保存/创建前
   *  校验后传入，本组件不再自带保存按钮、不做提交时机的决策。 */
  error?: string | null;
  /** 加载中（编辑态首次拉取既有 mcp.json）。向导态新建没有加载过程。 */
  loading?: boolean;
  /** 加载失败。 */
  loadFailed?: boolean;
}

/**
 * Agent 的 mcp.json 编辑区：受控 Textarea，不再自带保存按钮——JSON 语法/结构
 * 校验与实际提交时机完全交给调用方（`AgentEditorSheet`）统一编排：真实编辑态
 * 随 footer「保存」与基本信息一起提交；新建向导态随最后一步「创建」提交。
 *
 * 不做语法高亮/Monaco——现阶段体量小，纯文本编辑区足够，真需要再升级。
 */
export function McpEditor({
  value,
  onChange,
  error,
  loading,
  loadFailed,
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
        </>
      )}
    </div>
  );
}
