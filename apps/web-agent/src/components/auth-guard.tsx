"use client";

import type { AuthStatus } from "@meshbot/types-agent";
import { getAccessToken, getBrowserApiBaseUrl } from "@meshbot/web-common";
import { useQuery } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { Loader2 } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { profileQueryAtom } from "@/atoms/auth";
import { ModelSetupGate } from "@/components/model-setup-gate";
import { ProfileUnauthorizedError } from "@/rest/auth";
import { fetchModelConfigs } from "@/rest/model-config";

/** 启动鉴权守卫：profile 优先判定，401 时拉 setup-status 分流。 */
export function AuthGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const profile = useAtomValue(profileQueryAtom);
  const [resolved, setResolved] = useState(false);

  const isAuthenticated = profile.isSuccess && profile.data != null;
  const isPreLoginRoute = pathname === "/login" || pathname === "/register";

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

    let cancelled = false;

    if (profile.isSuccess && profile.data) {
      // 已登录用户停留在 /login 无意义 → 回主页；但 /register 是多步向导，
      // 注册后仍需停留配置模型，由向导自己控制离开
      if (pathname === "/login") {
        setResolved(false);
        router.replace("/assistant");
        return;
      }
      setResolved(true);
      return;
    }

    const isUnauthorized =
      profile.error instanceof ProfileUnauthorizedError ||
      (profile.error as Error | null)?.name === "ProfileUnauthorizedError";

    if (!isUnauthorized) {
      setResolved(true);
      return;
    }

    void fetchSetupStatus()
      .then((setup) => {
        if (cancelled) {
          return;
        }
        const step = setup.step;
        if (step === "needs-org") {
          if (pathname !== "/register") {
            setResolved(false);
            router.replace("/register");
            return;
          }
        } else if (step === "needs-login") {
          // 默认进 /login 登录；允许停留 /register（新用户主动注册）
          if (pathname !== "/login" && pathname !== "/register") {
            setResolved(false);
            router.replace("/login");
            return;
          }
        } else if (pathname !== "/login" && pathname !== "/register") {
          // needs-model / ready 但本地无 JWT → 默认去 /login 重新登录；
          // 模型未配置的判定统一交给登录后的 model-configs 守卫（ModelSetupGate）
          setResolved(false);
          router.replace("/login");
          return;
        }
        setResolved(true);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setResolved(true);
      });

    return () => {
      cancelled = true;
    };
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

/** 拉 setup-status —— 仅在 profile 401 时用于分流。 */
async function fetchSetupStatus(): Promise<AuthStatus> {
  const base = getBrowserApiBaseUrl();
  // 带上活跃账号 token —— 让服务端按当前账号判定 setup 状态（多账号下不能用
  // 服务端的 listLoggedIn()[0] 猜，否则会拿到别的账号的状态）。
  const token = getAccessToken();
  const res = await fetch(`${base}/api/setup-status`, {
    headers: {
      Accept: "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) {
    throw new Error(`setup-status failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as { data?: AuthStatus } & AuthStatus;
  return (body.data ?? body) as AuthStatus;
}

function SplashScreen() {
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-background">
      <div className="drag-handle fixed top-0 right-0 left-0 h-[42px]" />

      <div className="flex flex-col items-center gap-6">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-foreground shadow-[0_2px_8px_rgba(0,0,0,0.12)]">
            <span className="text-base font-semibold text-background">🤖</span>
          </div>
          <span className="text-[22px] font-semibold tracking-tight text-foreground">
            AnyBOT
          </span>
        </div>

        <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>正在准备工作区…</span>
        </div>
      </div>
    </div>
  );
}
