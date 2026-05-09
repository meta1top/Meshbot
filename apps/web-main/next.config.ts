import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@meshbot/design", "@meshbot/common"],
};

export default nextConfig;
