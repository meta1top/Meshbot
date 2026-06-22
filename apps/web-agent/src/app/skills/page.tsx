"use client";

import type { InstalledSkill } from "@meshbot/types-agent";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { AppShellLayout } from "@/components/layouts/app-shell-layout";
import { fetchInstalled } from "@/rest/skills";

/** 技能页侧栏占位（Task 2 替换为真正的 SkillsSidebar）。 */
function SkillsSidebarPlaceholder() {
  const t = useTranslations("skills");
  return (
    <div className="flex h-full flex-col p-4">
      <p className="text-sm font-medium text-foreground/70">{t("title")}</p>
    </div>
  );
}

export default function SkillsPage() {
  const t = useTranslations("skills");
  const [installed, setInstalled] = useState<InstalledSkill[]>([]);
  const [loading, setLoading] = useState(true);

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

  return (
    <AppShellLayout sidebar={<SkillsSidebarPlaceholder />}>
      <div className="mx-auto w-full max-w-2xl">
        <h1 className="mb-4 text-lg font-medium">{t("title")}</h1>

        {loading ? (
          <p className="text-sm text-muted-foreground">{t("loading")}</p>
        ) : installed.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("installedEmpty")}</p>
        ) : (
          <div className="flex flex-col gap-2">
            {installed.map((skill) => (
              <div
                key={skill.name}
                className="rounded-md border border-border/60 bg-card px-4 py-3"
              >
                <p className="text-sm font-medium">{skill.name}</p>
                {skill.description && (
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {skill.description}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </AppShellLayout>
  );
}
