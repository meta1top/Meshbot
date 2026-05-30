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

// 默认只构建「当前 runner 的原生平台 + 原生架构」，原因：
//   1. 跨架构构建不可靠：本工程靠 before-build 把原生模块（better-sqlite3 / bcrypt）
//      electron-rebuild 到目标 ABI，但两个架构共享同一份 release-stage——同机连构 arm64
//      + x64 时第二轮 rebuild 不能干净替换，实测 x64 包里 bcrypt 仍是 arm64、且 codesign
//      失败。必须「一台机器只出一个架构」。
//   2. CI 用「每平台/架构一个 runner」的矩阵（macos-14=arm64 / macos-13=x64 /
//      windows=x64 / linux=x64），各自只构建本机即可拼出全平台产物。
// 关键：electron-builder 里裸 --arm64 / --x64 不会限制架构（实测仍出双架构），必须同时
// 带平台 flag（--mac --arm64 才真的只出 arm64）。所以这里平台 + 架构一起追加。
// 若调用方已显式传了平台 flag（特殊场景）则尊重，不再追加。
const PLATFORM_FLAGS = [
  "--mac",
  "--macos",
  "-m",
  "--win",
  "--windows",
  "--linux",
];
const passthrough = process.argv.slice(2);
const hasPlatform = passthrough.some((a) => PLATFORM_FLAGS.includes(a));

const platformFlag =
  process.platform === "darwin"
    ? "--mac"
    : process.platform === "win32"
      ? "--win"
      : "--linux";
const archFlag = process.arch === "arm64" ? "--arm64" : "--x64";
const args = hasPlatform
  ? passthrough
  : [...passthrough, platformFlag, archFlag];

const res = spawnSync(process.execPath, [cliPath, ...args], {
  stdio: "inherit",
  env,
});
process.exit(res.status ?? 1);
