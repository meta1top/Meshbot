#!/usr/bin/env node
// 用 pnpm deploy 生成「自洽的」node_modules 后交给 electron-builder。
//
// 为什么不再手搓扁平拷贝（旧实现）：
//   1. 本仓库 .npmrc 设了 node-linker=hoisted，根 node_modules 是 npm 式扁平树，
//      版本冲突靠「依赖方本地 node_modules 里嵌套另一版本」解决。旧 stage.js 的
//      copyPackage 跳过嵌套 node_modules，把这些冲突副本丢了（如 chalk 需要
//      ansi-styles@4，扁平层却只剩 ansi-styles@6），产出的依赖树不完整。
//   2. electron-builder 26 的 node module collector 对 pnpm 工程是跑
//      `pnpm list --prod --json` 来求依赖图的；手搓树没有 lockfile / .pnpm 状态，
//      pnpm list 给不出正确结果（只会捞到几个 hoist 到顶层的传递依赖），导致
//      asar 里几乎没有 node_modules。
//
// pnpm deploy（--legacy 绕开 v10+ 默认要求 inject-workspace-packages 的限制）
// 产出一个带 .pnpm 存储 + 正确版本嵌套的自洽工程，electron-builder 的 pnpm
// collector 能原生识别。

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const desktopDir = path.resolve(__dirname, "..");
const stageDir = path.join(desktopDir, "release-stage");

// 直接扫描 node_modules（不用 require.resolve 是因为有些包用 exports 字段挡掉 package.json 路径）
function findPackageDir(depName, fromDir) {
  let cur = fromDir;
  while (true) {
    const candidate = path.join(cur, "node_modules", depName);
    if (fs.existsSync(candidate)) {
      return fs.realpathSync(candidate);
    }
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

// === main ===

// --config.node-linker=hoisted：产出「扁平、几乎无符号链接」的 node_modules。
//   - 顶层全是实文件目录，工作区包 @meshbot/server-agent 是实目录（不是软链）。
//     默认 isolated 布局会把 @meshbot/* 链成指向 .pnpm 的相对软链，after-pack 拷贝 +
//     codesign 清链后会丢包（实测 server-agent 时有时无、顶层只剩 3 个）→ 启动 MODULE_NOT_FOUND。
//   - 仅剩 .bin 里的软链，after-pack 会整目录删掉（运行时 fork 不依赖 .bin）。
//   - --prod 正确排除 devDependencies（electron / vitest 等不进树，避免嵌套 Electron.app
//     的框架软链破坏 codesign --deep）；--legacy 绕开 v10+ inject-workspace-packages 限制。
console.log(
  "[stage] pnpm deploy --prod --legacy (hoisted) -> release-stage ...",
);
fs.rmSync(stageDir, { recursive: true, force: true });
execSync(
  `pnpm --filter @meshbot/desktop deploy --prod --legacy --config.node-linker=hoisted "${stageDir}"`,
  { cwd: desktopDir, stdio: "inherit" },
);

// 图标资源（buildResources）：pnpm deploy 受 package.json files 字段约束、不保证带上
// build/，这里显式把图标拷进 release-stage/build，供 electron-builder.yml 的 icon 路径解析。
const buildSrc = path.join(desktopDir, "build");
const buildDest = path.join(stageDir, "build");
fs.mkdirSync(buildDest, { recursive: true });
for (const icon of ["icon.icns", "icon.ico", "icon.png"]) {
  fs.copyFileSync(path.join(buildSrc, icon), path.join(buildDest, icon));
}
console.log("[stage] copied build/ icons -> release-stage/build");

// electron 是 devDependency，--prod deploy 不会装进 release-stage/node_modules；
// electron-builder 需要一个「固定」的 electron 版本号去下载对应二进制（package.json
// 里是 "^41" range，电不能用）。这里解析真实安装版本写进 staged electron-builder.yml
// 的 electronVersion 字段，无需 node_modules/electron 存在。
const electronDir = findPackageDir("electron", desktopDir);
if (!electronDir) {
  console.error("[stage] cannot resolve electron to determine version");
  process.exit(1);
}
const electronVersion = JSON.parse(
  fs.readFileSync(path.join(electronDir, "package.json"), "utf8"),
).version;
// electron-builder 的 pnpm collector 会在 release-stage 里跑 `pnpm list` 求依赖图。
// pnpm 跑任何命令前的 verify-deps-before-run 会拿这个自洽工程跟「共享 workspace
// lockfile」对比、判定 node_modules 失配，于是尝试 `pnpm install --production` 并
// 想清空 node_modules——无 TTY 确认就直接 ERR_PNPM_ABORTED_REMOVE_MODULES_DIR 失败。
// 这里给 release-stage 单独放一份 .npmrc 关掉该检查，pnpm list 就只读已部署的状态。
fs.writeFileSync(
  path.join(stageDir, ".npmrc"),
  "verify-deps-before-run=false\n",
);

const ymlPath = path.join(stageDir, "electron-builder.yml");
let yml = fs.readFileSync(ymlPath, "utf8");
if (!/^electronVersion:/m.test(yml)) {
  yml = `electronVersion: ${electronVersion}\n${yml}`;
  fs.writeFileSync(ymlPath, yml);
  console.log(`[stage] pinned electronVersion: ${electronVersion}`);
}

console.log("[stage] done");
