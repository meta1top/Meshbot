"use client";

import { useTheme } from "@meshbot/web-common/react";
import { BrandLogo, RailNavItem } from "@meshbot/web-common/shell";
import {
  Blocks,
  Bot,
  Folder,
  Moon,
  Settings,
  Sun,
  Workflow,
} from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { UserMenu } from "@/components/common/user-menu";
import { areaFromPath } from "@/lib/area-from-path";

/** web-main 深色 rail:六项(消息/设置 真跳,余占位)+ 主题 + 用户菜单。 */
export function WorkspaceRail() {
  const router = useRouter();
  const pathname = usePathname();
  const t = useTranslations("appShell");
  const tCommon = useTranslations("common");
  const { theme, toggleTheme } = useTheme();
  const area = areaFromPath(pathname);

  return (
    <div className="flex h-full w-[68px] shrink-0 flex-col items-center gap-2 bg-(--shell-chrome) px-1.5 pt-2 pb-4">
      <BrandLogo size="sm" />
      <nav className="mt-1 flex w-full flex-col gap-1">
        <RailNavItem
          icon={<Bot className="h-5 w-5" />}
          label={t("rail.assistant")}
          active={area === "assistant"}
          onClick={() => router.push("/assistant")}
        />
        <RailNavItem
          icon={<Blocks className="h-5 w-5" />}
          label={t("rail.skills")}
          active={area === "skills"}
          onClick={() => router.push("/skills")}
        />
        <RailNavItem
          icon={<Folder className="h-5 w-5" />}
          label={t("rail.drive")}
          active={area === "drive"}
          onClick={() => router.push("/drive")}
        />
        <RailNavItem
          icon={<Workflow className="h-5 w-5" />}
          label={t("rail.flows")}
          active={area === "flows"}
          onClick={() => router.push("/flows")}
        />
        <RailNavItem
          icon={<Settings className="h-5 w-5" />}
          label={t("rail.settings")}
          active={area === "settings"}
          onClick={() => router.push("/settings/org")}
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
      <UserMenu />
    </div>
  );
}
