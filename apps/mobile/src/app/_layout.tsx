import "../../global.css";
import "@/i18n/config";
import { QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { Provider as JotaiProvider } from "jotai";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { queryClient } from "@/lib/query";

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <JotaiProvider>
        <QueryClientProvider client={queryClient}>
          <Stack screenOptions={{ headerShown: false }} />
        </QueryClientProvider>
      </JotaiProvider>
    </SafeAreaProvider>
  );
}
