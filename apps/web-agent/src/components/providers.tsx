"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Provider as JotaiProvider } from "jotai";
import { useHydrateAtoms } from "jotai/utils";
import { queryClientAtom } from "jotai-tanstack-query";
import { useState } from "react";
import { AuthGuard } from "@/components/auth-guard";

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: 1,
        staleTime: 5 * 60 * 1000,
        refetchOnWindowFocus: false,
        networkMode: "always",
      },
    },
  });
}

/** 把现有 QueryClient 注入 jotai 的 queryClientAtom，让 atomWithQuery 复用它。 */
function HydrateQueryClient({
  queryClient,
  children,
}: {
  queryClient: QueryClient;
  children: React.ReactNode;
}) {
  useHydrateAtoms([[queryClientAtom, queryClient]]);
  return <>{children}</>;
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => createQueryClient());

  return (
    <QueryClientProvider client={queryClient}>
      <JotaiProvider>
        <HydrateQueryClient queryClient={queryClient}>
          <AuthGuard>{children}</AuthGuard>
        </HydrateQueryClient>
      </JotaiProvider>
    </QueryClientProvider>
  );
}
