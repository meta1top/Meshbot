"use client";

import { QueryClientProvider } from "@tanstack/react-query";
import { AuthGuard } from "@/components/auth-guard";
import { queryClient } from "@/lib/query-client";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthGuard>{children}</AuthGuard>
    </QueryClientProvider>
  );
}
