import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    // 排除 tsc 编译产物：dist 里的 *.spec.js 是 CJS，require("vitest") 必崩，
    // 会制造约 20 个假 file 失败（曾迫使「跑 vitest 前必须 rm -rf dist」的舞步）。
    exclude: ["**/node_modules/**", "dist/**"],
  },
});
