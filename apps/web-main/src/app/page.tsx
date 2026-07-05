"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { useProfile } from "@/rest/auth";

/** 首页：已登录跳消息区，未登录跳登录页。本身不渲染实质内容。 */
export default function Home() {
  const t = useTranslations("common");
  const router = useRouter();
  const profile = useProfile();
  // user 可空（token 有效但用户已删），判空后才算已登录
  const authenticated = profile.isSuccess && profile.data.user != null;

  useEffect(() => {
    if (profile.isPending) return;
    router.replace(authenticated ? "/messages" : "/login");
  }, [profile.isPending, authenticated, router]);

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
