import { themeScript } from "@meshbot/web-common";
import type { Metadata } from "next";
import { Hanken_Grotesk } from "next/font/google";
import { IntlProvider } from "@/components/intl-provider";
import { Providers } from "@/components/providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "MeshBot Platform",
  description: "MeshBot Agent Management Platform",
};

const hanken = Hanken_Grotesk({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-hanken",
});

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN" suppressHydrationWarning className={hanken.variable}>
      <head>
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: themeScript
          dangerouslySetInnerHTML={{ __html: themeScript }}
        />
      </head>
      <body>
        <IntlProvider>
          <Providers>{children}</Providers>
        </IntlProvider>
      </body>
    </html>
  );
}
