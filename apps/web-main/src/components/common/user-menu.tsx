"use client";

import {
  Button,
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
 * 顶栏用户菜单：展示 displayName + 当前组织，列 memberships 可切组织，含登出。
 * `/settings` 与 `/messages` 两个壳共用，登出后跳登录页。
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

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5">
          <span className="max-w-[160px] truncate">{user.displayName}</span>
          {activeOrg ? (
            <span className="max-w-[120px] truncate text-muted-foreground">
              · {activeOrg.name}
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
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
