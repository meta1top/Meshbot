"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { UserMenu } from "@/components/common/user-menu";
import { ImSidebar } from "@/components/im/im-sidebar";

/**
 * `/messages/*` IM 壳：顶栏（标题 + 返回设置入口 + 用户菜单）+ 左侧 Agent-DM 侧栏 + 右会话区。
 * 鉴权由根 `Providers` 里的全局 `AuthGuard` 统一负责，无需页面级守卫。
 */
export default function MessagesLayout({ children }: { children: ReactNode }) {
  const t = useTranslations("messages");

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-5">
        <div className="flex items-center gap-4">
          <div className="text-sm font-semibold">{t("title")}</div>
          <Link
            href="/settings/org"
            className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            {t("settingsLink")}
          </Link>
        </div>
        <UserMenu />
      </header>
      <div className="flex min-h-0 flex-1">
        <ImSidebar />
        <main className="min-w-0 flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
