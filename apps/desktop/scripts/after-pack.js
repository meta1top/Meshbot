const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

/**
 * 定位 staged（pnpm deploy 产物）的 node_modules——必须是 release-stage 那棵完整
 * 生产依赖树（~354 包、@meshbot/server-agent 是「实目录」），而非 apps/desktop 自己的
 * node_modules（仅 9 个条目、server-agent 是指向工作区的软链，仅本机可用、不可分发）。
 *
 * 鉴别关键：合格的树里 @meshbot/server-agent 是「实目录」。apps/desktop 那棵里它是软链，
 * 顺着软链 existsSync(dist/main.js) 也为真，会误判——所以必须用 lstat 排除软链。
 * 同时 __dirname 不可靠（pnpm deploy 会把 scripts 也拷进 release-stage/scripts，
 * electron-builder 可能从任一处加载本钩子），故按多候选探测，挑「server-agent 为实目录」
 * 的那棵；全不合格直接报错（绝不静默出残包）。
 */
function findStagedNodeModules(context) {
  const saRel = path.join("@meshbot", "server-agent");
  const candidates = [
    // electron-builder 的 appDir：--projectDir release-stage 下即 release-stage
    context.packager?.appDir
      ? path.join(context.packager.appDir, "node_modules")
      : null,
    path.join(__dirname, "..", "release-stage", "node_modules"),
    path.join(__dirname, "..", "node_modules"),
  ].filter(Boolean);
  for (const c of candidates) {
    const sa = path.join(c, saRel);
    let st;
    try {
      st = fs.lstatSync(sa);
    } catch {
      continue;
    }
    // 必须是实目录（非软链）且 dist/main.js 在
    if (
      st.isDirectory() &&
      !st.isSymbolicLink() &&
      fs.existsSync(path.join(sa, "dist", "main.js"))
    ) {
      return c;
    }
  }
  throw new Error(
    `[after-pack] 找不到「server-agent 为实目录」的 staged node_modules，候选: ${candidates.join(", ")}`,
  );
}

/**
 * 把 staged node_modules 手动拷进打好的 app 包。
 *
 * 为什么手动拷：electron-builder 26 在本工程既不能用 asar（fork 子进程带
 * ELECTRON_RUN_AS_NODE 读不了 asar），asar:false / asarUnpack 又收不进 node_modules
 * （实测为 0）。这里直接把 before-build 已重编好原生模块的 release-stage/node_modules
 * 整棵拷到 app 资源目录，fork 出来的 server-agent 才能在磁盘上解析依赖。
 */
function copyNodeModulesIntoApp(context) {
  const srcNm = findStagedNodeModules(context);
  // 各平台 app 资源根目录：mac 在 <App>.app/Contents/Resources/app，win/linux 在 resources/app
  const appName = context.packager.appInfo.productFilename;
  const resourcesDir =
    context.electronPlatformName === "darwin"
      ? path.join(context.appOutDir, `${appName}.app`, "Contents", "Resources")
      : path.join(context.appOutDir, "resources");
  const destNm = path.join(resourcesDir, "app", "node_modules");

  fs.rmSync(destNm, { recursive: true, force: true });
  fs.mkdirSync(destNm, { recursive: true });
  // 用 cp -R 而非 fs.cpSync：fs.cpSync 在含「指向树外/祖先的软链」的目录上会抛
  // ERR_FS_CP_EINVAL（且只拷前几个条目就中断、不致命 → 静默出残包）。hoisted 树正常
  // 时 cpSync 也能拷，但 cp -R 对各种软链布局更稳，整棵 357 个包都能拷全（软链原样
  // 保留，随后 pruneForCodesign 删 .bin 与悬空链）。构建宿主为 mac/linux，cp -R 始终可用。
  execFileSync("cp", ["-R", `${srcNm}/.`, `${destNm}/`], { stdio: "inherit" });
  pruneForCodesign(destNm);
  // 防回归哨兵：拷贝不完整时直接让构建失败，绝不静默出残包。
  const sentinel = path.join(destNm, "@meshbot", "server-agent", "dist", "main.js");
  if (!fs.existsSync(sentinel)) {
    throw new Error(
      `[after-pack] node_modules 拷贝不完整：缺 ${sentinel}（src=${srcNm}）`,
    );
  }
  console.log(`[after-pack] copied node_modules -> ${destNm}`);
}

/**
 * 清理会让 macOS codesign --deep --strict 报「invalid destination for symbolic
 * link in bundle」的软链：
 *   1) 所有 .bin 目录——里面是指向各包 bin 的软链，--prod 裁掉 devDep 后其中指向
 *      被裁包（如 electron / vitest）的软链变成悬空链；且运行时我们直接 fork
 *      main.js 绝对路径，根本不用 .bin。整目录删掉最干净。
 *   2) 兜底：递归删除任何剩余的悬空软链（目标已不存在）。
 * 保留 .pnpm 与 node_modules/<pkg> 的有效相对软链——它们是 isolated 布局的依赖解析骨架。
 */
function pruneForCodesign(root) {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) {
        // 悬空软链（目标不存在）→ 删除
        if (!fs.existsSync(full)) {
          fs.rmSync(full, { force: true });
        }
        continue;
      }
      if (e.isDirectory()) {
        if (e.name === ".bin") {
          fs.rmSync(full, { recursive: true, force: true });
          continue;
        }
        stack.push(full);
      }
    }
  }
}

exports.default = async function afterPack(context) {
  copyNodeModulesIntoApp(context);

  if (context.electronPlatformName !== "linux") return;

  const sandboxPath = path.join(context.appOutDir, "chrome-sandbox");
  if (fs.existsSync(sandboxPath)) {
    fs.unlinkSync(sandboxPath);
  }

  const execName = context.packager.executableName;
  const execPath = path.join(context.appOutDir, execName);
  const realExecPath = path.join(context.appOutDir, `${execName}.bin`);

  if (!fs.existsSync(execPath)) return;

  fs.renameSync(execPath, realExecPath);
  fs.writeFileSync(
    execPath,
    `#!/bin/bash\nexec "$(dirname "$0")/${execName}.bin" --no-sandbox "$@"\n`,
    { mode: 0o755 },
  );
};
