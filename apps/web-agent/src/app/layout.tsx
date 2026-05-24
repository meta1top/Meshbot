import { TooltipProvider } from "@meshbot/design";
import { themeScript } from "@meshbot/web-common";
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
        <link
          rel="apple-touch-icon"
          sizes="180x180"
          href="/apple-touch-icon.png"
        />
        <link
          rel="icon"
          type="image/png"
          sizes="32x32"
          href="/favicon-32x32.png"
        />
        <link
          rel="icon"
          type="image/png"
          sizes="16x16"
          href="/favicon-16x16.png"
        />
        <link rel="manifest" href="/site.webmanifest" />
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
