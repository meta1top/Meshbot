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
    // 强制 framework 包从单一物理路径解析，避免 pnpm 多 peer dep 树
    // 产生多份 @nestjs/typeorm 实例（同 token 不同 identity → Nest DI 解析失败）。
    "^@nestjs/typeorm$":
      "<rootDir>/apps/server-main/node_modules/@nestjs/typeorm",
    "^@nestjs/typeorm/(.*)$":
      "<rootDir>/apps/server-main/node_modules/@nestjs/typeorm/$1",
    "^typeorm$": "<rootDir>/apps/server-main/node_modules/typeorm",
    "^typeorm/(.*)$": "<rootDir>/apps/server-main/node_modules/typeorm/$1",
  },
  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      {
        tsconfig: "<rootDir>/tsconfig.base.json",
        isolatedModules: true,
      },
    ],
  },
  // 默认 5s 超时；事务测试可能更慢
  testTimeout: 15_000,
};

export default config;
