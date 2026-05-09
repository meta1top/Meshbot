import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  assetPrefix: ".",
  transpilePackages: ["@anybot/design", "@anybot/common"],
  allowedDevOrigins: ["127.0.0.1"],
};

export default nextConfig;
