import type { Config } from "jest";

const config: Config = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: ".",
  roots: ["<rootDir>/libs", "<rootDir>/apps", "<rootDir>/scripts"],
  testMatch: ["**/?(*.)+(spec|test).ts"],
  // 排除 libs/agent / apps/cli-agent（用 vitest）和 packages/*（前端，不在 jest 范围）
  testPathIgnorePatterns: [
    "/node_modules/",
    "/dist/",
    "<rootDir>/libs/agent/",
    "<rootDir>/apps/cli-agent/",
    "<rootDir>/packages/",
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
