import { Check, Loader2, Send, X } from "lucide-react";
import { useState } from "react";
import type { ToolCallView } from "./timeline";

export interface ImSendConfirmCardProps {
  tool: ToolCallView;
  /**
   * 会话目标展示名（IM 会话名 / 对端 displayName / conversationId 兜底
   * 「会话」）。已在调用方解析好——原实现里查 `conversationsAtom`（jotai）
   * 找目标会话，web-common 禁止依赖 app 级 atom，改由调用方传入结果。
   */
  targetName: string;
  /**
   * 确认/取消发送。HITL 收敛点（Task 5 裁定）：本地/远程会话统一走
   * `useSessionStream().confirm`（内部已按 SessionTransport 路由），本组件
   * 不再感知 local/remote 分支、不直调 REST。
   */
  onConfirm: (
    toolCallId: string,
    decision: "send" | "cancel",
    content?: string,
  ) => Promise<void>;
  /**
   * 关卡已被其他端应答的提示文案（Task 17，`run.hitl_settled` 广播帧）——
   * `tool.hitlSettledBy` 非空、但真正的工具终态（`tool.result`）尚未到达时
   * 展示这一句，而不是让卡片继续停在可编辑的待发送表单上。
   */
  hitlSettledLabel: string;
}

/** im_send_message 的可编辑确认卡：预填草稿，用户改后点发送 / 取消。 */
export function ImSendConfirmCard({
  tool,
  targetName,
  onConfirm,
  hitlSettledLabel,
}: ImSendConfirmCardProps) {
  const args = (tool.args ?? {}) as {
    conversationId?: string;
    content?: string;
  };
  const [text, setText] = useState(args.content ?? "");
  const [busy, setBusy] = useState(false);

  // 已被别端应答但真正的工具终态还没到（result 未落地）：不再展示可编辑
  // 表单——避免用户对着一张早已失效的确认卡继续编辑/点击。
  const pending = tool.status === "running" && !tool.hitlSettledBy;
  const result = parseStatus(tool.result);

  const act = async (decision: "send" | "cancel") => {
    setBusy(true);
    try {
      await onConfirm(tool.toolCallId, decision, text);
    } catch {
      setBusy(false);
    }
  };

  if (pending) {
    return (
      <div className="flex w-full flex-col gap-2 rounded-[8px] border border-border bg-muted/30 px-3 py-2">
        <div className="text-xs text-muted-foreground">
          发送给{" "}
          <span className="font-medium text-foreground">{targetName}</span>
          （发送前可编辑）
        </div>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={busy}
          rows={3}
          className="w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-primary disabled:opacity-50"
        />
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
            disabled={busy || !text.trim()}
            className="flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Send className="h-3 w-3" />
            )}{" "}
            发送
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex w-full items-center gap-2 rounded-[8px] border border-border bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
      <Check className="h-3 w-3" />
      {tool.hitlSettledBy && !result ? hitlSettledLabel : terminalLabel(result)}{" "}
      · {targetName}
    </div>
  );
}

/** 把工具结果 JSON 解析出 status；解析失败返回 null。 */
function parseStatus(result?: string): string | null {
  if (!result) return null;
  try {
    return (JSON.parse(result) as { status?: string }).status ?? null;
  } catch {
    return null;
  }
}

function terminalLabel(status: string | null): string {
  switch (status) {
    case "sent":
      return "已发送";
    case "cancelled":
      return "已取消";
    case "timeout":
      return "确认超时，未发送";
    case "interrupted":
      return "已中断，未发送";
    case "error":
      return "发送失败";
    default:
      return "已结束";
  }
}
