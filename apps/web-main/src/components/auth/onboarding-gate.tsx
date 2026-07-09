"use client";

import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { useState } from "react";
import { resolveOnboardingStep } from "@/components/auth/onboarding-step";
import { OrgOnboarding } from "@/components/auth/org-onboarding";
import {
  ModelFormPanel,
  type ModelFormValues,
  modelFormValuesToCreateInput,
} from "@/components/models/model-form-panel";
import { ApiError } from "@/lib/api";
import { useProfile } from "@/rest/auth";
import { useCreateModelConfig, useModelConfigs } from "@/rest/model-config";

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

/** owner：就地建首个模型配置。成功后 useCreateModelConfig 会 invalidate 列表 → 门重算放行。 */
function ModelOwnerStep({ orgId }: { orgId: string }) {
  const t = useTranslations("onboarding");
  const create = useCreateModelConfig(orgId);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (values: ModelFormValues) => {
    setError(null);
    try {
      await create.mutateAsync(modelFormValuesToCreateInput(values));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  };

  return (
    <div className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-4 px-4">
      <div>
        <h1 className="text-lg font-semibold">{t("modelStepTitle")}</h1>
        <p className="text-sm text-muted-foreground">{t("modelStepDesc")}</p>
      </div>
      <ModelFormPanel
        mode="create"
        initial={null}
        onCancel={() => {}}
        onSubmit={onSubmit}
        submitting={create.isPending}
        error={error}
      />
    </div>
  );
}

/** 非 owner 且组织无模型：只读拦截，提示联系 owner；提供刷新（重拉 profile+模型）。 */
function ModelBlocked() {
  const t = useTranslations("onboarding");
  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-3 px-4 text-center">
      <h1 className="text-lg font-semibold">{t("modelBlockedTitle")}</h1>
      <p className="text-sm text-muted-foreground">{t("modelBlockedDesc")}</p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="rounded-md border border-border px-3 py-1.5 text-sm transition-colors hover:bg-muted"
      >
        {t("refresh")}
      </button>
    </div>
  );
}

/**
 * 登录后前置引导门：AuthGuard 已保证登录；此门按 组织/模型 状态决定就地引导或放行。
 * 挂在 (shell)/layout，包住全部 app 路由——门本身就地提供 org/model UI，被拦时无需访问其它页。
 */
export function OnboardingGate({ children }: { children: ReactNode }) {
  const profile = useProfile();
  const activeOrg = profile.data?.activeOrg ?? null;
  const models = useModelConfigs(activeOrg?.id ?? null);

  const step = resolveOnboardingStep({
    profileLoading: profile.isPending,
    activeOrg: activeOrg ? { role: activeOrg.role } : null,
    modelConfigsLoading: activeOrg != null && models.isPending,
    modelConfigCount: models.data?.length ?? 0,
  });

  switch (step) {
    case "loading":
      return <GateLoading />;
    case "org":
      return <OrgOnboarding />;
    case "model-owner":
      // activeOrg 必非空（step 为 model-owner 时）
      return <ModelOwnerStep orgId={activeOrg!.id} />;
    case "model-blocked":
      return <ModelBlocked />;
    default:
      return <>{children}</>;
  }
}
