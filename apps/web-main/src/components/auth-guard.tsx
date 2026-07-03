"use client";

import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { clearMainToken } from "@/lib/auth-storage";
import { isPublicPath } from "@/lib/routes";
import { useProfile } from "@/rest/auth";

/**
 * 云协同前端启动鉴权守卫：拉 profile，401 / 请求失败即跳转登录页
 * （`next` 携带路径 + query，便于登录后跳回原页面），公开路径（登录/注册/分享等）
 * 自身不拦截。有效 token 但用户已删（success 且 `user:null`）同样视为未认证——
 * 先清 token 再跳转，防止带着僵尸 token 循环重定向。
 */
export function AuthGuard({ children }: { children: React.ReactNode }) {
  const t = useTranslations("common");
  const router = useRouter();
  const pathname = usePathname();
  const profile = useProfile();
  const publicPath = isPublicPath(pathname);
  const authenticated = profile.isSuccess && profile.data.user != null;

  useEffect(() => {
    if (publicPath || profile.isPending || authenticated) return;
    if (profile.isSuccess) clearMainToken(); // success 但 user:null → 清僵尸 token

    const next = pathname + window.location.search;
    router.replace(`/login?next=${encodeURIComponent(next)}`);
  }, [
    publicPath,
    profile.isPending,
    profile.isSuccess,
    authenticated,
    pathname,
    router,
  ]);

  if (publicPath) return <>{children}</>;

  if (!authenticated) {
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
