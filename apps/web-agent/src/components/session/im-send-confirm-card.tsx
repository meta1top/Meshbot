"use client";

import { useAtomValue } from "jotai";
import { Check, Loader2, Send, X } from "lucide-react";
import { useState } from "react";
import { conversationsAtom } from "@/atoms/im";
import { useRemoteSession } from "@/hooks/remote-session-context";
import { confirmSend } from "@/rest/session";
import type { ToolCallView } from "./message-list";

/** im_send_message 的可编辑确认卡：预填草稿，用户改后点发送 / 取消。 */
export function ImSendConfirmCard({
  tool,
  sessionId,
}: {
  tool: ToolCallView;
  sessionId: string;
}) {
  const args = (tool.args ?? {}) as {
    conversationId?: string;
    content?: string;
  };
  const conversations = useAtomValue(conversationsAtom);
  const target = conversations.find((c) => c.id === args.conversationId);
  const targetName =
    target?.name ?? target?.peer?.displayName ?? args.conversationId ?? "会话";
  const [text, setText] = useState(args.content ?? "");
  const [busy, setBusy] = useState(false);
  const remote = useRemoteSession();

  const pending = tool.status === "running";
  const result = parseStatus(tool.result);

  const act = async (decision: "send" | "cancel") => {
    setBusy(true);
    try {
      if (remote) {
        await remote.confirm(tool.toolCallId, decision, text);
      } else {
        await confirmSend(sessionId, tool.toolCallId, decision, text);
      }
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
      {terminalLabel(result)} · {targetName}
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
