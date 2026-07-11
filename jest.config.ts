import type { Config } from "jest";

const config: Config = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: ".",
  roots: ["<rootDir>/libs", "<rootDir>/apps", "<rootDir>/scripts"],
  testMatch: ["**/?(*.)+(spec|test).ts"],
  // 排除 libs/agent / apps/cli（用 vitest）和 packages/*（前端，不在 jest 范围）
  testPathIgnorePatterns: [
    "/node_modules/",
    "/dist/",
    "<rootDir>/libs/agent/",
    "<rootDir>/apps/cli/",
    "<rootDir>/packages/",
    // 前端集成测试：为测 dispatchGlobalEvent 纯函数却传递性引入整条 atom 图
    // （@/atoms/im → auth → jotai-tanstack-query）。jotai/jotai-tanstack-query 是
    // 纯 ESM 包，本后端 jest（node + ts-jest，无 ESM/jsdom transform）无法加载，
    // 该测试从未在 CI 跑通。web-agent 前端测试应迁到独立的 jsdom+ESM runner
    // （如 next/jest 多 project 配置），届时移除本行。
    "<rootDir>/apps/web-agent/src/hooks/use-global-events.spec.ts",
  ],
  moduleNameMapper: {
    "^@meshbot/common$": "<rootDir>/libs/common/src",
    "^@meshbot/common/(.*)$": "<rootDir>/libs/common/src/$1",
    "^@meshbot/main$": "<rootDir>/libs/main/src",
    "^@meshbot/main/(.*)$": "<rootDir>/libs/main/src/$1",
    "^@meshbot/types$": "<rootDir>/libs/types/src",
    "^@meshbot/types-agent$": "<rootDir>/libs/types-agent/src",
    "^@meshbot/types-main$": "<rootDir>/libs/types-main/src",
    "^@meshbot/assets$": "<rootDir>/libs/assets/src",
    "^@meshbot/assets/(.*)$": "<rootDir>/libs/assets/src/$1",
    "^@meshbot/web-common$": "<rootDir>/packages/web-common/src",
    "^@meshbot/web-common/(.*)$": "<rootDir>/packages/web-common/src/$1",
    // web-agent tsconfig path alias（供 apps/web-agent 下的单测使用）
    "^@/(.*)$": "<rootDir>/apps/web-agent/src/$1",
    // 强制 framework 包从单一物理路径解析，避免多份实例（同 token 不同
    // identity → Nest DI 解析失败）。hoisted 模式下 @nestjs/typeorm 提升到根
    // node_modules，直接指向根路径即可。typeorm 同理。
    "^@nestjs/typeorm$": "<rootDir>/node_modules/@nestjs/typeorm",
    "^@nestjs/typeorm/(.*)$": "<rootDir>/node_modules/@nestjs/typeorm/$1",
    "^typeorm$": "<rootDir>/node_modules/typeorm",
    "^typeorm/(.*)$": "<rootDir>/node_modules/typeorm/$1",
    // @vscode/ripgrep 是 ESM-only：jest 经模块图传递 import 到它会报「Cannot use
    // import statement outside a module」（jest 不跑 grep 测试，libs/agent 走 vitest）。
    // 换成 CommonJS 桩解开这条 import 链。
    "^@vscode/ripgrep$": "<rootDir>/test/mocks/vscode-ripgrep.js",
    // socket.io-client 同为 ESM-only：CJS jest 解析不了 export map。stub 满足
    // im-relay-client 的 `import { io }`；相关 suite 都 mock 上层 service。
    "^socket\\.io-client$": "<rootDir>/test/mocks/socket-io-client.js",
  },
  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      {
        tsconfig: "<rootDir>/tsconfig.base.json",
        // isolatedModules: true 已迁移到 tsconfig.base.json
        // （ts-jest v30 起从 transformer options 弃用此项）
      },
    ],
  },
  // 默认 5s 超时；事务测试可能更慢
  testTimeout: 15_000,
};

export default config;
