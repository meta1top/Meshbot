"use client";

import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { useProfile } from "@/rest/auth";

/** 未登录 / token 失效时不重定向的公开路径前缀（与 `lib/api.ts` 的 PUBLIC_PATHS 保持一致）。 */
const PUBLIC_PATHS = ["/login", "/register", "/authorize", "/share"];

/**
 * 云协同前端启动鉴权守卫：拉 profile，401 / 请求失败即跳转登录页
 * （携带 `next` 便于登录后跳回原页面），公开路径（登录/注册/分享等）自身不拦截。
 */
export function AuthGuard({ children }: { children: React.ReactNode }) {
  const t = useTranslations("common");
  const router = useRouter();
  const pathname = usePathname();
  const profile = useProfile();
  const isPublicPath = PUBLIC_PATHS.some((p) => pathname.startsWith(p));

  useEffect(() => {
    if (isPublicPath || profile.isPending || profile.isSuccess) return;
    router.replace(`/login?next=${encodeURIComponent(pathname)}`);
  }, [isPublicPath, profile.isPending, profile.isSuccess, pathname, router]);

  if (isPublicPath) return <>{children}</>;

  if (profile.isPending || profile.isError) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div
          role="status"
          aria-label={t("loading")}
          className="h-8 w-8 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground"
        />
      </div>
    );
  }

  return <>{children}</>;
}
