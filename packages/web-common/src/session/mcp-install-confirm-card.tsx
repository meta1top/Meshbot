import { Button } from "@meshbot/design";
import { Check, Loader2, Plug, X } from "lucide-react";
import { useState } from "react";
import type { ToolCallView } from "./timeline";

/** `mcp_install` 参数里 stdio 型 server：命中 `"command" in server`。 */
interface StdioServerArgs {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** `mcp_install` 参数里 http 型 server：无 `command` 字段，走 `url`。 */
interface HttpServerArgs {
  url: string;
  transport?: string;
  headers?: Record<string, string>;
}

interface McpInstallArgs {
  name?: string;
  server?: StdioServerArgs | HttpServerArgs;
}

export interface McpInstallConfirmCardProps {
  tool: ToolCallView;
  /**
   * 确认/取消安装。HITL 收敛点（Task 5 裁定）：本地/远程会话统一走
   * `useSessionStream().confirm`（内部已按 SessionTransport 路由），本组件
   * 不再感知 local/remote 分支、不直调 REST——与 im_send / drive_share 同款。
   */
  onConfirm: (
    toolCallId: string,
    decision: "send" | "cancel",
    content?: string,
  ) => Promise<void>;
  /**
   * 关卡已被其他端应答的提示文案（Task 17，`run.hitl_settled` 广播帧）——
   * `tool.hitlSettledBy` 非空、但真正的工具终态（`tool.result`）尚未到达时
   * 展示这一句，而不是让卡片继续停在可点击的确认表单上。
   */
  hitlSettledLabel: string;
}

/**
 * `mcp_install` 的确认卡：展示待安装的 MCP server 名/协议/连接信息，用户点
 * 「确认安装」或「拒绝」后调 confirm 通道（与 im_send_message 同款），终态
 * 展示已安装 / 已拒绝。
 *
 * 硬约束：stdio 的 `env` 与 http 的 `headers` 只展示 key、绝不展示 value——
 * 这两个字段常年装着 API key / token 等密钥，展示值等于把密钥打在聊天记录里。
 */
export function McpInstallConfirmCard({
  tool,
  onConfirm,
  hitlSettledLabel,
}: McpInstallConfirmCardProps) {
  const args = (tool.args ?? {}) as McpInstallArgs;
  const [busy, setBusy] = useState(false);

  // 已被别端应答但真正的工具终态还没到（result 未落地）：不再展示可点击的
  // 确认表单——避免用户对着一张早已失效的确认卡继续点击。
  const pending = tool.status === "running" && !tool.hitlSettledBy;
  const result = parseStatus(tool.result);

  const act = async (decision: "send" | "cancel") => {
    setBusy(true);
    try {
      await onConfirm(tool.toolCallId, decision);
    } catch {
      setBusy(false);
    }
  };

  if (pending) {
    const server = args.server;
    // server 缺失（`onToolEnd` 兜底建块拿不到 args 的场景，同 todo_write/
    // drive_share 的已知空壳问题）：只隐去详情块，按钮仍可用，不整段崩溃。
    const isStdio = !!server && "command" in server;
    return (
      <div className="flex w-full flex-col gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Plug className="h-3 w-3 shrink-0" />
          <span>
            安装 MCP 服务器{" "}
            <span className="font-medium text-foreground">
              {args.name ?? "未知"}
            </span>
            {"（"}
            {server ? (isStdio ? "stdio" : "http") : "未知协议"}
            {"）"}
          </span>
        </div>
        {server &&
          (isStdio ? (
            <StdioDetails server={server as StdioServerArgs} />
          ) : (
            <HttpDetails server={server as HttpServerArgs} />
          ))}
        <div className="flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => act("cancel")}
            disabled={busy}
          >
            <X className="h-3 w-3" /> 拒绝
          </Button>
          <Button
            type="button"
            variant="brand"
            size="sm"
            onClick={() => act("send")}
            disabled={busy}
          >
            {busy ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Check className="h-3 w-3" />
            )}{" "}
            确认安装
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex w-full items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
      <Check className="h-3 w-3" />
      {tool.hitlSettledBy && !result ? hitlSettledLabel : terminalLabel(result)}
      {args.name ? ` · ${args.name}` : ""}
    </div>
  );
}

function StdioDetails({ server }: { server: StdioServerArgs }) {
  const envKeys = Object.keys(server.env ?? {});
  return (
    <div className="flex flex-col gap-1 rounded-md bg-background/60 px-2 py-1.5 font-mono text-[11px] text-foreground">
      <div className="truncate">
        {[server.command, ...(server.args ?? [])].join(" ")}
      </div>
      {envKeys.length > 0 && (
        <div className="text-muted-foreground">env: {envKeys.join(", ")}</div>
      )}
    </div>
  );
}

function HttpDetails({ server }: { server: HttpServerArgs }) {
  const headerKeys = Object.keys(server.headers ?? {});
  return (
    <div className="flex flex-col gap-1 rounded-md bg-background/60 px-2 py-1.5 font-mono text-[11px] text-foreground">
      <div className="truncate">
        {server.url}（{server.transport ?? "streamable_http"}）
      </div>
      {headerKeys.length > 0 && (
        <div className="text-muted-foreground">
          headers: {headerKeys.join(", ")}
        </div>
      )}
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
    case "installed":
      return "已安装";
    case "cancelled":
      return "已拒绝";
    case "timeout":
      return "确认超时，未安装";
    case "interrupted":
      return "已中断，未安装";
    case "error":
      return "安装失败";
    default:
      return "已结束";
  }
}
