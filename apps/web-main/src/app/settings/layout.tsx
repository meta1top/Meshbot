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
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { clearMainToken } from "@/lib/auth-storage";
import { useProfile } from "@/rest/auth";
import { useSwitchOrg } from "@/rest/org";

interface NavItem {
  href: string;
  labelKey: "org" | "devices" | "models";
}

const NAV_ITEMS: NavItem[] = [
  { href: "/settings/org", labelKey: "org" },
  { href: "/settings/devices", labelKey: "devices" },
  { href: "/settings/models", labelKey: "models" },
];

/** 左侧导航（组织/设备/模型），当前路径高亮。 */
function SettingsNav() {
  const t = useTranslations("settings");
  const pathname = usePathname();

  return (
    <nav className="flex w-48 shrink-0 flex-col gap-1 border-r border-border p-3">
      {NAV_ITEMS.map((item) => {
        const active = pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              "rounded-md px-3 py-2 text-sm font-medium transition-colors",
              active
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
            )}
          >
            {t(`nav.${item.labelKey}`)}
          </Link>
        );
      })}
    </nav>
  );
}

/** 顶栏用户菜单：展示 displayName + 当前组织，列 memberships 可切组织，含登出。 */
function UserMenu() {
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

/** `/settings/*` 共享壳：左导航 + 顶栏用户菜单。鉴权由根 `Providers` 里的全局 `AuthGuard` 统一负责。 */
export default function SettingsLayout({ children }: { children: ReactNode }) {
  const t = useTranslations("settings");

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-5">
        <div className="text-sm font-semibold">{t("title")}</div>
        <UserMenu />
      </header>
      <div className="flex min-h-0 flex-1">
        <SettingsNav />
        <main className="min-w-0 flex-1 overflow-auto p-6">{children}</main>
      </div>
    </div>
  );
}
