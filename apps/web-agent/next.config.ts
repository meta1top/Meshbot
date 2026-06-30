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
  env: isDev
    ? {
        NEXT_PUBLIC_SERVER_AGENT_URL:
          process.env.NEXT_PUBLIC_SERVER_AGENT_URL ?? "http://localhost:7727",
      }
    : {},
} as NextConfig;

export default nextConfig;
