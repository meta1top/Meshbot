"use client";

import { cn } from "@meshbot/design";
import { useTranslations } from "next-intl";

export type WizardStep = "account" | "verify" | "org" | "model" | "device";

/** 注册授权向导步骤指示：受邀成员无模型写权限 → includeModel:false 渲染四步。 */
export function WizardSteps({
  current,
  includeModel,
}: {
  current: WizardStep;
  includeModel: boolean;
}) {
  const t = useTranslations("wizard");
  const steps: WizardStep[] = includeModel
    ? ["account", "verify", "org", "model", "device"]
    : ["account", "verify", "org", "device"];
  const idx = steps.indexOf(current);
  return (
    <ol className="mb-4 flex items-center gap-1.5 text-[11px] text-muted-foreground/70">
      {steps.map((s, i) => (
        <li key={s} className="flex items-center gap-1.5">
          {i > 0 && <span aria-hidden>─</span>}
          <span
            className={cn(
              i < idx && "text-green-600",
              i === idx && "font-bold text-(--shell-accent)",
            )}
          >
            {i < idx ? "✓ " : ""}
            {t(`steps.${s}`)}
          </span>
        </li>
      ))}
    </ol>
  );
}
