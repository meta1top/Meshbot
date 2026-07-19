import { Check, Loader2, Share2, X } from "lucide-react";
import { useState } from "react";
import type { ToolCallView } from "./timeline";

export interface DriveShareCardProps {
  tool: ToolCallView;
  /**
   * 确认/取消共享。HITL 收敛点（Task 5 裁定）：本地/远程会话统一走
   * `useSessionStream().confirm`（内部已按 SessionTransport 路由），本组件
   * 不再感知 local/remote 分支、不直调 REST。
   */
  onConfirm: (
    toolCallId: string,
    decision: "send" | "cancel",
    content?: string,
  ) => Promise<void>;
}

/**
 * drive_share 的确认卡：pending 态显示共享目标与权限，用户点「确认」或「取消」
 * 后调 confirm 端点（与 im_send_message 同款），终态展示已共享 / 已取消。
 */
export function DriveShareCard({ tool, onConfirm }: DriveShareCardProps) {
  const args = (tool.args ?? {}) as {
    nodeId?: string;
    shareWith?: string;
    permission?: string;
  };

  const shareWith = args.shareWith ?? "未知";
  const permission = args.permission === "editor" ? "编辑者" : "查看者";

  const [busy, setBusy] = useState(false);
  const pending = tool.status === "running";
  const result = parseStatus(tool.result);

  const act = async (decision: "send" | "cancel") => {
    setBusy(true);
    try {
      await onConfirm(tool.toolCallId, decision);
    } catch {
      setBusy(false);
    }
  };

  if (!pending) {
    return (
      <div className="flex w-full items-center gap-2 rounded-[8px] border border-border bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
        <Check className="h-3 w-3" />
        {terminalLabel(result)}
        {/* args 缺失时**整段省略**，不能靠 `shareWith`/`permission` 的默认值兜底：
            `permission` 默认成「查看者」会把实际授予「编辑者」的分享说成只读，
            属于「貌似正常、内容是错的」——比缺一段信息危险得多。args 会缺是因为
            `onToolEnd` 在宿主块不存在时按事件字段兜底建块，而 end 事件本身不带
            args（同 todo_write 的空壳问题，见 tool-call-block.tsx 的 args 守卫）。 */}
        {tool.args !== undefined ? (
          <>
            · 共享给 {shareWith}（{permission}）
          </>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col gap-2 rounded-[8px] border border-border bg-muted/30 px-3 py-2">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Share2 className="h-3 w-3 shrink-0" />
        <span>
          共享给{" "}
          <span className="font-medium text-foreground">{shareWith}</span>
          {" 为 "}
          <span className="font-medium text-foreground">{permission}</span>
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
            <Share2 className="h-3 w-3" />
          )}{" "}
          确认共享
        </button>
      </div>
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
    case "shared":
      return "已共享";
    case "cancelled":
      return "已取消";
    case "timeout":
      return "确认超时，未共享";
    case "interrupted":
      return "已中断，未共享";
    default:
      return "已结束";
  }
}
