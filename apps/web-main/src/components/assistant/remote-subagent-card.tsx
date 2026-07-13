"use client";

import { cn } from "@meshbot/design";
import type { ArtifactPreviewTarget } from "@meshbot/web-common/session";
import {
  countToolCalls,
  createSessionSocketAdapter,
  deriveLiveAction,
  firstLineOf,
  formatElapsed,
  isBackgroundDispatch,
  isSubagentOpen,
  resolveSubagentStatus,
  resolveSubSessionId,
  resolveUnclaimedStatus,
  type SubagentCollapse,
  subagentTitle,
  type ToolCallView,
  toggleSubagentOpen,
  toolDisplayName,
  useSessionStream,
} from "@meshbot/web-common/session";
import { Check, ChevronDown, Square, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRemoteSessionTransport } from "@/lib/session-transport";
import { RemoteMessageList } from "./remote-message-list";

/** 状态胶囊的样式与文案键（语义色不抢主 accent，运行中带呼吸点）。 */
const CHIP_STYLES: Record<string, string> = {
  starting: "text-muted-foreground bg-muted",
  running: "text-primary bg-primary/10",
  done: "text-emerald-700 dark:text-emerald-400 bg-emerald-600/10 dark:bg-emerald-400/10",
  error: "text-destructive bg-destructive/10",
  aborted: "text-muted-foreground bg-muted",
};
/** 专属图标底色按终态换语义色（主信号仍是胶囊）。 */
const GLYPH_STYLES: Record<string, string> = {
  starting: "bg-primary/50",
  running: "bg-primary",
  done: "bg-emerald-600 dark:bg-emerald-500",
  error: "bg-destructive",
  aborted: "bg-muted-foreground/60",
};

/** 子 Agent 专属图标：嵌套方块（外框 + 内实心），与普通工具块区分身份。 */
function SubagentGlyph({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "grid h-[22px] w-[22px] shrink-0 place-items-center rounded-[6px]",
        GLYPH_STYLES[status] ?? "bg-primary",
      )}
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 12 12"
        fill="none"
        aria-hidden="true"
      >
        <rect
          x="1"
          y="1"
          width="10"
          height="10"
          rx="2"
          stroke="#fff"
          strokeWidth="1.5"
        />
        <rect x="4.5" y="4.5" width="5" height="5" rx="1" fill="#fff" />
      </svg>
    </span>
  );
}

interface RemoteSubagentCardProps {
  tool: ToolCallView;
  /** 子会话与父会话同一远程设备。 */
  deviceId: string;
  onPreviewArtifact: (target: ArtifactPreviewTarget) => void;
}

/**
 * dispatch_subagent「Agent 任务卡」（web-main 远程版）。移植自
 * `apps/web-agent/src/components/session/subagent-card.tsx`：认领/停止/
 * settled 纯逻辑与视觉逐一对齐，数据源改为固定走远程 transport
 * （web-main 只有远程会话，无需 `useRemoteSession()` context 判分支——
 * `deviceId` 直接由父组件通过 `renderSubagentCard` 闭包传入）。
 *
 * 每张卡片各自 `useMemo` 一份独立 transport 实例（同 web-agent 惯例）：
 * 子会话与父会话共享同一条 `ws/im` 单例 socket，但各自的
 * `RemoteRunTracker`/`DeviceQueryClient` 按 streamId 隔离，互不干扰
 * （见 T10 报告"流归属过滤"设计）。
 */
