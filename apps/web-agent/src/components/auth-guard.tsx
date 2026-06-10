"use client";

import type { AuthStatus } from "@meshbot/types-agent";
import { getBrowserApiBaseUrl } from "@meshbot/web-common";
import { useAtomValue } from "jotai";
import { Loader2 } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { profileQueryAtom } from "@/atoms/auth";
import { ProfileUnauthorizedError } from "@/rest/auth";

/** 启动鉴权守卫：profile 优先判定，401 时拉 setup-status 分流。 */
export function AuthGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const profile = useAtomValue(profileQueryAtom);
  const [resolved, setResolved] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: isSuccess gates data
  useEffect(() => {
    if (profile.isPending) {
      return;
    }

    let cancelled = false;

    if (profile.isSuccess && profile.data) {
      // 已登录用户停留在 /login 无意义 → 回主页；但 /setup 是多步向导，
      // 注册后仍需停留配置模型，由向导自己控制离开
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
        if (step === "needs-org" || step === "needs-model") {
          if (pathname !== "/setup") {
            setResolved(false);
            router.replace("/setup");
            return;
          }
        } else if (step === "needs-login") {
          // 新用户默认进 /setup 注册；允许停留 /login（已有账号登录）
          if (pathname !== "/setup" && pathname !== "/login") {
            setResolved(false);
            router.replace("/setup");
            return;
          }
        } else if (pathname !== "/login") {
          // ready 但本地无 JWT → 去 /login 重新登录
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

  return <>{children}</>;
}

/** 拉 setup-status —— 仅在 profile 401 时用于分流。 */
async function fetchSetupStatus(): Promise<AuthStatus> {
  const base = getBrowserApiBaseUrl();
  const res = await fetch(`${base}/api/setup-status`, {
    headers: { Accept: "application/json" },
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
      <div className="drag-handle fixed top-0 right-0 left-0 h-[52px]" />

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
