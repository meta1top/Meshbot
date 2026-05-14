import type { Metadata } from "next";
import { IntlProvider } from "@/components/intl-provider";
import "./globals.css";

export const metadata: Metadata = {
  title: "MeshBot Platform",
  description: "MeshBot Agent Management Platform",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body>
        <IntlProvider>{children}</IntlProvider>
      </body>
    </html>
  );
}
