import { themeScript } from "@meshbot/web-common";
import type { Metadata } from "next";
import { Hanken_Grotesk } from "next/font/google";
import { IntlProvider } from "@/components/intl-provider";
import { Providers } from "@/components/providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "MeshBot Platform",
  description: "MeshBot Agent Management Platform",
  // 图标资源与 web-agent 同源（public/ 下同一套文件），此前 web-main 从未声明过，
  // 浏览器标签页一直没有图标。放 root layout 而非落地页，让全站路由都覆盖到。
  icons: {
    icon: [
      { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
      { url: "/favicon.ico", sizes: "any" },
    ],
    apple: "/apple-touch-icon.png",
  },
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
