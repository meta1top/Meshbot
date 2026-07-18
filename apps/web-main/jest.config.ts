import type { Config } from "jest";

/**
 * apps/web-main 独立 jest 配置。
 *
 * 根 jest（node 环境、只转译 `.ts`）能覆盖大多数纯逻辑单测（如
 * `agent-avatar.spec.ts`），但 `session-transport.ts` 经
 * `@meshbot/web-common/session` 桶装导出会传递引入 JSX 组件
 * （`message-list.tsx`/`artifact-body.tsx` 等）与 `next-intl`（经
 * `@meshbot/design` 桶装导出再传递引入，纯 ESM，ts-jest 默认不转译
 * `node_modules` 会报 `Unexpected token 'export'`）——根配置既没有 `.tsx`
 * 转译也没有 next-intl 桩，加载不了这条依赖链。独立配置对齐
 * `packages/web-common/jest.config.ts` 的既有解法：本包专属
 * `tsconfig.jest.json`（`jsx: react-jsx`，供 ts-jest 把 JSX 编成可执行 JS；
 * 主 `tsconfig.json` 的 `jsx: preserve` 是给 Next.js 自身编译器用的，ts-jest
 * 直接吃会把 JSX 语法原样吐进输出 JS，Node 跑不了）+ `next-intl`
 * moduleNameMapper 桩。
 *
 * testEnvironment 默认 node：被测的是纯逻辑（socket 事件编排），不依赖
 * DOM；组件 render 测试如需要可在文件头用 `@jest-environment jsdom`
 * 注释单独覆盖（同 web-common 惯例）。
 */
const config: Config = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: ".",
  roots: ["<rootDir>/src"],
  testMatch: ["**/?(*.)+(spec|test).ts?(x)"],
  testPathIgnorePatterns: ["/node_modules/", "/.next/"],
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: "<rootDir>/tsconfig.jest.json" }],
  },
  moduleNameMapper: {
    "^next-intl$": "<rootDir>/jest.mocks/next-intl.ts",
    "^@/(.*)$": "<rootDir>/src/$1",
    // workspace 包统一映射到源码（而非各自的编译产物 dist/），与根
    // jest.config.js 的既有惯例一致：dist 产物多为纯 ESM，ts-jest 默认不转译
    // node_modules 会报 `Unexpected token 'export'`；映射到 src 让 ts-jest 用
    // 本配置的 tsconfig 统一转译一遍。
    "^@meshbot/web-common$": "<rootDir>/../../packages/web-common/src",
    "^@meshbot/web-common/(.*)$": "<rootDir>/../../packages/web-common/src/$1",
    "^@meshbot/design$": "<rootDir>/../../packages/design/src",
    "^@meshbot/design/(.*)$": "<rootDir>/../../packages/design/src/$1",
    "^@meshbot/types$": "<rootDir>/../../libs/types/src",
    "^@meshbot/types-agent$": "<rootDir>/../../libs/types-agent/src",
    "^@meshbot/types-main$": "<rootDir>/../../libs/types-main/src",
  },
};

export default config;
