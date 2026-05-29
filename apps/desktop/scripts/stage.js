#!/usr/bin/env node
// 把 desktop 及其所有运行时传递依赖扁平化拷贝到 release-stage/，
// 让 electron-builder 能在一个干净的 node_modules 树上工作。
//
// 为什么不用 `pnpm deploy`：
// pnpm v10+ 在没有 inject-workspace-packages=true 的情况下，
// deploy 只复制顶层声明的 workspace 包本身，不会递归解析 workspace 包的依赖。
// 开 inject 会破坏本地 dev workflow（lib 改动要重 install 才生效）。

const fs = require("node:fs");
const path = require("node:path");

const desktopDir = path.resolve(__dirname, "..");
const stageDir = path.join(desktopDir, "release-stage");
const stageNm = path.join(stageDir, "node_modules");

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

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

// 仅复制一个包"自己的"文件，跳过其内部 node_modules
// （传递依赖由顶层 dep walker 统一在 release-stage/node_modules/ 平铺）
function copyPackage(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const e of entries) {
    if (e.name === "node_modules") continue;
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isSymbolicLink()) {
      fs.cpSync(fs.realpathSync(s), d, { recursive: true, dereference: true });
    } else if (e.isDirectory()) {
      fs.cpSync(s, d, { recursive: true, dereference: true });
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

// 把 package.json 里的 workspace:* / workspace:^ / workspace:~ 替换为真实版本号。
// electron-builder 看到 workspace:* 会把整条依赖链跳过，所以必须改写。
function rewriteWorkspaceVersions(pkgJsonPath, resolvedVersions) {
  const pkg = readJson(pkgJsonPath);
  let changed = false;
  for (const field of [
    "dependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    if (!pkg[field]) continue;
    for (const [name, range] of Object.entries(pkg[field])) {
      if (typeof range !== "string" || !range.startsWith("workspace:"))
        continue;
      const version = resolvedVersions.get(name);
      if (!version) {
        console.error(
          `[stage] workspace dep "${name}" referenced from ${pkgJsonPath} but version unknown`,
        );
        process.exitCode = 1;
        continue;
      }
      pkg[field][name] = version;
      changed = true;
    }
  }
  if (changed) {
    fs.writeFileSync(pkgJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
  }
}

const seen = new Set();
// 走完一遍依赖图后，可以从这里查每个 workspace 包的真实版本号
const resolvedVersions = new Map();

// BFS 遍历依赖图：
// 浅层依赖（desktop 直接 dep）先被加入 seen，
// 避免被深层依赖（langchain 私有版本）抢先解析到不兼容的旧版本。
function walk(rootDir) {
  const queue = [rootDir];
  while (queue.length > 0) {
    const packageDir = queue.shift();
    let pkg;
    try {
      pkg = readJson(path.join(packageDir, "package.json"));
    } catch {
      continue;
    }
    const deps = {
      ...pkg.dependencies,
      ...pkg.peerDependencies,
      ...pkg.optionalDependencies,
    };

    for (const depName of Object.keys(deps)) {
      if (seen.has(depName)) continue;
      seen.add(depName);

      const depDir = findPackageDir(depName, packageDir);
      if (!depDir) {
        if (pkg.dependencies?.[depName]) {
          console.error(
            `[stage] cannot resolve required dep "${depName}" from ${packageDir}`,
          );
          process.exitCode = 1;
        } else {
          console.warn(
            `[stage] skip optional/peer "${depName}" (not installed)`,
          );
        }
        continue;
      }

      const depPkg = readJson(path.join(depDir, "package.json"));
      if (depPkg.version) resolvedVersions.set(depName, depPkg.version);

      copyPackage(depDir, path.join(stageNm, depName));
      queue.push(depDir);
    }
  }
}

// === main ===

fs.rmSync(stageDir, { recursive: true, force: true });
fs.mkdirSync(stageNm, { recursive: true });

// desktop 自己的入口文件
fs.cpSync(path.join(desktopDir, "dist"), path.join(stageDir, "dist"), {
  recursive: true,
  dereference: true,
});
fs.cpSync(path.join(desktopDir, "scripts"), path.join(stageDir, "scripts"), {
  recursive: true,
  dereference: true,
});
fs.copyFileSync(
  path.join(desktopDir, "electron-builder.yml"),
  path.join(stageDir, "electron-builder.yml"),
);
fs.copyFileSync(
  path.join(desktopDir, "package.json"),
  path.join(stageDir, "package.json"),
);

console.log("[stage] walking dependency graph from desktop...");
const t0 = Date.now();
walk(desktopDir);

const stats = fs.readdirSync(stageNm);
console.log(
  `[stage] copied ${stats.length} packages in ${Date.now() - t0}ms -> ${stageNm}`,
);

// 把所有 workspace:* 改写成真实版本号，
// 让 electron-builder 能完整跟随依赖图（包括传递依赖）。
console.log("[stage] rewriting workspace:* version refs...");
function rewriteAll(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const sub = path.join(dir, e.name);
    if (e.name.startsWith("@")) {
      rewriteAll(sub);
      continue;
    }
    const pj = path.join(sub, "package.json");
    if (fs.existsSync(pj)) rewriteWorkspaceVersions(pj, resolvedVersions);
  }
}
rewriteAll(stageNm);
rewriteWorkspaceVersions(path.join(stageDir, "package.json"), resolvedVersions);

if (process.exitCode) {
  console.error("[stage] failed");
  process.exit(process.exitCode);
}
