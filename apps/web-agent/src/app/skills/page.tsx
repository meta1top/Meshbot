"use client";

import type { InstalledSkill } from "@meshbot/types-agent";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { AppShellLayout } from "@/components/layouts/app-shell-layout";
import { InstalledSkillCard } from "@/components/skills/installed-skill-card";
import { PublishSkillDialog } from "@/components/skills/publish-skill-dialog";
import {
  SkillsSidebar,
  type SkillsView,
} from "@/components/skills/skills-sidebar";
import { fetchInstalled } from "@/rest/skills";

export default function SkillsPage() {
  const t = useTranslations("skills");
  const [installed, setInstalled] = useState<InstalledSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeView, setActiveView] = useState<SkillsView>("installed");

  // publish dialog 状态
  const [publishTarget, setPublishTarget] = useState<InstalledSkill | null>(
    null,
  );
  const [publishOpen, setPublishOpen] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const list = await fetchInstalled();
      setInstalled(list);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  function handlePublish(skill: InstalledSkill) {
    setPublishTarget(skill);
    setPublishOpen(true);
  }

  function handleUninstalled() {
    void reload();
  }

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
        {activeView === "installed" && (
          <>
            <h1 className="mb-4 text-lg font-medium">{t("installedTitle")}</h1>

            {loading ? (
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

        {activeView !== "installed" && (
          <div className="flex flex-col items-center justify-center py-16 text-sm text-muted-foreground">
            <p>{t("marketComingSoon")}</p>
          </div>
        )}
      </div>

      {/* 上传到市场对话框 */}
      <PublishSkillDialog
        skill={publishTarget}
        open={publishOpen}
        onOpenChange={setPublishOpen}
        onPublished={() => void reload()}
      />
    </AppShellLayout>
  );
}
