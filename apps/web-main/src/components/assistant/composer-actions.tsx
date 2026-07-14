"use client";

import { ComposerActions as SharedComposerActions } from "@meshbot/web-common/session";
import { useTranslations } from "next-intl";

/**
 * Composer 前导 mock 动作链（技能 / 连应用 / 权限）的 web-main 薄桥：与 web-agent
 * 共用 web-common 的同一份实现，只注入 next-intl 文案。三者均为占位（点击无副作用），
 * 云端与本地端的 composer 因此长得一样——此前云端不注入 leadingActions，动作栏左侧是空的。
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
