"use client";

import {
  Alert,
  AlertDescription,
  cn,
  Skeleton,
  Switch,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@meshbot/design";
import type { ToolPrefsGroupItem, ToolPrefsView } from "@meshbot/types-agent";
import { toolDisplayName } from "@meshbot/web-common/session";
import axios from "axios";
import { ChevronDown } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { getAgentTools, putAgentTools } from "@/rest/agents";

/**
 * 从错误对象里提取展示文案：优先取后端 400 响应体的 `message`，其次取
 * `Error.message`，都没有则用调用方给的兜底——与 `agent-editor-sheet.tsx`
 * 的同名逻辑一致（未共享抽取，两处都很短，各自保持独立组件自包含）。
 */
function extractErrorMessage(err: unknown, fallback: string): string {
  if (
    axios.isAxiosError(err) &&
    err.response?.data &&
    typeof err.response.data === "object" &&
    "message" in err.response.data &&
    typeof (err.response.data as { message?: unknown }).message === "string"
  ) {
    return (err.response.data as { message: string }).message;
  }
  return err instanceof Error ? err.message : fallback;
}

/** 组内非豁免工具的全启/全禁/混合三态判定。 */
function groupState(tools: ToolPrefsGroupItem[]): {
  nonProtected: ToolPrefsGroupItem[];
  /** 组级开关显示的「开」态：非豁免工具里只要有一个启用就算开，全禁才算关——
   *  Switch 只有二态图形，没有「混合」的第三态，这里把「混合」并入「开」显示
   *  （与全启视觉一致），因为组内仍有能力在生效。点击行为见下方 handleGroupToggle
   *  的注释：这个显示选择直接决定了点击语义。 */
  checked: boolean;
} {
  const nonProtected = tools.filter((tl) => !tl.protected);
  const allDisabled =
    nonProtected.length > 0 && nonProtected.every((tl) => tl.disabled);
  return { nonProtected, checked: !allDisabled };
}

interface ToolPrefsEditorProps {
  agentId: string;
}

/**
 * Agent 编辑抽屉「工具」tab：分组折叠列表（默认全展开）+ 单工具/组级开关，
 * 每次翻转即时 PUT 全量 `disabledTools`（不随外层 footer 走批量保存）。
 *
 * 竞态防护选「保存中整体禁用」这个最简单可靠的方案而非队列化：写请求本身是
 * 全量覆盖语义（PUT `disabledTools` 整个数组），队列化需要基于「上一个请求
 * 的响应」还是「本地最新态」重算下一次 payload 两难；保存中把所有 Switch
 * disabled，物理上不可能产生第二个在途请求，简单且没有竞态窗口。
 */
export function ToolPrefsEditor({ agentId }: ToolPrefsEditorProps) {
  const t = useTranslations("agent.editor");

  const [view, setView] = useState<ToolPrefsView | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // 折叠态：key 存在于 collapsed 集合里表示「已折叠」；默认全展开即空集合，
  // 不需要在拿到分组列表时预填。
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    setView(null);
    setLoadFailed(false);
    setSaveError(null);
    getAgentTools(agentId)
      .then((res) => {
        if (!cancelled) setView(res);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  const toggleCollapse = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  /**
   * 落地一次新的分组视图：先乐观更新本地态，再 PUT 全量 disabledTools；失败
   * 回滚到 PUT 之前的视图并内联报错（`saveError` 渲染在 tab 顶部）。
   */
  const persist = async (nextView: ToolPrefsView, prevView: ToolPrefsView) => {
    setView(nextView);
    setSaving(true);
    setSaveError(null);
    const disabledTools = nextView.groups.flatMap((g) =>
      g.tools.filter((tl) => tl.disabled).map((tl) => tl.name),
    );
    try {
      await putAgentTools(agentId, disabledTools);
    } catch (err) {
      setView(prevView);
      setSaveError(extractErrorMessage(err, t("toolsSaveFailed")));
    } finally {
      setSaving(false);
    }
  };

  const handleToolToggle = (
    groupKey: string,
    toolName: string,
    nextDisabled: boolean,
  ) => {
    if (!view || saving) return;
    const prevView = view;
    const nextView: ToolPrefsView = {
      groups: view.groups.map((g) =>
        g.key !== groupKey
          ? g
          : {
              ...g,
              tools: g.tools.map((tl) =>
                tl.name === toolName ? { ...tl, disabled: nextDisabled } : tl,
              ),
            },
      ),
    };
    void persist(nextView, prevView);
  };

  /**
   * 组级一键开关：Radix Switch 把「切换后的目标态」传给 onCheckedChange——
   * 当前 `checked`（见 {@link groupState}）为「开」（全启或混合）时，点击传入
   * `false`，语义是「关掉整组」；为「关」（全禁）时传入 `true`，语义是「开启
   * 整组」。混合态因此点击一次会整组禁用，不是整组启用——这是显示选择的直接
   * 推论（混合显示为开，开→关的点击方向）。豁免工具不参与，禁用态恒不变。
   */
  const handleGroupToggle = (groupKey: string, nextChecked: boolean) => {
    if (!view || saving) return;
    const prevView = view;
    const nextView: ToolPrefsView = {
      groups: view.groups.map((g) =>
        g.key !== groupKey
          ? g
          : {
              ...g,
              tools: g.tools.map((tl) =>
                tl.protected ? tl : { ...tl, disabled: !nextChecked },
              ),
            },
      ),
    };
    void persist(nextView, prevView);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
      <div className="flex flex-col gap-0.5">
        <span className="text-[13px] font-medium text-foreground/85">
          {t("toolsTitle")}
        </span>
        <span className="text-xs text-muted-foreground">
          {t("toolsDescription")}
        </span>
      </div>

      {saveError && (
        <Alert variant="destructive">
          <AlertDescription>{saveError}</AlertDescription>
        </Alert>
      )}

      {!view && !loadFailed && (
        <div className="flex flex-col gap-3">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="flex flex-col gap-2 rounded-lg border border-border p-3"
            >
              <Skeleton className="h-4 w-32 rounded-sm bg-(--shell-sidebar-fg)/8" />
              <Skeleton className="h-3.5 w-full rounded-sm bg-(--shell-sidebar-fg)/8" />
              <Skeleton className="h-3.5 w-full rounded-sm bg-(--shell-sidebar-fg)/8" />
            </div>
          ))}
        </div>
      )}

      {loadFailed && (
        <Alert variant="destructive">
          <AlertDescription>{t("toolsLoadFailed")}</AlertDescription>
        </Alert>
      )}

      {view && (
        <div className="flex flex-col gap-2">
          {view.groups.map((group) => {
            const { nonProtected, checked } = groupState(group.tools);
            const isCollapsed = collapsed.has(group.key);
            const enabledCount = group.tools.filter(
              (tl) => !tl.disabled,
            ).length;
            return (
              <div
                key={group.key}
                className="overflow-hidden rounded-lg border border-border"
              >
                <div className="flex items-center gap-2 bg-muted/40 px-3 py-2">
                  <button
                    type="button"
                    onClick={() => toggleCollapse(group.key)}
                    aria-expanded={!isCollapsed}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    <ChevronDown
                      className={cn(
                        "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
                        isCollapsed && "-rotate-90",
                      )}
                    />
                    <span className="truncate text-[13px] font-medium text-foreground">
                      {t(`toolGroups.${group.key}`)}
                    </span>
                    <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/70">
                      {enabledCount}/{group.tools.length}
                    </span>
                  </button>
                  <Switch
                    checked={checked}
                    disabled={saving || nonProtected.length === 0}
                    onCheckedChange={(next) =>
                      handleGroupToggle(group.key, next)
                    }
                    aria-label={t("toolsGroupToggleAria", {
                      group: t(`toolGroups.${group.key}`),
                    })}
                  />
                </div>

                {!isCollapsed && (
                  <div className="divide-y divide-border">
                    {group.tools.map((tool) => (
                      <div
                        key={tool.name}
                        className="flex items-center gap-2 px-3 py-2"
                      >
                        <div className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate text-[13px] text-foreground/90">
                            {toolDisplayName(tool.name)}
                          </span>
                          <span className="truncate font-mono text-[11px] text-muted-foreground">
                            {tool.name}
                          </span>
                        </div>
                        {tool.protected ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="inline-flex cursor-not-allowed">
                                <Switch
                                  checked
                                  disabled
                                  aria-label={toolDisplayName(tool.name)}
                                />
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>
                              {t("toolsProtectedTooltip")}
                            </TooltipContent>
                          </Tooltip>
                        ) : (
                          <Switch
                            checked={!tool.disabled}
                            disabled={saving}
                            onCheckedChange={(next) =>
                              handleToolToggle(group.key, tool.name, !next)
                            }
                            aria-label={toolDisplayName(tool.name)}
                          />
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
