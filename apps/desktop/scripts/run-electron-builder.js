#!/usr/bin/env node
// 通过 node 直接拉起 electron-builder CLI，并清掉 pnpm 注入的环境变量。
//
// 为什么不能直接 `electron-builder ...`：
//   electron-builder 26 的 node module collector 按「检测到的包管理器」求依赖图。
//   在 pnpm 环境里（npm_config_user_agent / npm_execpath 含 pnpm）它会跑
//   `pnpm list --prod` —— 但本工程根 node-linker=hoisted + stage 产物是 pnpm deploy
//   的 .pnpm 布局，pnpm list 给不出完整依赖图（实测只捞到几十个、丢了
//   @meshbot/server-agent 等工作区包）。
//   清掉这两个 env 后 detectPackageManagerByEnv 落到 npm；npm list 在 .pnpm 布局上
//   拿不到树 → electron-builder 回退到 traversal collector（纯磁盘遍历 package.json
//   的 dependencies），对 pnpm deploy 产出的完整树解析正确（含版本冲突的嵌套副本）。

const { spawnSync } = require("node:child_process");

const cliPath = require.resolve("electron-builder/cli.js");

const env = { ...process.env };
delete env.npm_config_user_agent;
delete env.npm_execpath;

const res = spawnSync(process.execPath, [cliPath, ...process.argv.slice(2)], {
  stdio: "inherit",
  env,
});
process.exit(res.status ?? 1);
