"use client";

import { Blocks, ChevronDown, Link2, Shield } from "lucide-react";
import { useTranslations } from "next-intl";

/**
 * Composer 前导 mock 动作链：技能 / 连应用 / 权限。
 * 均为占位（点击无副作用，title 提示即将上线），作为 ChatInput 的 leadingActions 传入。
 */
export function ComposerActions() {
  const t = useTranslations("composer");
  const items = [
    {
      key: "skills",
      icon: <Blocks className="h-3.5 w-3.5" />,
      label: t("skills"),
    },
    { key: "apps", icon: <Link2 className="h-3.5 w-3.5" />, label: t("apps") },
    {
      key: "permissions",
      icon: <Shield className="h-3.5 w-3.5" />,
      label: t("permissions"),
    },
  ];
  return (
    <>
      {items.map((it) => (
        <button
          key={it.key}
          type="button"
          title={t("comingSoon")}
          className="flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          {it.icon}
          {it.label}
          <ChevronDown className="h-3 w-3 opacity-60" />
        </button>
      ))}
    </>
  );
}
