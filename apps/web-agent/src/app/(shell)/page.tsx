"use client";

import { LauncherHome } from "@/components/home/launcher-home";
import { RecentSessionsSidebar } from "@/components/home/recent-sessions-sidebar";
import { PageShell } from "@/components/layouts/page-shell";

/** 起手台首页 `/`：左栏最近会话 + 中区起手台 composer。 */
export default function HomePage() {
  return (
    <PageShell sidebar={<RecentSessionsSidebar />}>
      <LauncherHome />
    </PageShell>
  );
}
