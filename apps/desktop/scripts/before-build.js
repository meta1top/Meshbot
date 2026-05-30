const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

// 仅对 release-stage（stage.js 产物）里的原生模块做 Electron ABI rebuild。
// 根 node_modules 不受影响，本地 server-agent (系统 Node) 不会被破坏。
//
// electron-builder BeforeBuildContext: { appDir, electronVersion, platform, arch }
//
// 注意：本文件被 pnpm deploy 复制到 release-stage/scripts/ 后由 electron-builder 调用，
// __dirname 指向 release-stage/scripts/。@electron/rebuild 是 devDep、不在 --prod 的
// release-stage 树里，但 require.resolve 会从这里向上走 node_modules 命中
// apps/desktop/node_modules（完整安装）。

// 解析出 @electron/rebuild 的 cli.js 绝对路径。
// 不能直接 require.resolve("@electron/rebuild/lib/cli.js")——该包 exports 字段只暴露
// ./lib/main.js，子路径会被 ERR_PACKAGE_PATH_NOT_EXPORTED 挡掉。改为解析包入口
// （exports 允许）→ 推出包根 → 从其 package.json 的 bin 读 cli 相对路径。
function resolveRebuildCli() {
  const mainEntry = require.resolve("@electron/rebuild"); // → <pkg>/lib/main.js
  const pkgRoot = path.dirname(path.dirname(mainEntry));
  const pj = JSON.parse(
    fs.readFileSync(path.join(pkgRoot, "package.json"), "utf8"),
  );
  const binRel =
    typeof pj.bin === "string" ? pj.bin : pj.bin["electron-rebuild"];
  return path.join(pkgRoot, binRel);
}

exports.default = async function beforeBuild(context) {
  const targetDir = context.appDir;
  const electronVersion = context.electronVersion;
  const arch = context.arch;

  // 用 node 直接跑 @electron/rebuild 的 cli.js，而非 .bin/electron-rebuild：
  // 后者在 Windows 上是 .cmd 包装、裸名不可执行，且 execSync 拼 shell 字符串有引号坑。
  // execFileSync(process.execPath, [cli, ...args]) 不经 shell，跨平台一致。
  const rebuildCli = resolveRebuildCli();

  console.log(
    `[before-build] electron-rebuild target=${targetDir} electron@${electronVersion} arch=${arch}`,
  );

  execFileSync(
    process.execPath,
    [
      rebuildCli,
      "-m",
      targetDir,
      "-f",
      "-w",
      "better-sqlite3,bcrypt",
      "-v",
      electronVersion,
      "--arch",
      arch,
    ],
    { cwd: targetDir, stdio: "inherit" },
  );

  // 返回 false 让 electron-builder 跳过自带的 install-app-deps
  return false;
};
