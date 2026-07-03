"use client";

import { useQuery } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { profileQueryAtom } from "@/atoms/auth";
import { BrandLogo } from "@/components/brand-logo";
import { ModelSetupGate } from "@/components/model-setup-gate";
import { ProfileUnauthorizedError } from "@/rest/auth";
import { fetchModelConfigs } from "@/rest/model-config";

/** 启动鉴权守卫：profile 401（未登录）一律去 /login（浏览器授权登录）。 */
export function AuthGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const profile = useAtomValue(profileQueryAtom);
  const [resolved, setResolved] = useState(false);

  const isAuthenticated = profile.isSuccess && profile.data != null;
  const isPreLoginRoute = pathname === "/login";

  const { data: modelConfigs, isPending: modelsPending } = useQuery({
    queryKey: ["model-configs"],
    queryFn: fetchModelConfigs,
    // 仅在已认证且不在登录前路由时才拉取，避免未认证状态发出无效请求
    enabled: isAuthenticated && !isPreLoginRoute,
    staleTime: 60_000,
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: isSuccess gates data
  useEffect(() => {
    if (profile.isPending) {
      return;
    }

    if (profile.isSuccess && profile.data) {
      // 已登录用户停留在 /login 无意义 → 回主页
      if (pathname === "/login") {
        setResolved(false);
        router.replace("/");
        return;
      }
      setResolved(true);
      return;
    }

    const isUnauthorized =
      profile.error instanceof ProfileUnauthorizedError ||
      (profile.error as Error | null)?.name === "ProfileUnauthorizedError";

    if (isUnauthorized && pathname !== "/login") {
      // 未登录一律去 /login（浏览器授权登录）；组织归属由云端流程保证，
      // 模型未配置的判定统一交给登录后的 model-configs 守卫（ModelSetupGate）。
      setResolved(false);
      router.replace("/login");
      return;
    }
    setResolved(true);
  }, [profile.isPending, profile.isSuccess, profile.error, pathname, router]);

  if (profile.isPending || !resolved) {
    return <SplashScreen />;
  }

  // 已认证 + 非登录前路由：追加模型配置守卫
  if (isAuthenticated && !isPreLoginRoute) {
    if (modelsPending) return <SplashScreen />;
    // 成功拉到空列表 → 引导配置；拉取失败（网络异常等）不阻塞用户
    if (modelConfigs?.length === 0) return <ModelSetupGate />;
  }

  return <>{children}</>;
}

function SplashScreen() {
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-background">
      <div className="drag-handle fixed top-0 right-0 left-0 h-[42px]" />

      <div className="flex flex-col items-center gap-6">
        <BrandLogo size="lg" withWordmark spinning />

        <span className="text-[13px] text-muted-foreground">
          正在准备工作区…
        </span>
      </div>
    </div>
  );
}
