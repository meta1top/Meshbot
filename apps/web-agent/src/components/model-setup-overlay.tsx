"use client";

import { useTranslations } from "next-intl";
import { AuthShellLayout } from "@/components/layouts/auth-shell-layout";
import { ModelStep } from "@/components/setup/model-step";

/**
 * 已登录但未配置模型时的全屏引导页。
 * 完成后由 AuthGuard 中的 model-configs 查询自动检测到有模型而切换到正常内容，
 * 无需手动 redirect。
 */
export function ModelSetupOverlay() {
  const t = useTranslations("setup");

  return (
    <AuthShellLayout>
      <div className="w-full max-w-[420px]">
        <div className="pr-1">
          <span className="mb-4 inline-flex items-center rounded-md border border-border bg-card px-2.5 py-1 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground">
            {t("getStarted")}
          </span>
          {/* onDone 无需额外操作：useCreateModelConfig 的 onSuccess 已自动
              invalidate ["model-configs"]，AuthGuard 会重渲并放行正常内容。 */}
          <ModelStep onDone={() => {}} />
        </div>
      </div>
    </AuthShellLayout>
  );
}
