"use client";

import { Card, Skeleton } from "@meshbot/design";
import { AuthCard } from "@meshbot/web-common/shell";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Suspense, useEffect } from "react";
import { AuthChainBanner } from "@/components/auth/auth-chain-banner";
import { AuthShell } from "@/components/auth/auth-shell";
import { ModelOnboarding } from "@/components/auth/model-onboarding";
import { resolveOnboardingStep } from "@/components/auth/onboarding-step";
import { OrgOnboarding } from "@/components/auth/org-onboarding";
import { clearMainToken } from "@/lib/auth-storage";
import { useProfile } from "@/rest/auth";
import { useModelConfigs } from "@/rest/model-config";

/**
 * 统一 onboarding 漏斗（组织 → 模型）：全站唯一的组织/模型引导实现。
 *
 * 三个入口汇入本页：
 * - 独立注册完成且无组织（shell 的 OnboardingGate redirect，来时无 next）；
 * - 设备授权链（/authorize 发现无组织 redirect 过来，next=/authorize?request=<id>）；
 * - 已登录但无组织/无模型直接访问 shell（同 gate redirect）。
 *
 * 步骤由 resolveOnboardingStep 纯函数决策；完成（ready）跳 next ?? /assistant。
 * 授权链语义差异只有两处：member 无模型不拦（授权不需要模型，直接放行跳 next）、
 * owner 模型步可「跳过」；shell 场景保持 gate 原语义（member 拦截、owner 不可跳过）。
 */
function OnboardingFlow() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next");
  const t = useTranslations("onboarding");
  const commonT = useTranslations("common");

  const profile = useProfile();
  const authenticated = profile.isSuccess && profile.data.user != null;
  const activeOrg = authenticated ? (profile.data?.activeOrg ?? null) : null;
  const models = useModelConfigs(activeOrg?.id ?? null);

  const step = resolveOnboardingStep({
    profileLoading: profile.isPending,
    activeOrg: activeOrg ? { role: activeOrg.role } : null,
    modelConfigsLoading: activeOrg != null && models.isPending,
    modelConfigsError: activeOrg != null && models.isError,
    modelConfigCount: models.data?.length ?? 0,
  });

  const goNext = () => router.replace(next ?? "/assistant");

  // 未登录 / 僵尸 token → 登录页，带上本页完整路径以便登录后回来继续。
  useEffect(() => {
    if (profile.isPending || authenticated) return;
    if (profile.isSuccess) clearMainToken();
    const self = next
      ? `/onboarding?next=${encodeURIComponent(next)}`
      : "/onboarding";
    router.replace(`/login?next=${encodeURIComponent(self)}`);
  }, [profile.isPending, profile.isSuccess, authenticated, next, router]);

  // 就绪（有组织且有模型）→ 跳 next；授权链上 member 无模型也放行（授权不需要模型）。
  const memberPassThrough = step === "model-blocked" && next != null;
  useEffect(() => {
    if (step === "ready" || memberPassThrough) {
      router.replace(next ?? "/assistant");
    }
  }, [step, memberPassThrough, next, router]);

  if (
    step === "loading" ||
    !authenticated ||
    step === "ready" ||
    memberPassThrough
  ) {
    return (
      <div
        role="status"
        aria-label={commonT("loading")}
        className="w-full max-w-[420px]"
      >
        <AuthCard className="flex flex-col gap-3">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-4 w-56" />
          <Skeleton className="h-10 w-full rounded-lg" />
          <Skeleton className="h-10 w-full rounded-lg" />
        </AuthCard>
      </div>
    );
  }

  if (step === "error") {
    return (
      <Card className="w-full max-w-[420px] border-0 p-6 text-center shadow-none">
        <p className="text-sm font-semibold">{t("modelLoadErrorTitle")}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("modelLoadErrorDesc")}
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-3 rounded-md border border-border px-3 py-1.5 text-sm transition-colors hover:bg-muted"
        >
          {t("refresh")}
        </button>
      </Card>
    );
  }

  if (step === "model-blocked") {
    // shell 场景（无 next）：member 且组织无模型——拦截提示联系 owner。
    return (
      <Card className="w-full max-w-[420px] border-0 p-6 text-center shadow-none">
        <p className="text-sm font-semibold">{t("modelBlockedTitle")}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("modelBlockedDesc")}
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-3 rounded-md border border-border px-3 py-1.5 text-sm transition-colors hover:bg-muted"
        >
          {t("refresh")}
        </button>
      </Card>
    );
  }

  return (
    <div className="w-full max-w-[420px]">
      <AuthChainBanner />
      <AuthCard>
        {step === "org" && <OrgOnboarding />}
        {step === "model-owner" && activeOrg && (
          <ModelOnboarding
            orgId={activeOrg.id}
            onDone={goNext}
            allowSkip={next != null}
          />
        )}
      </AuthCard>
    </div>
  );
}

/** `useSearchParams` 需要 Suspense 边界包裹，否则 Next.js 静态渲染报错。 */
export default function OnboardingPage() {
  return (
    <AuthShell>
      <Suspense fallback={null}>
        <OnboardingFlow />
      </Suspense>
    </AuthShell>
  );
}
