"use client";

import { ComposerActions as SharedComposerActions } from "@meshbot/web-common/session";
import { useTranslations } from "next-intl";

/**
 * Composer 前导 mock 动作链（技能 / 连应用 / 权限）的 web-agent 薄桥：
 * 实现搬到了 web-common（云端 composer 用同一份），这里只注入 next-intl 文案。
 */
export function ComposerActions() {
  const t = useTranslations("composer");
  return (
    <SharedComposerActions
      labels={{
        skills: t("skills"),
        apps: t("apps"),
        permissions: t("permissions"),
        comingSoon: t("comingSoon"),
      }}
    />
  );
}
