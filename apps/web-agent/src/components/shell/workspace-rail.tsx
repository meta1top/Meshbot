"use client";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@meshbot/design";
import { useTheme } from "@meshbot/web-common/react";
import { useQueryClient } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import {
  Blocks,
  Building2,
  Check,
  Cloud,
  MessageSquare,
  Moon,
  MoreHorizontal,
  Sun,
} from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useRef, useState } from "react";
import { currentUserAtom } from "@/atoms/auth";
import { BrandLogo } from "@/components/brand-logo";
import { RailNavItem } from "@/components/shell/rail-nav-item";
import { areaFromPath } from "@/lib/area-from-path";
import { profileQueryKey } from "@/lib/profile-client";
import { authStatusQueryKey, useLogout } from "@/rest/auth";
import { orgsQueryKey, switchOrg, useOrgs } from "@/rest/org";

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
  const qc = useQueryClient();
  const { data: orgs } = useOrgs();
  const [switching, setSwitching] = useState(false);
  // 用 ref 持切换锁，避免把 switching state 纳入 useCallback 依赖导致回调频繁重建
  const switchingRef = useRef(false);

  // 单账号：退出即彻底登出回登录页；切换账号 = 退出后重新登录。
  const handleLogout = useCallback(async () => {
    await logoutMutation.mutateAsync().catch(() => {});
    router.replace("/login");
  }, [logoutMutation.mutateAsync, router]);

  /** 切换活跃组织：调远端，成功后失效 profile/authStatus/org 相关查询。 */
  const handleSwitchOrg = useCallback(
    async (orgId: string) => {
      if (orgId === user?.org?.id || switchingRef.current) return;
      switchingRef.current = true;
      setSwitching(true);
      try {
        await switchOrg(orgId);
        await qc.invalidateQueries({ queryKey: profileQueryKey });
        await qc.invalidateQueries({ queryKey: authStatusQueryKey });
        await qc.invalidateQueries({ queryKey: ["org"] });
        await qc.invalidateQueries({ queryKey: ["members"] });
        await qc.invalidateQueries({ queryKey: orgsQueryKey });
      } catch (err) {
        // 切换失败：profile 保持原组织，控制台记录错误
        console.error("[org-switch] 切换组织失败", err);
      } finally {
        switchingRef.current = false;
        setSwitching(false);
      }
    },
    // switching state 不进依赖：竞态保护由 switchingRef 承担，switching 仅用于 UI 中态展示
    // switchingRef 是稳定引用（useRef 对象永不变），不需要放入依赖数组
    [user?.org?.id, qc],
  );

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
        <RailNavItem
          icon={<Cloud className="h-5 w-5" />}
          label={t("rail.drive")}
          active={area === "drive"}
          onClick={() => router.push("/drive")}
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
        <DropdownMenuContent side="right" align="end" className="min-w-[180px]">
          {orgs && orgs.length > 0 ? (
            <>
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                {t("userMenu.orgSwitcher")}
              </DropdownMenuLabel>
              <DropdownMenuGroup>
                {orgs.map((org) => {
                  const isActive = org.id === user?.org?.id;
                  return (
                    <DropdownMenuItem
                      key={org.id}
                      onClick={() => void handleSwitchOrg(org.id)}
                      disabled={switching}
                      className="flex items-center gap-2"
                    >
                      <Check
                        className={`h-3.5 w-3.5 shrink-0 ${isActive ? "opacity-100" : "opacity-0"}`}
                      />
                      <span className="truncate">{org.name}</span>
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
            </>
          ) : null}
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
