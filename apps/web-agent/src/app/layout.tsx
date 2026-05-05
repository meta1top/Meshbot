import type { Metadata } from "next";
import { ElectronInit } from "@/components/electron-init";
import { IntlProvider } from "@/components/intl-provider";
import { Providers } from "@/components/providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "AnyBOT",
  description: "AnyBOT Agent",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh" suppressHydrationWarning>
      <head>
        <script src="/theme-init.js" />
      </head>
      <body className="min-h-screen antialiased">
        <IntlProvider>
          <ElectronInit />
          <Providers>{children}</Providers>
        </IntlProvider>
      </body>
    </html>
  );
}
