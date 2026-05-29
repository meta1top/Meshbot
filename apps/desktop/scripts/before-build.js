const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

// 仅对 release-stage（stage.js 产物）里的原生模块做 Electron ABI rebuild。
// 根 node_modules 不受影响，本地 server-agent (系统 Node) 不会被破坏。
//
// electron-builder BeforeBuildContext: { appDir, electronVersion, platform, arch }
//
// 注意：本文件被 stage.js 复制到 release-stage/scripts/ 后由 electron-builder 调用，
// __dirname 会指向 release-stage/scripts/——而非源 apps/desktop/scripts/。
// 需要往上找到工作区根才能拿到 hoisted 的 electron-rebuild 二进制。
function findElectronRebuildBin(startDir) {
  let cur = startDir;
  while (true) {
    const candidate = path.join(
      cur,
      "node_modules",
      ".bin",
      "electron-rebuild",
    );
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

exports.default = async function beforeBuild(context) {
  const targetDir = context.appDir;
  const electronVersion = context.electronVersion;
  const arch = context.arch;

  const rebuildBin = findElectronRebuildBin(__dirname);
  if (!rebuildBin) {
    throw new Error(
      "[before-build] electron-rebuild binary not found in any node_modules/.bin walking up from " +
        __dirname,
    );
  }

  console.log(
    `[before-build] electron-rebuild target=${targetDir} electron@${electronVersion} arch=${arch}`,
  );

  execSync(
    [
      `"${rebuildBin}"`,
      `-m "${targetDir}"`,
      "-f",
      "-w better-sqlite3,bcrypt",
      `-v ${electronVersion}`,
      `--arch ${arch}`,
    ].join(" "),
    { cwd: targetDir, stdio: "inherit" },
  );

  // 返回 false 让 electron-builder 跳过自带的 install-app-deps
  return false;
};
