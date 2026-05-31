#!/usr/bin/env tsx
/**
 * rebuild-native —— 把本地 dev 树里的原生模块（better-sqlite3 / bcrypt）从
 * 「Electron ABI」复位回「当前系统 Node ABI」，让本地开发能继续。
 *
 * 为什么需要它：
 *   `pnpm pkg:app` 在 before-build.js 里对 release-stage 跑 @electron/rebuild
 *   (-w better-sqlite3,bcrypt)。pnpm 的 side-effects-cache 把编译好的 .node 从全局
 *   store 硬链进各处——dev 树与 release-stage 的 build/Release/*.node 共享同一个 store
 *   inode；node-gyp 原地覆盖该 inode 时，dev 树的原生模块被一起悄悄改成 Electron ABI。
 *   之后 `pnpm dev:server-agent` / `pnpm test`（系统 Node）就会报 NODE_MODULE_VERSION
 *   失配而起不来。本脚本把这两个模块换回系统 Node 能加载的产物。
 *
 * 两个模块的复位方式不同（不能一律 `pnpm rebuild`）：
 *   - better-sqlite3：靠 prebuild-install 下载「对应当前 Node ABI」的预编译产物。
 *     `pnpm rebuild better-sqlite3` 重跑 install（prebuild-install || node-gyp），把
 *     build/Release 换回系统 Node 版本（pattern 匹配，覆盖所有已装版本，如 11.x / 12.x）。
 *   - bcrypt：用 node-gyp-build + N-API 预编译（prebuilds/<platform>-<arch>/bcrypt.node，
 *     跨 Node/Electron 通用）。node-gyp-build 解析时 build/Release 优先于 prebuilds，
 *     pkg:app 留下的 build/Release 会遮蔽正确的 N-API 预编译。而 `pnpm rebuild bcrypt`
 *     实测会编出错误架构（arm64 机器上产 x86_64）。所以直接删掉 build/ 目录、让
 *     node-gyp-build 回落到自带的 N-API 预编译即可（无需编译，最稳）。
 *
 * 用法：pnpm rebuild:native
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");

/** 用拉起本脚本的那个 pnpm（npm_execpath）跑子命令，避开 PATH / Windows .cmd / shell 引号坑。 */
function runPnpm(args: string[]): void {
  const pnpm = process.env.npm_execpath;
  if (pnpm) {
    execFileSync(process.execPath, [pnpm, ...args], {
      cwd: ROOT,
      stdio: "inherit",
    });
    return;
  }
  // 直接 `tsx scripts/rebuild-native.ts`（非 pnpm 脚本上下文）时回落到 PATH 里的 pnpm
  execFileSync("pnpm", args, {
    cwd: ROOT,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
}

// 1) better-sqlite3：重跑 install 脚本，prebuild-install 拉回系统 Node 的预编译。
console.log("[rebuild:native] pnpm rebuild better-sqlite3 ...");
runPnpm(["rebuild", "better-sqlite3"]);

// 2) bcrypt：删掉所有版本的 build/ 目录，让 node-gyp-build 回落到 N-API 预编译。
const pnpmDir = path.join(ROOT, "node_modules", ".pnpm");
const bcryptBuildDirs = fs.existsSync(pnpmDir)
  ? fs
      .readdirSync(pnpmDir)
      .filter((d) => d.startsWith("bcrypt@"))
      .map((d) => path.join(pnpmDir, d, "node_modules", "bcrypt", "build"))
      .filter((p) => fs.existsSync(p))
  : [];
for (const dir of bcryptBuildDirs) {
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(
    `[rebuild:native] removed ${path.relative(ROOT, dir)}（回落到 N-API 预编译）`,
  );
}
if (bcryptBuildDirs.length === 0) {
  console.log("[rebuild:native] bcrypt 无 build/ 残留，已是预编译状态");
}

// 3) 哨兵校验：在系统 Node 里把两个模块真加载一遍，失败就吼出来（绝不静默放过半坏的树）。
const require = createRequire(
  path.join(ROOT, "apps", "server-agent", "package.json"),
);
for (const mod of ["better-sqlite3", "bcrypt"]) {
  try {
    require(mod);
    console.log(`[rebuild:native] ${mod} ✓ 系统 Node 可加载`);
  } catch (err) {
    console.error(
      `[rebuild:native] ${mod} ✗ 仍无法在系统 Node 加载：\n${(err as Error).message}`,
    );
    process.exit(1);
  }
}

console.log("[rebuild:native] 完成，本地开发可继续。");
