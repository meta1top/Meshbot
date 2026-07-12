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
import { BrandLogo, RailNav } from "@meshbot/web-common/shell";
import {
  Blocks,
  Bot,
  Building2,
  Check,
  Cpu,
  Folder,
  MessageSquare,
  MonitorSmartphone,
  Moon,
  Plus,
  Sun,
} from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { areaFromPath } from "@/lib/area-from-path";
import { clearMainToken } from "@/lib/auth-storage";
import { useProfile } from "@/rest/auth";
import { useSwitchOrg } from "@/rest/org";

/**
 * 左栏容器（浅色宽侧栏）：品牌 + 「发起消息」CTA + 一级区域图标条 + 子栏插槽 + 底部（主题/用户）。
 * org 切换 / 登出逻辑原样搬自旧 workspace-rail.tsx + user-menu.tsx（该两文件已删，逻辑内联于此，对齐范本 web-agent workspace-sidebar.tsx 的形态）。
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
  const { theme, toggleTheme } = useTheme();
  const profile = useProfile();
  const switchOrgMutation = useSwitchOrg();
  const area = areaFromPath(pathname);

  const user = profile.data?.user ?? null;
  const activeOrg = profile.data?.activeOrg ?? null;
  const memberships = profile.data?.memberships ?? [];

  // 单账号：登出即硬跳回登录页，清空内存缓存/查询状态——下一个登录账号不得继承本账号数据。
  const handleLogout = () => {
    clearMainToken();
    window.location.href = "/login";
  };

  /** 切换活跃组织：`useSwitchOrg` 成功后自身会重签 token + 全量失效查询。 */
  const handleSwitchOrg = (orgId: string) => {
    if (orgId === activeOrg?.id || switchOrgMutation.isPending) return;
    switchOrgMutation.mutate({ orgId });
  };

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
  ];
  const activeKey = items.find((i) => i.active)?.key;

  return (
    <aside className="flex h-full w-[264px] shrink-0 flex-col border-r border-(--shell-sidebar-border) bg-(--shell-sidebar) text-(--shell-sidebar-fg)">
      {/* 品牌 */}
      <div className="sidebar-brand flex items-center gap-2 px-3 pt-3 pb-2">
        <BrandLogo size="sm" withWordmark />
      </div>
      {/* 发起消息 CTA */}
      <button
        type="button"
        onClick={() => router.push("/messages")}
        className="mx-3 mt-2 mb-4 flex h-9 items-center gap-2 rounded-lg bg-(--shell-chrome) px-3 text-[13px] font-bold text-white [&_svg]:h-4 [&_svg]:w-4"
      >
        <Plus /> {t("newMessage")}
      </button>
      {/* 一级图标条 */}
      <RailNav
        orientation="horizontal"
        className="px-3"
        items={items.map(({ key, icon, label }) => ({ key, icon, label }))}
        activeKey={activeKey}
        onSelect={(key) => items.find((i) => i.key === key)?.onClick?.()}
      />
      <div className="mx-3 my-3 h-px bg-(--shell-line)" />
      {/* 二级子栏插槽（各页 portal 进来） */}
      <div
        ref={sublistSlotRef}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto"
      />
      {/* 底部：用户（头像+名，含 org 切换/管理入口/登出）+ 主题切换 */}
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
            {memberships.length > 0 ? (
              <>
                <DropdownMenuLabel className="text-xs text-muted-foreground">
                  {t("userMenu.orgSwitcher")}
                </DropdownMenuLabel>
                <DropdownMenuGroup>
                  {memberships.map((org) => {
                    const isActive = org.id === activeOrg?.id;
                    return (
                      <DropdownMenuItem
                        key={org.id}
                        onClick={() => handleSwitchOrg(org.id)}
                        disabled={switchOrgMutation.isPending}
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
              {t("userMenu.orgAndMembers")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => router.push("/settings/models")}>
              <Cpu className="mr-2 h-4 w-4" />
              {t("userMenu.models")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => router.push("/settings/devices")}>
              <MonitorSmartphone className="mr-2 h-4 w-4" />
              {t("userMenu.devices")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={handleLogout}>
              {t("userMenu.logout")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <button
          type="button"
          onClick={toggleTheme}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-(--shell-radius) text-(--shell-sidebar-fg)/65 transition-colors hover:bg-(--shell-sidebar-hover) hover:text-(--shell-sidebar-fg)"
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
