"use client";

import { getAccessToken } from "@anybot/common";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuthStatus } from "@/rest/auth";

const PUBLIC_ROUTES = ["/login", "/setup"];

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { data: authStatus, isLoading } = useAuthStatus();
  const [resolved, setResolved] = useState(false);

  useEffect(() => {
    if (isLoading) return;

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
  }, [authStatus, isLoading, pathname, router]);

  if (isLoading || !resolved) {
    return <SplashScreen />;
  }

  return <>{children}</>;
}

function SplashScreen() {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-4">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-primary flex items-center justify-center">
            <span className="text-lg font-bold text-primary-foreground">A</span>
          </div>
          <span className="text-2xl font-bold tracking-tight">Anybot</span>
        </div>
        <div className="flex gap-1">
          <span className="h-2 w-2 rounded-full bg-primary/60 animate-pulse" />
          <span className="h-2 w-2 rounded-full bg-primary/40 animate-pulse [animation-delay:150ms]" />
          <span className="h-2 w-2 rounded-full bg-primary/20 animate-pulse [animation-delay:300ms]" />
        </div>
      </div>
    </div>
  );
}
