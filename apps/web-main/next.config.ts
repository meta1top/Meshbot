import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@meshbot/design", "@meshbot/web-common"],
};

export default nextConfig;
