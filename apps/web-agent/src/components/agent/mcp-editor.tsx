"use client";

import { Alert, AlertDescription, Button, Textarea } from "@meshbot/design";
import axios from "axios";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { getAgentMcp, putAgentMcp } from "@/rest/agents";

interface McpEditorProps {
  /** 目标 Agent id（编辑态必有；新建态尚无 id，父组件应不渲染本组件）。 */
  agentId: string;
}

/**
 * Agent 的 mcp.json 编辑区：受控 Textarea + 保存前本地 JSON.parse 校验 +
 * 后端 McpConfigSchema 二次校验（400 时把后端 message 原样显示）。
 *
 * 不做语法高亮/Monaco——现阶段体量小，纯文本编辑区足够，真需要再升级。
 * 保存成功后不主动关闭抽屉（与 Agent 身份表单的保存是两个独立动作），只提示
 * 「已保存」，方便用户连续调整。
 */
export function McpEditor({ agentId }: McpEditorProps) {
  const t = useTranslations("agent.editor");
  const [raw, setRaw] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // agentId 变化（切换到别的 Agent 编辑）时重新拉取该 Agent 的 mcp.json，
  // 不复用上一个 Agent 的编辑态——同本任务其它「按 agentId 隔离」的坑一致。
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadFailed(false);
    setError(null);
    setSaved(false);
    getAgentMcp(agentId)
      .then((res) => {
        if (cancelled) return;
        setRaw(res.raw);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  async function handleSave() {
    setError(null);
    setSaved(false);
    // 本地先校验一次 JSON 语法：能在发请求前就给出反馈，避免无谓的网络往返。
    // 结构（mcpServers 形状）交给后端 McpConfigSchema 二次校验——不在前端
    // 重复维护一份 schema。
    try {
      JSON.parse(raw);
    } catch (err) {
      setError(
        t("mcpJsonInvalid", {
          detail: err instanceof Error ? err.message : String(err),
        }),
      );
      return;
    }
    setSaving(true);
    try {
      await putAgentMcp(agentId, { raw });
      setSaved(true);
    } catch (err) {
      const backendMessage =
        axios.isAxiosError(err) &&
        err.response?.data &&
        typeof err.response.data === "object" &&
        "message" in err.response.data &&
        typeof (err.response.data as { message?: unknown }).message === "string"
          ? (err.response.data as { message: string }).message
          : undefined;
      setError(backendMessage || t("mcpSaveFailed"));
    } finally {
      setSaving(false);
    }
  }

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
            value={raw}
            onChange={(e) => {
              setRaw(e.target.value);
              setSaved(false);
            }}
            rows={12}
            className="min-h-48 resize-y font-mono text-[12.5px] leading-relaxed"
            placeholder={t("mcpPlaceholder")}
          />
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {saved && !error && (
            <span className="text-xs text-green-600 dark:text-green-400">
              {t("mcpSaveSuccess")}
            </span>
          )}
          <div className="flex justify-end">
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={() => void handleSave()}
            >
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {saving ? t("mcpSaving") : t("mcpSave")}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
