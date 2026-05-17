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
    // 强制 framework 包从单一物理路径解析，避免多份实例（同 token 不同
    // identity → Nest DI 解析失败）。`.npmrc` 启用 node-linker=hoisted 后
    // 依赖统一提升到根 node_modules（天然单实例），故指向根目录；旧的
    // apps/server-main/node_modules/* 在 hoisted 下是指向已失效 .pnpm
    // 虚拟目录的悬空符号链接，jest 无法解析（套件加载失败）。
    "^@nestjs/typeorm$": "<rootDir>/node_modules/@nestjs/typeorm",
    "^@nestjs/typeorm/(.*)$": "<rootDir>/node_modules/@nestjs/typeorm/$1",
    "^typeorm$": "<rootDir>/node_modules/typeorm",
    "^typeorm/(.*)$": "<rootDir>/node_modules/typeorm/$1",
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
