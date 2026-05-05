import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  transpilePackages: ["@anybot/design", "@anybot/common"],
};

export default nextConfig;
