import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Anybot Platform",
  description: "Anybot Agent Management Platform",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
