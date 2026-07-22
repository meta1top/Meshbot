import path from "node:path";
import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";

const nextConfig: NextConfig = {
  transpilePackages: ["@meshbot/design", "@meshbot/web-common"],
  // 生产容器化：standalone 自带最小 node_modules + server.js。
  output: "standalone",
  // monorepo：trace 根设到仓库根,standalone 才会带上 workspace 依赖（design/web-common/types...）。
  // 注：next.config.ts 会被 Next 当 CJS 载入执行,import.meta 在此上下文不可用,
  // 故用 process.cwd()（Dockerfile 里 `pnpm --filter @meshbot/web-main build` 的 cwd
  // 即 apps/web-main）代替 fileURLToPath(import.meta.url) 求目录。
  outputFileTracingRoot: path.join(process.cwd(), "..", ".."),
  // dev 期前端在独立 Next dev server（:3002），需显式指向 server-main（默认 :3200）；
  // 否则 mainApi baseURL 落到空串 → /api/* 打到前端自身源，全 404。
  // 生产走同源反代 → 不注入,baseURL 保持空串（相对路径）。
  // 本地可建 apps/web-main/.env.development（已 gitignore）覆盖此默认。
  // 注：Next.js 求值本 config 前已把 .env.development 载入 process.env，
  // 故 `process.env.X ?? 默认` 会优先取 .env.development 的值（存在时）。
  env: isDev
    ? {
        NEXT_PUBLIC_SERVER_MAIN_URL:
          process.env.NEXT_PUBLIC_SERVER_MAIN_URL ?? "http://localhost:3200",
      }
    : {},
};

export default nextConfig;
