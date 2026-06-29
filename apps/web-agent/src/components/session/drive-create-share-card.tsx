"use client";

import { Check, Link, Loader2, X } from "lucide-react";
import { useState } from "react";
import { confirmSend } from "@/rest/session";
import type { ToolCallView } from "./message-list";

/**
 * drive_create_share 的确认卡：pending 态显示待创建的分享参数（nodeId、过期天数、密码），
 * 用户点「确认创建」或「取消」后调 confirm 端点；终态展示已创建（含 url）/ 已取消。
 */
export function DriveCreateShareCard({
  tool,
  sessionId,
}: {
  tool: ToolCallView;
  sessionId: string;
}) {
  const args = (tool.args ?? {}) as {
    nodeId?: string;
    expiresInDays?: number | null;
    password?: string;
  };

  const nodeId = args.nodeId ?? "未知";
  const expireLabel =
    args.expiresInDays == null ? "永不过期" : `${args.expiresInDays} 天后过期`;
  const passwordLabel = args.password ? "带密码保护" : "无密码";

  const [busy, setBusy] = useState(false);
  const pending = tool.status === "running";
  const result = parseShareResult(tool.result);

  const act = async (decision: "send" | "cancel") => {
    setBusy(true);
    try {
      await confirmSend(sessionId, tool.toolCallId, decision);
    } catch {
      setBusy(false);
    }
  };

  if (!pending) {
    return (
      <div className="flex w-full items-center gap-2 rounded-[8px] border border-border bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
        <Check className="h-3 w-3 shrink-0" />
        <span>{terminalLabel(result?.status ?? null)}</span>
        {result?.url && (
          <a
            href={result.url}
            target="_blank"
            rel="noreferrer"
            className="ml-1 truncate text-primary underline-offset-2 hover:underline"
          >
            {result.url}
          </a>
        )}
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col gap-2 rounded-[8px] border border-border bg-muted/30 px-3 py-2">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Link className="h-3 w-3 shrink-0" />
        <span>
          为 <span className="font-medium text-foreground">{nodeId}</span>{" "}
          创建公开链接 · {expireLabel} · {passwordLabel}
        </span>
      </div>
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => act("cancel")}
          disabled={busy}
          className="flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted disabled:opacity-50"
        >
          <X className="h-3 w-3" /> 取消
        </button>
        <button
          type="button"
          onClick={() => act("send")}
          disabled={busy}
          className="flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {busy ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Link className="h-3 w-3" />
          )}{" "}
          确认创建
        </button>
      </div>
    </div>
  );
}

/** 把工具结果 JSON 解析出 status 与 url；解析失败返回 null。 */
function parseShareResult(
  result?: string,
): { status?: string; url?: string } | null {
  if (!result) return null;
  try {
    return JSON.parse(result) as { status?: string; url?: string };
  } catch {
    return null;
  }
}

function terminalLabel(status: string | null): string {
  switch (status) {
    case "shared":
      return "已创建公开链接";
    case "cancelled":
      return "已取消，未创建链接";
    case "timeout":
      return "确认超时，未创建链接";
    case "interrupted":
      return "已中断，未创建链接";
    default:
      return "已结束";
  }
}
