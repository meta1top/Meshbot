"use client";

import {
  Alert,
  AlertDescription,
  Button,
  cn,
  Input,
  Skeleton,
} from "@meshbot/design";
import type {
  InstalledSkill,
  MarketSkillSummary,
  SkillInstallSource,
} from "@meshbot/types-agent";
import { Check, Download, Loader2, Trash2 } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import {
  fetchInstalled,
  fetchMarket,
  installSkill,
  uninstallSkill,
} from "@/rest/skills";

/** 页面仅展示可搜索/可浏览的两个来源；GitHub 无搜索逻辑，与 /skills 页一致不单列。 */
type MarketSource = Exclude<SkillInstallSource, "github">;

interface SkillManagerProps {
  /** 当前编辑 Agent id：已装列表/安装/卸载均按此隔离，语义与 /skills 页 selectedAgentId 一致。 */
  agentId: string;
}

/** 市场结果卡的 React key / 安装中态标识：来源 + slug 唯一定位一个市场条目。 */
function marketItemKey(
  source: MarketSource,
  skill: MarketSkillSummary,
): string {
  return `${source}:${skill.slug}`;
}

/**
 * Agent 编辑抽屉「技能」tab：紧凑复刻 /skills 页的核心能力——已装列表（卸载走
 * ConfirmDialog）+ 简版市场（来源切换/防抖搜索/安装 + 已装标记），发布/详情等
 * 重功能不搬，深度操作导去 /skills 页。
 *
 * 与 `/skills` 页的 `installed-skill-card.tsx` / `market-skill-card.tsx` /
 * `market-skill-card-skeleton.tsx` 均不复用：抽屉容器窄，且这三个组件分别缺
 * 「ConfirmDialog 卸载确认」「已装标记」「暖色调 Skeleton」，这里按 brief 要求
 * 做紧凑变体，不改动原组件（/skills 页仍在用它们）。
 */
