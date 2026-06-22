"use client";

import type { InstalledSkill, MarketSkillSummary } from "@meshbot/types-agent";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppShellLayout } from "@/components/layouts/app-shell-layout";
import { InstallFromGithub } from "@/components/skills/install-from-github";
import { InstalledSkillCard } from "@/components/skills/installed-skill-card";
import { MarketSkillCard } from "@/components/skills/market-skill-card";
import { PublishSkillDialog } from "@/components/skills/publish-skill-dialog";
import {
  SkillsSidebar,
  type SkillsView,
} from "@/components/skills/skills-sidebar";
import { fetchInstalled, fetchMarket } from "@/rest/skills";

export default function SkillsPage() {
  const t = useTranslations("skills");
  const [installed, setInstalled] = useState<InstalledSkill[]>([]);
  const [loadingInstalled, setLoadingInstalled] = useState(true);
  const [activeView, setActiveView] = useState<SkillsView>("installed");

  // publish dialog 状态
  const [publishTarget, setPublishTarget] = useState<InstalledSkill | null>(
    null,
  );
  const [publishOpen, setPublishOpen] = useState(false);

  // 市场搜索状态
  const [query, setQuery] = useState("");
  const [marketItems, setMarketItems] = useState<MarketSkillSummary[]>([]);
  const [loadingMarket, setLoadingMarket] = useState(false);
  const [marketError, setMarketError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reloadInstalled = useCallback(async () => {
    setLoadingInstalled(true);
    try {
      const list = await fetchInstalled();
      setInstalled(list);
    } finally {
      setLoadingInstalled(false);
    }
  }, []);

  useEffect(() => {
    void reloadInstalled();
  }, [reloadInstalled]);

  // 切换到市场视图时拉取列表
  const loadMarket = useCallback(
    async (source: "ourMarket" | "clawhub", q: string) => {
      setLoadingMarket(true);
      setMarketError(null);
      try {
        const items = await fetchMarket(source, q || undefined);
        setMarketItems(items);
      } catch {
        setMarketError(t("marketLoadFailed"));
        setMarketItems([]);
      } finally {
        setLoadingMarket(false);
      }
    },
    [t],
  );

  // 视图切换时重置搜索 + 拉取市场数据
  useEffect(() => {
    setQuery("");
    setMarketItems([]);
    setMarketError(null);
    if (activeView === "ourMarket" || activeView === "clawhub") {
      void loadMarket(activeView, "");
    }
  }, [activeView, loadMarket]);

  // 搜索防抖
  function handleQueryChange(q: string) {
    setQuery(q);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (activeView !== "ourMarket" && activeView !== "clawhub") return;
    debounceRef.current = setTimeout(() => {
      void loadMarket(activeView, q);
    }, 350);
  }

  function handlePublish(skill: InstalledSkill) {
    setPublishTarget(skill);
    setPublishOpen(true);
  }

  function handleUninstalled() {
    void reloadInstalled();
  }

  function handleInstalled() {
    void reloadInstalled();
  }

  const isMarketView = activeView === "ourMarket" || activeView === "clawhub";

  return (
    <AppShellLayout
      sidebar={
        <SkillsSidebar
          installed={installed}
          activeView={activeView}
          onSelect={setActiveView}
        />
      }
    >
      <div className="mx-auto w-full max-w-2xl">
        {/* ── 已安装视图 ── */}
        {activeView === "installed" && (
          <>
            <h1 className="mb-4 text-lg font-medium">{t("installedTitle")}</h1>

            {loadingInstalled ? (
              <p className="text-sm text-muted-foreground">{t("loading")}</p>
            ) : installed.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("installedEmpty")}
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {installed.map((skill) => (
                  <InstalledSkillCard
                    key={skill.name}
                    skill={skill}
                    onUninstalled={handleUninstalled}
                    onPublish={handlePublish}
                  />
                ))}
              </div>
            )}
          </>
        )}

        {/* ── 市场视图（ourMarket / clawhub）── */}
        {isMarketView && (
          <>
            <h1 className="mb-3 text-lg font-medium">
              {activeView === "ourMarket"
                ? t("sourceOurMarket")
                : t("sourceClawhub")}
            </h1>

            {/* clawhub 提示横幅 */}
            {activeView === "clawhub" && (
              <div className="mb-3 rounded-md border border-amber-300/40 bg-amber-50/60 px-3 py-2 text-[12px] text-amber-700 dark:bg-amber-900/20 dark:text-amber-400">
                {t("clawhubInstallUnsupported")}
              </div>
            )}

            {/* 搜索框 */}
            <input
              type="text"
              value={query}
              onChange={(e) => handleQueryChange(e.target.value)}
              placeholder={t("marketSearchPlaceholder")}
              className="mb-4 w-full rounded-md border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />

            {loadingMarket ? (
              <p className="text-sm text-muted-foreground">{t("loading")}</p>
            ) : marketError ? (
              <p className="text-sm text-destructive">{marketError}</p>
            ) : marketItems.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("marketEmpty")}
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {marketItems.map((skill) => (
                  <MarketSkillCard
                    key={`${skill.source}:${skill.slug}`}
                    skill={skill}
                    source={activeView}
                    onInstalled={handleInstalled}
                    disabled={activeView === "clawhub"}
                  />
                ))}
              </div>
            )}
          </>
        )}

        {/* ── GitHub 安装视图 ── */}
        {activeView === "github" && (
          <InstallFromGithub onInstalled={handleInstalled} />
        )}
      </div>

      {/* 上传到市场对话框 */}
      <PublishSkillDialog
        skill={publishTarget}
        open={publishOpen}
        onOpenChange={setPublishOpen}
        onPublished={() => void reloadInstalled()}
      />
    </AppShellLayout>
  );
}
