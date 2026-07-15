import type { Config } from "jest";

/**
 * packages/web-common 独立 jest 配置。
 *
 * 根 jest 有意排除 packages/（前端不在其范围）；此处为前端共享逻辑
 * （如 api/client 的信封解包）单独提供测试通道。
 * testEnvironment 默认 node：被测的纯函数不依赖 DOM；tsconfig 指向本包
 * （含 DOM lib），保证 client.ts 中 window/localStorage 类型引用可编译。
 * `.tsx`（组件 render 测试，如 session-tree）用文件头 jest-environment 注释
 * 单文件覆盖为 jsdom，不改变其余纯函数测试的默认 node 环境。
 */
const config: Config = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: ".",
  roots: ["<rootDir>/src"],
  testMatch: ["**/?(*.)+(spec|test).ts?(x)"],
  testPathIgnorePatterns: ["/node_modules/", "/dist/"],
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: "<rootDir>/tsconfig.json" }],
  },
  // `@meshbot/design` 的桶装导出会传递引入 next-intl（纯 ESM，ts-jest 默认不转译
  // node_modules 会报 `Unexpected token 'export'`）；组件 render 测试不需要真实
  // i18n 行为，桩掉即可，见 jest.mocks/next-intl.ts 注释。
  moduleNameMapper: {
    "^next-intl$": "<rootDir>/jest.mocks/next-intl.ts",
  },
};

export default config;