export function SkillManager({ agentId }: SkillManagerProps) {
  const t = useTranslations("agent.editor");
  const tSkills = useTranslations("skills");

  // 组件是否仍挂载：抽屉关闭时 UnifiedSheet 整体卸载（open=false 直接
  // return null），安装/卸载请求可能仍在途——响应回来前先查这个 ref，避免
  // 对已卸载组件 setState。
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const [installed, setInstalled] = useState<InstalledSkill[] | null>(null);
  const [installedLoadFailed, setInstalledLoadFailed] = useState(false);
  const [uninstallTarget, setUninstallTarget] = useState<InstalledSkill | null>(
    null,
  );
  const [uninstalling, setUninstalling] = useState(false);
  const [uninstallError, setUninstallError] = useState<string | null>(null);

  const [source, setSource] = useState<MarketSource>("system");
  const [query, setQuery] = useState("");
  const [marketItems, setMarketItems] = useState<MarketSkillSummary[]>([]);
  const [loadingMarket, setLoadingMarket] = useState(false);
  const [marketLoadFailed, setMarketLoadFailed] = useState(false);
  const [installingKey, setInstallingKey] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 请求时序守卫：同 /skills 页，只认最新一次 loadMarket 响应，丢弃迟到的旧响应
  // （浏览与搜索乱序返回会互相覆盖）。
  const reqIdRef = useRef(0);

  const reloadInstalled = useCallback(async () => {
    setInstalledLoadFailed(false);
    try {
      const list = await fetchInstalled(agentId);
      if (mountedRef.current) setInstalled(list);
    } catch {
      if (mountedRef.current) setInstalledLoadFailed(true);
    }
  }, [agentId]);

  // agentId 变化（切 Agent 重新打开抽屉）时重新拉取；置空掩盖旧列表避免闪烁。
  useEffect(() => {
    setInstalled(null);
    void reloadInstalled();
  }, [reloadInstalled]);

  const loadMarket = useCallback(
    async (nextSource: MarketSource, q: string) => {
      const myId = ++reqIdRef.current;
      setLoadingMarket(true);
      setMarketLoadFailed(false);
      try {
        const items = await fetchMarket(nextSource, q || undefined);
        if (mountedRef.current && myId === reqIdRef.current)
          setMarketItems(items);
      } catch {
        if (mountedRef.current && myId === reqIdRef.current) {
          setMarketLoadFailed(true);
          setMarketItems([]);
        }
      } finally {
        if (mountedRef.current && myId === reqIdRef.current)
          setLoadingMarket(false);
      }
    },
    [],
  );

  // 切换来源时重置搜索词并重新浏览。
  useEffect(() => {
    setQuery("");
    setMarketItems([]);
    setMarketLoadFailed(false);
    void loadMarket(source, "");
  }, [source, loadMarket]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  function handleQueryChange(q: string) {
    setQuery(q);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void loadMarket(source, q);
    }, 350);
  }

  async function handleConfirmUninstall() {
    if (!uninstallTarget) return;
    setUninstalling(true);
    setUninstallError(null);
    try {
      await uninstallSkill(uninstallTarget.name, agentId);
      if (!mountedRef.current) return;
      setUninstallTarget(null);
      await reloadInstalled();
    } catch {
      if (mountedRef.current) setUninstallError(t("skillUninstallFailed"));
    } finally {
      if (mountedRef.current) setUninstalling(false);
    }
  }

  async function handleInstall(skill: MarketSkillSummary) {
    if (installingKey) return;
    setInstallingKey(marketItemKey(source, skill));
    setInstallError(null);
    try {
      await installSkill({
        source,
        ref: skill.slug,
        version: skill.latestVersion,
        agentId,
      });
      if (!mountedRef.current) return;
      await reloadInstalled();
    } catch {
      if (mountedRef.current) setInstallError(tSkills("installFailed"));
    } finally {
      if (mountedRef.current) setInstallingKey(null);
    }
  }

  // 已装判定：按「来源 + ref」而非「来源 + name」匹配——安装落盘的目录名
  // （name）可能与市场标识（slug/ref）不同（如 tarball 顶层子目录名），而
  // 后端安装时把 `input.ref`（即市场卡片传入的 skill.slug）原样存进
  // InstalledSkill.ref，这是唯一可靠对应市场条目的字段。/skills 页本身没有
  // 「已装标记」这个功能可参照，这里是本 tab 独立引入的能力。
  const installedRefs = useMemo(() => {
    const refs = new Set<string>();
    for (const item of installed ?? []) {
      if (item.source === source && item.ref) refs.add(item.ref);
    }
    return refs;
  }, [installed, source]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4">
      {/* ── 已安装 ── */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-[13px] font-medium text-foreground/85">
            {t("skillInstalledTitle")}
          </span>
          <Link
            href="/skills"
            className="shrink-0 text-[12px] text-primary hover:underline"
          >
            {t("skillGoToPage")}
          </Link>
        </div>

        {uninstallError && (
          <Alert variant="destructive">
            <AlertDescription>{uninstallError}</AlertDescription>
          </Alert>
        )}

        {installed === null && !installedLoadFailed && (
          <div className="flex flex-col gap-2">
            {[0, 1].map((row) => (
              <div
                key={row}
                className="flex items-center gap-3 rounded-md border border-border p-3"
              >
                <div className="min-w-0 flex-1 space-y-1.5">
                  <Skeleton className="h-3.5 w-28 rounded-sm bg-(--shell-sidebar-fg)/8" />
                  <Skeleton className="h-3 w-2/5 rounded-sm bg-(--shell-sidebar-fg)/8" />
                </div>
                <Skeleton className="h-6 w-6 shrink-0 rounded-sm bg-(--shell-sidebar-fg)/8" />
              </div>
            ))}
          </div>
        )}

        {installedLoadFailed && (
          <Alert variant="destructive">
            <AlertDescription>{t("skillInstalledLoadFailed")}</AlertDescription>
          </Alert>
        )}

        {installed !== null &&
          !installedLoadFailed &&
          installed.length === 0 && (
            <p className="text-[13px] text-muted-foreground">
              {tSkills("installedEmpty")}
            </p>
          )}

        {installed !== null && installed.length > 0 && (
          <div className="flex flex-col gap-2">
            {installed.map((skill) => (
              <div
                key={skill.name}
                className="flex items-center gap-3 rounded-md border border-border bg-card px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium">
                    {skill.name}
                  </p>
                  {skill.description && (
                    <p className="truncate text-xs text-muted-foreground">
                      {skill.description}
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setUninstallTarget(skill)}
                  disabled={uninstalling}
                  title={tSkills("uninstall")}
                  className="shrink-0 rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="border-t border-border" />

      {/* ── 安装技能（简版市场） ── */}
      <div className="flex flex-col gap-2">
        <span className="text-[13px] font-medium text-foreground/85">
          {t("skillMarketTitle")}
        </span>

        <div className="flex items-center gap-2">
          <div className="inline-flex shrink-0 rounded-md border border-border p-0.5">
            {(["system", "clawhub"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSource(s)}
                className={cn(
                  "rounded-sm px-2.5 py-1 text-[12px] font-medium transition-colors",
                  source === s
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {s === "system"
                  ? tSkills("sourceOurMarket")
                  : tSkills("sourceClawhub")}
              </button>
            ))}
          </div>
          <Input
            value={query}
            onChange={(e) => handleQueryChange(e.target.value)}
            placeholder={tSkills("marketSearchPlaceholder")}
            className="h-8 flex-1 text-[13px]"
          />
        </div>

        {installError && (
          <Alert variant="destructive">
            <AlertDescription>{installError}</AlertDescription>
          </Alert>
        )}

        {loadingMarket && (
          <div className="flex flex-col gap-2">
            {[0, 1, 2].map((row) => (
              <div
                key={row}
                className="flex items-center gap-3 rounded-md border border-border p-3"
              >
                <div className="min-w-0 flex-1 space-y-1.5">
                  <Skeleton className="h-3.5 w-32 rounded-sm bg-(--shell-sidebar-fg)/8" />
                  <Skeleton className="h-3 w-3/5 rounded-sm bg-(--shell-sidebar-fg)/8" />
                </div>
                <Skeleton className="h-6 w-14 shrink-0 rounded-sm bg-(--shell-sidebar-fg)/8" />
              </div>
            ))}
          </div>
        )}

        {!loadingMarket && marketLoadFailed && (
          <Alert variant="destructive">
            <AlertDescription>{tSkills("marketLoadFailed")}</AlertDescription>
          </Alert>
        )}

        {!loadingMarket && !marketLoadFailed && marketItems.length === 0 && (
          <p className="text-[13px] text-muted-foreground">
            {tSkills("marketEmpty")}
          </p>
        )}

        {!loadingMarket && !marketLoadFailed && marketItems.length > 0 && (
          <div className="flex flex-col gap-2">
            {marketItems.map((skill) => {
              const key = marketItemKey(source, skill);
              const isInstalling = installingKey === key;
              const isInstalled = installedRefs.has(skill.slug);
              return (
                <div
                  key={key}
                  className="flex items-center gap-3 rounded-md border border-border bg-card px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium">
                      {skill.displayName}
                    </p>
                    {skill.description && (
                      <p className="truncate text-xs text-muted-foreground">
                        {skill.description}
                      </p>
                    )}
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => handleInstall(skill)}
                    disabled={installingKey !== null || isInstalled}
                    className="shrink-0"
                  >
                    {isInstalling ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : isInstalled ? (
                      <Check className="h-3.5 w-3.5" />
                    ) : (
                      <Download className="h-3.5 w-3.5" />
                    )}
                    {isInstalling
                      ? tSkills("installing")
                      : isInstalled
                        ? t("skillInstalledBadge")
                        : tSkills("install")}
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={uninstallTarget !== null}
        title={tSkills("uninstallConfirm")}
        description={
          uninstallTarget
            ? tSkills("uninstallConfirmDesc", { name: uninstallTarget.name })
            : undefined
        }
        confirmText={
          uninstalling ? tSkills("uninstalling") : tSkills("uninstallConfirm")
        }
        cancelText={tSkills("cancel")}
        loading={uninstalling}
        destructive
        onConfirm={() => void handleConfirmUninstall()}
        onCancel={() => {
          if (uninstalling) return;
          setUninstallTarget(null);
        }}
      />
    </div>
  );
}
