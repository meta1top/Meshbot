"use client";

import { getAccessToken, getBrowserApiBaseUrl } from "@meshbot/common";
import type { AuthStatus } from "@meshbot/types-agent";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { authStatusQueryKey } from "@/rest/auth";

const PUBLIC_ROUTES = ["/login", "/setup"];

type AuthBootstrap =
  | { phase: "loading" }
  | {
      phase: "done";
      authStatus: AuthStatus | undefined;
      fetchFailed: boolean;
    };

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const [bootstrap, setBootstrap] = useState<AuthBootstrap>({
    phase: "loading",
  });
  const [resolved, setResolved] = useState(false);

  useEffect(() => {
    const base = getBrowserApiBaseUrl();
    const url = `${base}/api/setup-status`;
    const headers: Record<string, string> = { Accept: "application/json" };
    const token = getAccessToken();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    let cancelled = false;
    void fetch(url, { headers })
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        return res.json() as Promise<AuthStatus>;
      })
      .then((authStatus) => {
        if (cancelled) {
          return;
        }
        queryClient.setQueryData(authStatusQueryKey, authStatus);
        setBootstrap({ phase: "done", authStatus, fetchFailed: false });
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        queryClient.removeQueries({ queryKey: [...authStatusQueryKey] });
        setBootstrap({
          phase: "done",
          authStatus: undefined,
          fetchFailed: true,
        });
      });

    return () => {
      cancelled = true;
    };
  }, [queryClient]);

  useEffect(() => {
    if (bootstrap.phase === "loading") {
      return;
    }

    if (bootstrap.fetchFailed) {
      setResolved(true);
      return;
    }

    const { authStatus } = bootstrap;

    if (authStatus?.needsSetup) {
      if (pathname !== "/setup") {
        router.replace("/setup");
        return;
      }
    } else if (!getAccessToken()) {
      if (pathname !== "/login") {
        router.replace("/login");
        return;
      }
    } else if (PUBLIC_ROUTES.includes(pathname)) {
      router.replace("/");
      return;
    }

    setResolved(true);
  }, [bootstrap, pathname, router]);

  if (bootstrap.phase === "loading" || !resolved) {
    return <SplashScreen />;
  }

  return <>{children}</>;
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
