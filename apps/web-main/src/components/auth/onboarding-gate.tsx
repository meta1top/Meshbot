"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { useEffect } from "react";
import { resolveOnboardingStep } from "@/components/auth/onboarding-step";
import { useProfile } from "@/rest/auth";
import { useModelConfigs } from "@/rest/model-config";

/** 居中加载态（复用 AuthGuard 同款 spinner 风格）。 */
function GateLoading() {
  const t = useTranslations("common");
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div
        role="status"
        aria-label={t("loading")}
        className="h-8 w-8 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground"
      />
    </div>
  );
}

/**
 * 登录后前置引导门：AuthGuard 已保证登录；组织/模型缺失时 redirect 到统一
 * onboarding 漏斗 `/onboarding`（组织 → 模型引导的唯一实现），满足才渲染 app。
 * error 态也交给 /onboarding（那里有重试卡），本门只保留判定与放行。
 */
export function OnboardingGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const profile = useProfile();
  const activeOrg = profile.data?.activeOrg ?? null;
  const models = useModelConfigs(activeOrg?.id ?? null);

  const step = resolveOnboardingStep({
    profileLoading: profile.isPending,
    activeOrg: activeOrg ? { role: activeOrg.role } : null,
    modelConfigsLoading: activeOrg != null && models.isPending,
    modelConfigsError: activeOrg != null && models.isError,
    modelConfigCount: models.data?.length ?? 0,
  });

  const needsOnboarding = step !== "loading" && step !== "ready";
  useEffect(() => {
    if (needsOnboarding) router.replace("/onboarding");
  }, [needsOnboarding, router]);

  if (step !== "ready") return <GateLoading />;
  return <>{children}</>;
}
