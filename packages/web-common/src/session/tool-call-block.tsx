import { cn } from "@meshbot/design";
import type { TodoItem } from "@meshbot/types-agent";
import { ChevronDown, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  extractPartialString,
  parsePartialToolArgs,
} from "../utils/partial-tool-args";
import type { ArtifactPreviewTarget } from "./artifact-file-card";
import { ArtifactFileCard } from "./artifact-file-card";
import { AskQuestionCard } from "./ask-question-card";
import { DriveCreateShareCard } from "./drive-create-share-card";
import { DriveShareCard } from "./drive-share-card";
import { ImSendConfirmCard } from "./im-send-confirm-card";
import type { ToolCallView } from "./timeline";
import { TodoList } from "./todo-list";
import { sanitizeMeshbotPaths, toolDisplayName } from "./tool-display";

/** ArtifactFileCard / HITL 关卡广播的 i18n 文案，随 ToolCallBlock 一并透传。 */
export interface ToolCallBlockLabels {
  artifactPresentFailed: string;
  /**
   * 「已由其他端应答」（Task 17）：im_send_message / ask_question 卡片被
   * `run.hitl_settled` 标记为 settled、但真正的工具终态尚未到达时展示。
   */
  hitlSettledElsewhere: string;
}

export interface ToolCallBlockProps {
  tool: ToolCallView;
  /**
   * 确认/取消 im_send_message / drive 分享类 HITL。HITL 收敛点（Task 5 裁定，
   * Task 8 落地）：上游统一传入 `useSessionStream().confirm`（本地/远程分支
   * 已下沉到 SessionTransport 内部），本组件与卡片自身不再感知 local/remote。
   */
  onConfirm: (
    toolCallId: string,
    decision: "send" | "cancel",
    content?: string,
  ) => Promise<void>;
  /** 提交 ask_question 型 HITL 的回答，收敛点同 onConfirm。 */
  onAnswer: (
    toolCallId: string,
    answers: { selected: string[]; other?: string }[],
  ) => Promise<void>;
  /**
   * im_send_message 卡片的会话目标展示名解析：调用方按 conversationId 查本地
   * IM 会话列表（jotai atom，web-common 不能碰），返回展示名。
   */
  resolveImTargetName: (conversationId: string | undefined) => string;
  /** present_file 卡片点击预览：调用方负责实际打开（写 atom / 切面板等）。 */
  onPreviewArtifact: (target: ArtifactPreviewTarget) => void;
  /** 当前会话所在的远程设备信息（本地会话为 null/undefined），供产物预览用。 */
  artifactRemote?: { deviceId: string; sessionId: string } | null;
  labels: ToolCallBlockLabels;
  /**
   * dispatch_subagent 嵌套卡：整卡渲染委托给调用方（web-agent 侧
   * `SubagentCard`）。特殊处理原因：该卡内部消费 `useSessionStream` + 会话
   * transport 选择，并递归渲染 `MessageList`（尚未随本批迁入 web-common，
   * 属 Task 9 骨干批范围）——若强行把整卡下沉，要么在 web-common 里重新发明
   * 一份最小 useSessionStream 消费面（现阶段无场景需要），要么让 web-common
   * 反向依赖尚未迁移的 web-agent 组件（违反依赖方向）。渲染插槽是当前对
   * ToolCallBlock 抽包侵入最小、行为零变化的选择——纯展示子组件（图标/状态
   * 胶囊样式）本身也没有独立复用场景，留在 web-agent 一起权衡最简单。
   */
  renderSubagentCard: (tool: ToolCallView) => React.ReactNode;
}

/**
 * 单次 tool 调用的「时间线事件」式展示。
 *
 * 从 `apps/web-agent/src/components/session/tool-call-block.tsx` 迁入
 * （Task 8）。四个 HITL 特化卡（im_send_message/ask_question/drive_share/
 * drive_create_share）与 present_file/todo_write 走 props 化的纯展示；
 * dispatch_subagent 走 `renderSubagentCard` 插槽（见上方 JSDoc）。
 *
 * 设计：reasoning 用「左竖条」表示「连续的思考过程」，tool 用「圆点 + 缩进列表项」
 * 表示「离散的可观察事件」，两者视觉语言完全区分。
 *
 * - 左侧 6px 圆点（按状态着色）+ 等宽工具名 + 行内 args 摘要 + 状态徽章；
 * - 默认收起；点击整行展开请求 / 响应分区，向右缩进对齐圆点右侧；
 * - bash 等流式工具运行期间响应区显示 progress，结束后切到 result。
 *
 * 同一个块按 toolCallId 贯穿三态：streaming（LLM 仍在打字生成参数）→ running
 * （执行中）→ ok/error（完成）。streaming 阶段 args 未定稿，用 argsText 尽力部分
 * 解析出行内摘要 + write/edit/bash 的正文打字预览；不再先建独立预览块再清空。
 */
