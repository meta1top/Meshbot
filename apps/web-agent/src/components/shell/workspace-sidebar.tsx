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
import { BrandLogo, RailIconStrip } from "@meshbot/web-common/shell";
import { useQueryClient } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import {
  BarChart3,
  Blocks,
  Bot,
  Building2,
  Check,
  Clock,
  Folder,
  MessageSquare,
  Moon,
  MoreHorizontal,
  Plus,
  Sun,
  Workflow,
} from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useRef, useState } from "react";
import { currentUserAtom } from "@/atoms/auth";
import { areaFromPath } from "@/lib/area-from-path";
import { profileQueryKey } from "@/lib/profile-client";
import { useCloudWebUrl, useLogout } from "@/rest/auth";
import { orgsQueryKey, switchOrg, useOrgs } from "@/rest/org";

/**
 * 左栏容器（浅色宽侧栏）：品牌 + 「新建任务」CTA + 一级区域图标条 + 子栏插槽 + 底部（主题/用户）。
 * org 切换 / 登出 / 主题逻辑原样搬自 workspace-rail.tsx。
 */
export function WorkspaceSidebar({
  sublistSlotRef,
}: {
  sublistSlotRef: (el: HTMLElement | null) => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const t = useTranslations("appShell");
  const tCommon = useTranslations("common");
  const tSettings = useTranslations("settingsSidebar");
  const { theme, toggleTheme } = useTheme();
  const user = useAtomValue(currentUserAtom);
  const logoutMutation = useLogout();
  const area = areaFromPath(pathname);
  const qc = useQueryClient();
  const { data: orgs } = useOrgs();
  const cloudWebUrl = useCloudWebUrl();
  const [switching, setSwitching] = useState(false);
  // 用 ref 持切换锁，避免把 switching state 纳入 useCallback 依赖导致回调频繁重建
  const switchingRef = useRef(false);

  // 单账号：退出即彻底登出回登录页；切换账号 = 退出后重新登录。
  const handleLogout = useCallback(async () => {
    await logoutMutation.mutateAsync().catch(() => {});
    router.replace("/login");
  }, [logoutMutation.mutateAsync, router]);

  /** 切换活跃组织：调远端，成功后失效 profile/org 相关查询。 */
  const handleSwitchOrg = useCallback(
    async (orgId: string) => {
      if (orgId === user?.org?.id || switchingRef.current) return;
      switchingRef.current = true;
      setSwitching(true);
      try {
        await switchOrg(orgId);
        await qc.invalidateQueries({ queryKey: profileQueryKey });
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

  const items = [
    {
      key: "assistant",
      icon: <Bot />,
      label: t("rail.assistant"),
      active: area === "assistant",
      onClick: () => router.push("/assistant"),
    },
    {
      key: "messages",
      icon: <MessageSquare />,
      label: t("rail.messages"),
      active: area === "messages",
      onClick: () => router.push("/messages"),
    },
    {
      key: "skills",
      icon: <Blocks />,
      label: t("rail.skills"),
      active: area === "skills",
      onClick: () => router.push("/skills"),
    },
    {
      key: "drive",
      icon: <Folder />,
      label: t("rail.drive"),
      active: area === "drive",
      onClick: () => router.push("/drive"),
    },
    {
      key: "more",
      icon: <MoreHorizontal />,
      label: t("rail.more"),
      active: area === "more",
      dropdown: (
        <DropdownMenuContent side="right" align="end" className="min-w-[168px]">
          <DropdownMenuItem onClick={() => router.push("/flows")}>
            <Workflow className="mr-2 h-4 w-4" />
            {t("rail.flows")}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => router.push("/more")}>
            <BarChart3 className="mr-2 h-4 w-4" />
            {tSettings("usage")}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => router.push("/schedule")}>
            <Clock className="mr-2 h-4 w-4" />
            {tSettings("scheduled")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      ),
    },
  ];

  return (
    <aside className="flex h-full w-[264px] shrink-0 flex-col border-r border-(--shell-sidebar-border) bg-(--shell-sidebar) text-(--shell-sidebar-fg)">
      {/* 品牌 */}
      <div className="flex items-center gap-2 px-4 pt-3 pb-2">
        <BrandLogo size="sm" withWordmark />
      </div>
      {/* 新建任务 CTA */}
      <button
        type="button"
        onClick={() => router.push("/")}
        className="mx-3 mb-2 flex h-9 items-center gap-2 rounded-lg bg-(--shell-chrome) px-3 text-[13px] font-bold text-white [&_svg]:h-4 [&_svg]:w-4"
      >
        <Plus /> {t("newTask")}
      </button>
      {/* 一级图标条 */}
      <RailIconStrip items={items} />
      <div className="mx-3 my-1.5 h-px bg-(--shell-line)" />
      {/* 二级子栏插槽（各页 portal 进来） */}
      <div
        ref={sublistSlotRef}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto"
      />
      {/* 底部：用户（头像+名，含 org 切换/登出）+ 主题切换 */}
      <div className="mt-auto flex items-center gap-2 border-t border-(--shell-line) px-3 py-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-2 rounded-(--shell-radius) px-1.5 py-1 text-left transition-colors hover:bg-(--shell-sidebar-hover)"
              title={user?.displayName ?? user?.email ?? ""}
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-(--shell-radius) bg-[#16a34a] text-[13px] font-semibold text-white">
                {initial}
              </span>
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-(--shell-sidebar-fg)">
                {user?.displayName ?? user?.email ?? ""}
              </span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side="right"
            align="end"
            className="min-w-[180px]"
          >
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
            <DropdownMenuItem
              disabled={!cloudWebUrl.data}
              onClick={() => {
                if (!cloudWebUrl.data) return;
                window.open(
                  `${cloudWebUrl.data.webMainBase}/settings/org`,
                  "_blank",
                  "noopener,noreferrer",
                );
              }}
            >
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
        <button
          type="button"
          onClick={toggleTheme}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-(--shell-radius) text-(--shell-sidebar-fg)/65 transition-colors hover:bg-(--shell-sidebar-hover) hover:text-(--shell-sidebar-fg)"
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
      </div>
    </aside>
  );
}
