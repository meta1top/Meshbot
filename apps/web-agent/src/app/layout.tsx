import { themeScript } from "@meshbot/web-common";
import { TooltipProvider } from "@meshbot/design";
import type { Metadata } from "next";
import { ElectronInit } from "@/components/electron-init";
import { IntlProvider } from "@/components/intl-provider";
import { Providers } from "@/components/providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "MeshBot",
  description: "MeshBot Agent",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh" suppressHydrationWarning>
      <head>
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: themeScript
          dangerouslySetInnerHTML={{
            __html: themeScript,
          }}
        />
      </head>
      <body className="min-h-screen antialiased">
        <IntlProvider>
          <ElectronInit />
          <TooltipProvider>
            <Providers>{children}</Providers>
          </TooltipProvider>
        </IntlProvider>
      </body>
    </html>
  );
}
