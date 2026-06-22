"use client";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@meshbot/design";
import { useTheme } from "@meshbot/web-common/react";
import { useAtomValue } from "jotai";
import {
  Blocks,
  Building2,
  MessageSquare,
  Moon,
  MoreHorizontal,
  Sun,
} from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback } from "react";
import { currentUserAtom } from "@/atoms/auth";
import { BrandLogo } from "@/components/brand-logo";
import { RailNavItem } from "@/components/shell/rail-nav-item";
import { areaFromPath } from "@/lib/area-from-path";
import { useLogout } from "@/rest/auth";

export { areaFromPath } from "@/lib/area-from-path";

export function WorkspaceRail() {
  const router = useRouter();
  const pathname = usePathname();
  const t = useTranslations("appShell");
  const tCommon = useTranslations("common");
  const { theme, toggleTheme } = useTheme();
  const user = useAtomValue(currentUserAtom);
  const logoutMutation = useLogout();
  const area = areaFromPath(pathname);

  // 单账号：退出即彻底登出回登录页；切换账号 = 退出后重新登录。
  const handleLogout = useCallback(async () => {
    await logoutMutation.mutateAsync().catch(() => {});
    router.replace("/login");
  }, [logoutMutation.mutateAsync, router]);

  const initial = (user?.displayName ?? user?.email ?? "?")
    .charAt(0)
    .toUpperCase();

  return (
    <div className="flex h-full w-[68px] shrink-0 flex-col items-center gap-2 bg-(--shell-chrome) px-1.5 pt-2 pb-4">
      <BrandLogo size="sm" />
      <nav className="mt-1 flex w-full flex-col gap-1">
        <RailNavItem
          icon={<MessageSquare className="h-5 w-5" />}
          label={t("rail.messages")}
          active={area === "messages"}
          onClick={() => router.push("/messages")}
        />
        <RailNavItem
          icon={<Blocks className="h-5 w-5" />}
          label={t("rail.skills")}
          active={area === "skills"}
          onClick={() => router.push("/skills")}
        />
        <RailNavItem
          icon={<MoreHorizontal className="h-5 w-5" />}
          label={t("rail.more")}
          active={area === "more"}
          onClick={() => router.push("/more")}
        />
      </nav>
      <div className="flex-1" />
      <button
        type="button"
        onClick={toggleTheme}
        className="flex h-9 w-9 items-center justify-center rounded-(--shell-radius) text-white/65 transition-colors hover:bg-white/10 hover:text-white"
        title={
          theme === "dark"
            ? tCommon("switchToLightTheme")
            : tCommon("switchToDarkTheme")
        }
      >
        {theme === "dark" ? (
          <Sun className="h-4 w-4" />
        ) : (
          <Moon className="h-4 w-4" />
        )}
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex h-8 w-8 items-center justify-center rounded-(--shell-radius) bg-[#16a34a] text-[13px] font-semibold text-white"
            title={user?.displayName ?? user?.email ?? ""}
          >
            {initial}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="end">
          <DropdownMenuItem onClick={() => router.push("/settings/org")}>
            <Building2 className="mr-2 h-4 w-4" />
            {t("userMenu.org")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => void handleLogout()}
            disabled={logoutMutation.isPending}
          >
            {t("userMenu.logout")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
