import type { Config } from "jest";

/**
 * packages/web-common 独立 jest 配置。
 *
 * 根 jest 有意排除 packages/（前端不在其范围）；此处为前端共享逻辑
 * （如 api/client 的信封解包）单独提供测试通道。
 * testEnvironment 用 node：被测的纯函数不依赖 DOM；tsconfig 指向本包
 * （含 DOM lib），保证 client.ts 中 window/localStorage 类型引用可编译。
 */
const config: Config = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: ".",
  roots: ["<rootDir>/src"],
  testMatch: ["**/?(*.)+(spec|test).ts"],
  testPathIgnorePatterns: ["/node_modules/", "/dist/"],
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "<rootDir>/tsconfig.json" }],
  },
};

export default config;
