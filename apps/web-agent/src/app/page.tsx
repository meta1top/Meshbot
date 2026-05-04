"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useAuthStatus } from "@/rest/auth";
import { getAccessToken } from "@anybot/common";

export default function Home() {
  const router = useRouter();
  const { data: authStatus, isLoading } = useAuthStatus();

  useEffect(() => {
    if (isLoading) return;

    if (!getAccessToken()) {
      if (authStatus?.needsSetup) {
        router.replace("/setup");
      } else {
        router.replace("/login");
      }
      return;
    }

    if (authStatus?.needsSetup) {
      router.replace("/setup");
    }
  }, [authStatus, isLoading, router]);

  if (isLoading) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <p className="text-gray-400">加载中...</p>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center">
      <h1 className="text-2xl font-bold">Anybot Agent</h1>
      <p className="ml-4 text-sm text-gray-400">已就绪</p>
    </main>
  );
}
