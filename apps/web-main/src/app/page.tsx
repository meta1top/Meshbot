"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { useProfile } from "@/rest/auth";

/** 首页：已登录跳组织设置，未登录跳登录页。本身不渲染实质内容。 */
export default function Home() {
  const t = useTranslations("common");
  const router = useRouter();
  const profile = useProfile();

  useEffect(() => {
    if (profile.isPending) return;
    router.replace(profile.isSuccess ? "/settings/org" : "/login");
  }, [profile.isPending, profile.isSuccess, router]);

  return (
    <main className="flex min-h-screen items-center justify-center">
      <div
        role="status"
        aria-label={t("loading")}
        className="h-8 w-8 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground"
      />
    </main>
  );
}
