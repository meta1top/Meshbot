"use client";

import {
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@meshbot/design";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { clearMainToken } from "@/lib/auth-storage";
import { useProfile } from "@/rest/auth";
import { useSwitchOrg } from "@/rest/org";

/**
 * rail 用户菜单：紧凑首字母头像触发器(h-8 w-8，配 68px 竖 rail)，
 * 下拉展示 displayName + 当前组织，列 memberships 可切组织，含登出。
 */
export function UserMenu() {
  const t = useTranslations("settings");
  const router = useRouter();
  const profile = useProfile();
  const switchOrg = useSwitchOrg();

  const user = profile.data?.user ?? null;
  const activeOrg = profile.data?.activeOrg ?? null;
  const memberships = profile.data?.memberships ?? [];

  const handleLogout = () => {
    clearMainToken();
    router.replace("/login");
  };

  const handleSwitchOrg = (orgId: string) => {
    if (orgId === activeOrg?.id || switchOrg.isPending) return;
    switchOrg.mutate({ orgId });
  };

  if (!user) return null;

  const initial = user.displayName.charAt(0).toUpperCase();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex h-8 w-8 items-center justify-center rounded-(--shell-radius) bg-[#16a34a] text-[13px] font-semibold text-white"
          title={user.displayName}
        >
          {initial}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="end" className="w-56">
        <DropdownMenuLabel>{user.email}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-muted-foreground">
          {t("userMenu.switchOrg")}
        </DropdownMenuLabel>
        {memberships.map((m) => (
          <DropdownMenuItem
            key={m.id}
            onSelect={() => handleSwitchOrg(m.id)}
            disabled={switchOrg.isPending}
            className={cn(m.id === activeOrg?.id && "font-semibold")}
          >
            {m.name}
            {m.id === activeOrg?.id ? ` (${t("userMenu.current")})` : ""}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem destructive onSelect={handleLogout}>
          {t("userMenu.logout")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