export function ToolCallBlock({
  tool,
  onConfirm,
  onAnswer,
  resolveImTargetName,
  onPreviewArtifact,
  artifactRemote,
  labels,
  renderSubagentCard,
}: ToolCallBlockProps) {
  const [open, setOpen] = useState(false);
  if (tool.name === "im_send_message" && tool.status !== "streaming") {
    const args = (tool.args ?? {}) as { conversationId?: string };
    const targetName = resolveImTargetName(args.conversationId);
    return (
      <ImSendConfirmCard
        tool={tool}
        targetName={targetName}
        onConfirm={onConfirm}
        hitlSettledLabel={labels.hitlSettledElsewhere}
      />
    );
  }
  if (tool.name === "ask_question" && tool.status !== "streaming") {
    return (
      <AskQuestionCard
        tool={tool}
        onAnswer={onAnswer}
        hitlSettledLabel={labels.hitlSettledElsewhere}
      />
    );
  }
  if (tool.name === "present_file" && tool.status !== "streaming") {
    return (
      <ArtifactFileCard
        tool={tool}
        labels={{ presentFailed: labels.artifactPresentFailed }}
        remote={artifactRemote}
        onPreview={onPreviewArtifact}
      />
    );
  }
  if (tool.name === "drive_share" && tool.status !== "streaming") {
    return <DriveShareCard tool={tool} onConfirm={onConfirm} />;
  }
  if (tool.name === "drive_create_share" && tool.status !== "streaming") {
    return <DriveCreateShareCard tool={tool} onConfirm={onConfirm} />;
  }
  // `tool.args !== undefined` 守卫：onToolEnd 的兜底建块路径（宿主消息/宿主块
  // 都不在时间线上，直接建终态块）拿不到 args——end 事件本身不带这个字段。
  // todo_write 卡片不像其余特化卡（im_send_message/ask_question/drive_*）那样
  // 有「pending/终态」两态分叉、终态分支不依赖 args——它无条件从 args 取 todos
  // 渲染，args 缺失时会画出一张看起来「清单已清空」的空卡，比通用 JSON 块更容易
  // 误导（这正是本轮真机验收报的「待办清单渲染不出来」症状之一）。这里退回通用
  // 渲染分支（能看到 status/结果文本），不新增专属空态文案。
  if (
    tool.name === "todo_write" &&
    tool.status !== "streaming" &&
    tool.args !== undefined
  ) {
    const todos = ((tool.args ?? {}) as { todos?: TodoItem[] }).todos ?? [];
    return (
      <div className="flex w-full flex-col gap-1.5 rounded-lg border border-border bg-muted/30 px-3 py-2">
        <div className="text-xs font-medium text-muted-foreground">
          待办清单
        </div>
        <TodoList todos={todos} />
      </div>
    );
  }
  if (tool.name === "dispatch_subagent" && tool.status !== "streaming") {
    return <>{renderSubagentCard(tool)}</>;
  }
  const streaming = tool.status === "streaming";
  // streaming 阶段权威 args 还没到，用累积的 argsText 尽力部分解析。
  const displayArgs =
    tool.args !== undefined
      ? tool.args
      : tool.argsText
        ? parsePartialToolArgs(tool.argsText)
        : undefined;
  const argsJson = sanitizeMeshbotPaths(formatJson(displayArgs));
  const argsSummary = sanitizeMeshbotPaths(formatArgsSummary(displayArgs));
  // 文件写入 / bash 等有「正文」的工具：流式阶段逐字预览正文（打字效果）。
  const streamBody = sanitizeMeshbotPaths(
    streaming
      ? extractPartialString(tool.argsText ?? "", "command") ||
          extractPartialString(tool.argsText ?? "", "content") ||
          extractPartialString(tool.argsText ?? "", "new_string")
      : "",
  );
  const output = sanitizeMeshbotPaths(tool.progress || tool.result || "");
  // 工具名友好化：内建工具映射中文名，MCP 工具保留 server/tool 两段。
  const { server, name: rawName } = parseToolName(tool.name);
  const displayName = server ? rawName : toolDisplayName(rawName);
  const dotColor =
    tool.status === "running" || streaming
      ? "bg-primary/70"
      : tool.status === "error"
        ? "bg-destructive"
        : "bg-muted-foreground/40";
  return (
    <div className="flex w-full flex-col rounded-lg border border-border overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="group flex w-full items-center gap-2 bg-muted/40 px-2.5 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground"
        aria-expanded={open}
      >
        <span
          className={cn(
            "inline-block h-2 w-2 shrink-0 rounded-full",
            dotColor,
            streaming && "animate-pulse",
          )}
        />
        <span className="flex shrink-0 items-center gap-1 whitespace-nowrap font-mono">
          {server && (
            <>
              <span className="text-muted-foreground">{server}</span>
              <span className="text-muted-foreground/50">/</span>
            </>
          )}
          <span className="text-foreground">{displayName}</span>
        </span>
        {argsSummary && (
          <span className="min-w-0 truncate font-mono text-muted-foreground/70">
            ({argsSummary})
          </span>
        )}
        <span className="flex items-center">
          {renderStatusBadge(tool.status)}
        </span>
        <ChevronDown
          className={cn(
            "ml-auto h-3 w-3 shrink-0 opacity-0 transition-all group-hover:opacity-60",
            !open && "-rotate-90",
            open && "opacity-60",
          )}
        />
      </button>
      {streamBody && <StreamBodyPre body={streamBody} />}
      {open && (
        <div className="flex flex-col gap-3 px-2.5 py-2">
          <ToolSection label="请求">
            <pre className="overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-foreground">
              {argsJson}
            </pre>
          </ToolSection>
          {(output || tool.status === "running") && (
            <ToolSection label="响应">
              {output ? (
                <pre
                  className={cn(
                    "max-h-64 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed",
                    tool.status === "error"
                      ? "text-destructive"
                      : "text-foreground",
                  )}
                >
                  {output}
                </pre>
              ) : (
                <span className="font-mono text-[11px] text-muted-foreground">
                  …
                </span>
              )}
            </ToolSection>
          )}
        </div>
      )}
    </div>
  );
}