export function RemoteSubagentCard({
  tool,
  deviceId,
  onPreviewArtifact,
}: RemoteSubagentCardProps) {
  const t = useTranslations("session.subagent");
  const subSessionId = resolveSubSessionId(tool);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  const transport = useMemo(
    () => createRemoteSessionTransport(deviceId),
    [deviceId],
  );
  const socketAdapter = useMemo(
    () => createSessionSocketAdapter(transport),
    [transport],
  );
  const getSocket = useCallback(() => socketAdapter, [socketAdapter]);
  const sub = useSessionStream(
    subSessionId,
    scrollRef,
    transport,
    getSocket,
    {},
    deviceId,
  );
  const [collapse, setCollapse] = useState<SubagentCollapse>({
    mode: "manual",
    open: false,
  });
  const childRunning = sub.running || tool.status === "running";
  const open = isSubagentOpen(collapse, childRunning);
  const status =
    subSessionId === null
      ? (resolveUnclaimedStatus(tool) ?? "starting")
      : resolveSubagentStatus(tool, sub.running);
  const active = status === "running" || status === "starting";
  const title = subagentTitle(tool.args) || t("fallbackTitle");
  const background = isBackgroundDispatch(tool.args);
  const toolCount = countToolCalls(sub.messages);

  // 本地耗时：首次观察到 running 起算，离开 running 冻结；每秒强制重渲染刷新读数。
  const startedAtRef = useRef<number | null>(null);
  const frozenRef = useRef<number | null>(null);
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (status === "running" && startedAtRef.current === null) {
      startedAtRef.current = Date.now();
    }
    if (
      status !== "running" &&
      status !== "starting" &&
      startedAtRef.current !== null &&
      frozenRef.current === null
    ) {
      frozenRef.current = Date.now() - startedAtRef.current;
    }
    if (status !== "running") return;
    const id = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [status]);
  const elapsedMs =
    frozenRef.current ??
    (startedAtRef.current !== null ? Date.now() - startedAtRef.current : null);

  // 子流有新内容且用户停在底部时吸底跟随。
  // biome-ignore lint/correctness/useExhaustiveDependencies: messages 是「内容变化触发器」，内容增长时吸底
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [sub.messages]);

  // 折叠态第二行：运行中=当前动作；终态=结果一句话。
  const liveAction =
    !open && status === "running" ? deriveLiveAction(sub.messages) : null;
  const resultLine = (() => {
    if (open || active) return null;
    if (status === "aborted") return t("abortedResult");
    if (status === "error") {
      const parsed = parseOutput(tool.result);
      return parsed ? firstLineOf(parsed) : t("errorResult");
    }
    const parsed = parseOutput(tool.result);
    return parsed ? firstLineOf(parsed) : null;
  })();

  return (
    <div
      className={cn(
        "flex w-full flex-col overflow-hidden rounded-[8px] border",
        status === "running" ? "border-primary/30" : "border-border",
      )}
    >
      <div
        className={cn(
          "flex w-full items-center",
          status === "running"
            ? "bg-gradient-to-r from-primary/10 to-muted/40"
            : "bg-muted/40",
        )}
      >
        <button
          type="button"
          onClick={() =>
            setCollapse((s) => toggleSubagentOpen(s, childRunning))
          }
          className="group flex min-w-0 flex-1 items-center gap-2 px-2.5 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground"
          aria-expanded={open}
          disabled={subSessionId === null}
        >
          <SubagentGlyph status={status} />
          <span className="min-w-0 truncate text-[13px] font-semibold text-foreground">
            {title}
          </span>
          {background && (
            <span className="shrink-0 rounded-full border border-border px-2 py-px text-[11px]">
              {t("backgroundTag")}
            </span>
          )}
          <span
            className={cn(
              "flex shrink-0 items-center gap-1.5 rounded-full px-2 py-px text-[11px] font-medium",
              CHIP_STYLES[status],
            )}
          >
            {active && (
              <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse motion-reduce:animate-none" />
            )}
            {status === "done" && <Check className="h-3 w-3" />}
            {status === "error" && <X className="h-3 w-3" />}
            {t(status)}
          </span>
          {(toolCount > 0 || elapsedMs !== null) && (
            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/60">
              {toolCount > 0 && t("toolsCount", { count: toolCount })}
              {toolCount > 0 && elapsedMs !== null && " · "}
              {elapsedMs !== null && formatElapsed(elapsedMs)}
            </span>
          )}
          <ChevronDown
            className={cn(
              "ml-auto h-3 w-3 shrink-0 transition-transform",
              !open && "-rotate-90",
            )}
          />
        </button>
        {active && subSessionId && (
          <button
            type="button"
            onClick={() => sub.interrupt()}
            title={t("stop")}
            className="shrink-0 px-2 py-1.5 text-muted-foreground hover:text-destructive"
          >
            <Square className="h-3 w-3" />
          </button>
        )}
      </div>
      {liveAction && (
        <div className="flex items-center gap-2 overflow-hidden border-t border-dashed border-border py-1.5 pl-10 pr-3 text-xs text-muted-foreground">
          <span className="h-2.5 w-2.5 shrink-0 animate-spin rounded-full border-[1.5px] border-muted-foreground/40 border-t-primary motion-reduce:animate-none" />
          {liveAction.kind === "tool" ? (
            <>
              <span className="shrink-0">{t("runningAction")}</span>
              <span className="truncate font-mono text-[11px]">
                {toolDisplayName(liveAction.name)}
                {liveAction.argsSummary && `（${liveAction.argsSummary}）`}
              </span>
            </>
          ) : (
            <span className="truncate">{liveAction.text}</span>
          )}
        </div>
      )}
      {resultLine && (
        <div className="flex gap-2 border-t border-dashed border-border py-1.5 pl-10 pr-3 text-xs text-muted-foreground">
          <span
            className={cn(
              "shrink-0",
              status === "done" && "text-emerald-700 dark:text-emerald-400",
              status === "error" && "text-destructive",
            )}
          >
            →
          </span>
          <span className="truncate">{resultLine}</span>
        </div>
      )}
      {open && subSessionId && (
        <>
          <div
            ref={scrollRef}
            onScroll={() => {
              const el = scrollRef.current;
              if (el) {
                stickRef.current =
                  el.scrollHeight - el.scrollTop - el.clientHeight <= 24;
              }
            }}
            className="max-h-96 overflow-y-auto border-t border-border bg-muted/20 px-3 py-2"
          >
            <RemoteMessageList
              messages={sub.messages}
              sessionId={subSessionId}
              running={sub.running}
              onConfirm={sub.confirm}
              onAnswer={sub.answer}
              deviceId={deviceId}
              onPreviewArtifact={onPreviewArtifact}
            />
          </div>
          <div className="flex items-center gap-2 border-t border-border px-3 py-1 text-[11px] tabular-nums text-muted-foreground/60">
            {status === "running"
              ? t("streamFooterRunning", { count: sub.messages.length })
              : `${t("streamFooterDone", { count: sub.messages.length })}${
                  elapsedMs !== null
                    ? ` · ${t("elapsed", { elapsed: formatElapsed(elapsedMs) })}`
                    : ""
                }`}
          </div>
        </>
      )}
    </div>
  );
}

/** 解析工具结果 JSON 的 output 字段；非 JSON/缺失返回 null。 */
function parseOutput(result: string | undefined): string | null {
  if (!result) return null;
  try {
    const parsed = JSON.parse(result) as { output?: unknown };
    return typeof parsed.output === "string" && parsed.output
      ? parsed.output
      : null;
  } catch {
    return null;
  }
}
