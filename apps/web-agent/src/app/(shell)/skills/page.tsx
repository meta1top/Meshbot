"use client";

import type { InstalledSkill, MarketSkillSummary } from "@meshbot/types-agent";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { ToolPage } from "@/components/layouts/tool-page";
import { InstalledSkillCard } from "@/components/skills/installed-skill-card";
import { MarketSkillCard } from "@/components/skills/market-skill-card";
import { MarketSkillCardSkeleton } from "@/components/skills/market-skill-card-skeleton";
import { PublishSkillDialog } from "@/components/skills/publish-skill-dialog";
import {
  SkillsSidebar,
  type SkillsView,
} from "@/components/skills/skills-sidebar";
import { useAgents } from "@/rest/agents";
import { fetchInstalled, fetchMarket } from "@/rest/skills";

export default function SkillsPage() {
  const t = useTranslations("skills");
  const { data: agents } = useAgents();
  // 主从视图（R1）：选中 Agent 是页面本地状态，不读全局「当前 Agent」atom——
  // 「在看谁的技能」只对本页面有意义，不该影响起手台/侧栏等其他消费方的全局
  // 当前态。已安装列表 / 安装 / 卸载 / 发布全部按此隔离，切换后必须重新拉取，
  // 否则会看到上一个 Agent 的技能列表（同 usage atom 全局单例串台的坑）。
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

  // 首次拿到 Agent 列表时默认选中第一个；已手动选过的不覆盖。
  useEffect(() => {
    if (!selectedAgentId && agents && agents.length > 0) {
      setSelectedAgentId(agents[0].id);
    }
  }, [agents, selectedAgentId]);

  const selectedAgentName = agents?.find(
    (agent) => agent.id === selectedAgentId,
  )?.name;

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
  const [marketLoadFailed, setMarketLoadFailed] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 请求时序守卫：只认最新一次 loadMarket 的响应，丢弃迟到的旧响应。
  // 否则「浏览(慢~1.5s) 与 搜索」乱序返回会互相覆盖 → 结果闪烁 / 偶发被旧空响应清空。
  const reqIdRef = useRef(0);

  const reloadInstalled = useCallback(async () => {
    setLoadingInstalled(true);
    try {
      const list = await fetchInstalled(selectedAgentId ?? undefined);
      setInstalled(list);
    } finally {
      setLoadingInstalled(false);
    }
  }, [selectedAgentId]);

  // selectedAgentId 变化（切 Agent）时重新拉取——reloadInstalled 引用随之
  // 变化，effect 自动重跑；loadingInstalled 立即置 true 掩盖旧列表，避免
  // 切换瞬间闪出上一个 Agent 的技能。
  useEffect(() => {
    void reloadInstalled();
  }, [reloadInstalled]);

  // 市场列表拉取。useCallback 依赖恒为空（错误用布尔位、不引 t）→ 引用稳定，
  // 避免进入视图切换 effect 的依赖后因 t 重建而反复触发「清空+重拉」造成闪烁/空窗。
  // reqIdRef 守卫：仅最新一次请求的响应被采纳，迟到的旧响应丢弃。
  const loadMarket = useCallback(
    async (source: "system" | "clawhub", q: string) => {
      const myId = ++reqIdRef.current;
      setLoadingMarket(true);
      setMarketLoadFailed(false);
      try {
        const items = await fetchMarket(source, q || undefined);
        if (myId === reqIdRef.current) setMarketItems(items);
      } catch {
        if (myId === reqIdRef.current) {
          setMarketLoadFailed(true);
          setMarketItems([]);
        }
      } finally {
        if (myId === reqIdRef.current) setLoadingMarket(false);
      }
    },
    [],
  );

  // 视图切换时重置搜索 + 拉取市场数据
  useEffect(() => {
    setQuery("");
    setMarketItems([]);
    setMarketLoadFailed(false);
    if (activeView === "system" || activeView === "clawhub") {
      void loadMarket(activeView, "");
    }
  }, [activeView, loadMarket]);

  // 搜索防抖
  function handleQueryChange(q: string) {
    setQuery(q);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (activeView !== "system" && activeView !== "clawhub") return;
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

  const isMarketView = activeView === "system" || activeView === "clawhub";

  // 页头标题随当前视图（已安装 / MeshBot / ClawHub）；已安装视图下带上选中
  // Agent 的名字（「<name> 的技能」），让「在看谁的技能」可见——初版主从视图
  // 的体验缺口，这里顺手补上。
  const pageTitle =
    activeView === "installed"
      ? selectedAgentName
        ? t("installedTitleFor", { name: selectedAgentName })
        : t("installedTitle")
      : activeView === "system"
        ? t("sourceOurMarket")
        : t("sourceClawhub");

  return (
    <ToolPage
      title={pageTitle}
      sidebar={
        <SkillsSidebar
          agents={agents ?? []}
          selectedAgentId={selectedAgentId}
          onSelectAgent={setSelectedAgentId}
          activeView={activeView}
          onSelectView={setActiveView}
        />
      }
      tabs={
        isMarketView ? (
          <input
            type="text"
            value={query}
            onChange={(e) => handleQueryChange(e.target.value)}
            placeholder={t("marketSearchPlaceholder")}
            className="w-full max-w-sm rounded-md border border-border bg-background px-3 py-1.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
        ) : undefined
      }
    >
      {/* ── 已安装视图 ── */}
      {activeView === "installed" &&
        (loadingInstalled ? (
          <MarketSkillCardSkeleton />
        ) : installed.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("installedEmpty")}</p>
        ) : (
          <div className="flex flex-col gap-2">
            {installed.map((skill) => (
              <InstalledSkillCard
                key={skill.name}
                skill={skill}
                agentId={selectedAgentId ?? undefined}
                onUninstalled={handleUninstalled}
                onPublish={handlePublish}
              />
            ))}
          </div>
        ))}

      {/* ── 市场视图（system / clawhub）── */}
      {isMarketView &&
        (loadingMarket ? (
          <MarketSkillCardSkeleton />
        ) : marketLoadFailed ? (
          <p className="text-sm text-destructive">{t("marketLoadFailed")}</p>
        ) : marketItems.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("marketEmpty")}</p>
        ) : (
          <div className="flex flex-col gap-2">
            {marketItems.map((skill) => (
              <MarketSkillCard
                key={`${skill.source}:${skill.slug}`}
                skill={skill}
                source={activeView}
                agentId={selectedAgentId ?? undefined}
                onInstalled={handleInstalled}
              />
            ))}
          </div>
        ))}

      {/* 上传到市场对话框 */}
      <PublishSkillDialog
        skill={publishTarget}
        agentId={selectedAgentId ?? undefined}
        open={publishOpen}
        onOpenChange={setPublishOpen}
        onPublished={() => void reloadInstalled()}
      />
    </ToolPage>
  );
}
