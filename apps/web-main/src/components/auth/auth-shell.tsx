"use client";

import { cn } from "@meshbot/design";
import { useTranslations } from "next-intl";

interface AuthShellProps {
  children: React.ReactNode;
  className?: string;
}

/**
 * 云协同前端登录 / 注册品牌壳：左品牌色块 + 右表单内容。
 *
 * 参考 web-agent `AuthShellLayout` 的简化版 —— web-main 暂无主题切换 /
 * 拖拽标题栏基建（Electron 专属），此壳只保留视觉分栏，配色复用
 * `@meshbot/design` 的 `--primary`/`--secondary` token，不引入新变量。
 */
export function AuthShell({ children, className }: AuthShellProps) {
  const t = useTranslations("authShell");

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <div className="relative hidden w-[42%] flex-col justify-between overflow-hidden bg-linear-to-br from-primary to-secondary p-10 text-primary-foreground lg:flex">
        <div className="text-lg font-semibold tracking-tight">{t("brand")}</div>
        <div>
          <div className="text-[28px] font-extrabold leading-snug">
            {t("tagline")}
          </div>
          <div className="mt-3 text-sm text-white/85">{t("subtitle")}</div>
        </div>
        <div className="pointer-events-none absolute -right-12 -bottom-12 h-48 w-48 rounded-full border-[20px] border-white/10" />
      </div>
      <div
        className={cn(
          "relative z-10 flex min-h-0 flex-1 items-center justify-center px-6",
          className,
        )}
      >
        {children}
      </div>
    </div>
  );
}