/** 流式正文预览：内容增长时若用户停在底部就吸底跟随（同消息流逻辑）。 */
function StreamBodyPre({ body }: { body: string }) {
  const ref = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: body 是「内容变化触发器」，内容增长时吸底；effect 本身不直接读 body
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [body]);
  return (
    <pre
      ref={ref}
      onScroll={() => {
        const el = ref.current;
        if (el) {
          stick.current =
            el.scrollHeight - el.scrollTop - el.clientHeight <= 24;
        }
      }}
      className="max-h-64 overflow-auto whitespace-pre-wrap px-2.5 py-2 font-mono text-[11px] leading-relaxed text-foreground"
    >
      {body}
      <span className="animate-pulse">▋</span>
    </pre>
  );
}

function ToolSection({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      {children}
    </div>
  );
}

function renderStatusBadge(status: ToolCallView["status"]) {
  if (status === "running" || status === "streaming") {
    return <Loader2 className="h-3 w-3 animate-spin text-primary/70" />;
  }
  if (status === "ok") {
    return <span className="text-foreground/40">✓</span>;
  }
  return <span className="text-destructive">✗</span>;
}

/** 把 args 对象渲染成单行紧凑摘要 `key: "value", k2: 123`，超长截断。 */
function formatArgsSummary(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const entries = Object.entries(args as Record<string, unknown>);
  if (entries.length === 0) return "";
  const parts = entries.map(([k, v]) => {
    if (typeof v === "string") return `${k}: "${v}"`;
    if (v === null || ["number", "boolean"].includes(typeof v))
      return `${k}: ${v}`;
    return `${k}: …`;
  });
  const text = parts.join(", ");
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

/**
 * 把 `mcp__<server>__<tool>` 拆成 `{ server, name }`，方便分两段渲染；
 * 内建工具（无 `mcp__` 前缀）返 `{ server: null, name: tool.name }`。
 *
 * 用 non-greedy + 第一个 `__` 分割：server 取一段（如 `chrome-devtools`），
 * 余下整体视为 tool name（哪怕里面再含 `__` 也保留）。
 */
function parseToolName(raw: string): { server: string | null; name: string } {
  const m = raw.match(/^mcp__(.+?)__(.+)$/);
  if (!m) return { server: null, name: raw };
  return { server: m[1], name: m[2] };
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
