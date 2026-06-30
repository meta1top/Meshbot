import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";

const nextConfig: NextConfig = {
  output: !isDev ? "export" : undefined,
  assetPrefix: !isDev ? "." : undefined,
  transpilePackages: [
    "@meshbot/design",
    "@meshbot/web-common",
    "@meshbot/types-agent",
  ],
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  // dev 期前端在独立 Next dev server（:3001），需显式指向自检后的 server-agent（默认 7727）；
  // 生产静态导出不注入 → resolveBaseURL 落到同源 window.location.origin。
  // 本地可建 apps/web-agent/.env.development（已 gitignore）覆盖此默认。
  // 注：Next.js 在求值本 config 前已把 .env.development 载入 process.env，
  // 故 `process.env.X ?? 默认` 会优先取 .env.development 的值（存在时）。
  env: isDev
    ? {
        NEXT_PUBLIC_SERVER_AGENT_URL:
          process.env.NEXT_PUBLIC_SERVER_AGENT_URL ?? "http://localhost:7727",
      }
    : {},
} as NextConfig;

export default nextConfig;
