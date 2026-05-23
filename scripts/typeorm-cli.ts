#!/usr/bin/env tsx
/**
 * 包装 typeorm-ts-node-commonjs：把短动词映射成 typeorm 的 migration:* 子命令，
 * 并自动追加 -d <datasource>。
 *
 * 用法（在 app 目录里，由 package.json migration script 转发）：
 *   tsx ../../scripts/typeorm-cli.ts <datasource-path> <verb> [args...]
 *
 * 支持的 verb：show / run / revert / generate / create
 * 例：
 *   pnpm migration:agent show
 *   pnpm migration:agent run
 *   pnpm migration:agent generate src/migrations/AddX
 */
import { spawnSync } from "node:child_process";

const VERB_TO_TYPEORM: Record<string, string> = {
  show: "migration:show",
  run: "migration:run",
  revert: "migration:revert",
  generate: "migration:generate",
  create: "migration:create",
};

const args = process.argv.slice(2).filter((a) => a !== "--");
const [dataSource, verb, ...rest] = args;

if (!dataSource || !verb) {
  console.error(
    `Usage: typeorm-cli.ts <datasource-path> <verb> [args...]\nverbs: ${Object.keys(VERB_TO_TYPEORM).join(", ")}`,
  );
  process.exit(1);
}

const subcommand = VERB_TO_TYPEORM[verb];
if (!subcommand) {
  console.error(
    `Unknown verb: ${verb}\nverbs: ${Object.keys(VERB_TO_TYPEORM).join(", ")}`,
  );
  process.exit(1);
}

const result = spawnSync(
  "typeorm-ts-node-commonjs",
  [subcommand, "-d", dataSource, ...rest],
  {
    stdio: "inherit",
    shell: false,
    env: {
      ...process.env,
      TS_NODE_COMPILER_OPTIONS: JSON.stringify({
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
        target: "ES2022",
        module: "commonjs",
        moduleResolution: "node",
        esModuleInterop: true,
      }),
    },
    cwd: process.cwd(),
  },
);

process.exit(result.status ?? 1);
