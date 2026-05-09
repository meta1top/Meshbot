import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";

const nextConfig: NextConfig = {
  output: !isDev ? "export" : undefined,
  assetPrefix: !isDev ? "." : undefined,
  transpilePackages: ["@anybot/design", "@anybot/common"],
  allowedDevOrigins: ["127.0.0.1", "localhost"],
} as NextConfig;

export default nextConfig;
