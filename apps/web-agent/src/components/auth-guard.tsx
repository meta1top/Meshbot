"use client";

import { getAccessToken } from "@anybot/common";
import { Loader2 } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useAuthStatus } from "@/rest/auth";

const PUBLIC_ROUTES = ["/login", "/setup"];

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { data: authStatus, isLoading, isError } = useAuthStatus();
  const [resolved, setResolved] = useState(false);
  const didRedirect = useRef(false);

  useEffect(() => {
    if (isLoading) return;

    if (isError) {
      setResolved(true);
      return;
    }

    if (authStatus?.needsSetup) {
      if (pathname !== "/setup") {
        didRedirect.current = true;
        router.replace("/setup");
        return;
      }
    } else if (!getAccessToken()) {
      if (pathname !== "/login") {
        didRedirect.current = true;
        router.replace("/login");
        return;
      }
    } else if (PUBLIC_ROUTES.includes(pathname)) {
      didRedirect.current = true;
      router.replace("/");
      return;
    }

    setResolved(true);
  }, [authStatus, isLoading, isError, pathname, router]);

  if (isLoading || !resolved) {
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
