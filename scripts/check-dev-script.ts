#!/usr/bin/env tsx
/**
 * check-dev-script: 确保「以 dist 编译产物被消费、且被其它 workspace 包依赖」的包
 * 都声明了 `dev` 脚本。
 *
 * 背景（真实事故）：新增的 @meshbot/assets 漏了 `dev` 脚本。`turbo run dev --filter=X...`
 * 只会跑每个依赖包「自己的 `dev` 任务」，没有 `dev` 任务的包会被静默跳过 → 它的
 * `dist/` 在 watch 模式下永不生成 → 所有 import 它的包报 `Cannot find module`，并连带
 * 上游包无法重建。纯 dev 流程在干净机器上必然踩坑（build 流程因 build 脚本侥幸不报）。
 *
 * 判定一个包「必须有 dev」当且仅当：
 *   A. 入口（main / types / typings）指向 dist/ —— 即作为编译产物被消费（需要先构建）；且
 *   B. 至少被另一个 workspace 包通过 dependencies 依赖 —— 即它在 dev watch 链路里。
 *
 * 反例豁免：@meshbot/design 入口指向 ./src（被 Next.js transpilePackages 直接吃源码，
 * build 是 no-op），不走 dist，故不需要 dev 任务。
 *
 * 用法：
 *   pnpm check:dev-script               扫描全仓
 *   pnpm check:dev-script -- --strict   发现违规时 exit 1（CI 用）
 */
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "..");

/** workspace 包扫描目录，与 pnpm-workspace.yaml 的 packages globs 对齐。 */
const WORKSPACE_GLOBS = ["apps", "libs", "packages"];

export interface PackageManifest {
  name?: string;
  main?: string;
  types?: string;
  typings?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
}

export interface PkgInfo {
  /** 包名（@meshbot/xxx） */
  name: string;
  /** 解析后的 package.json */
  pkg: PackageManifest;
}

export interface DevScriptViolation {
  name: string;
  reason: string;
}

/** 入口字段是否指向 dist/ —— 即「以编译产物被消费」。 */
function isConsumedFromDist(pkg: PackageManifest): boolean {
  const entries = [pkg.main, pkg.types, pkg.typings].filter(
    (v): v is string => typeof v === "string",
  );
  return entries.some((e) => /(^|\/)dist\//.test(e));
}

/**
 * 核心检查逻辑；接受 PkgInfo[]，便于单测注入虚拟 manifest。
 */
export function runDevScriptCheck(packages: PkgInfo[]): DevScriptViolation[] {
  const names = new Set(packages.map((p) => p.name));

  // 谁被哪些 workspace 包依赖
  const dependedBy = new Map<string, string[]>();
  for (const p of packages) {
    for (const dep of Object.keys(p.pkg.dependencies ?? {})) {
      if (!names.has(dep)) continue;
      const list = dependedBy.get(dep) ?? [];
      list.push(p.name);
      dependedBy.set(dep, list);
    }
  }

  const violations: DevScriptViolation[] = [];

  for (const p of packages) {
    const hasDev = typeof p.pkg.scripts?.dev === "string";
    if (hasDev) continue;

    const consumers = dependedBy.get(p.name) ?? [];
    if (consumers.length === 0) continue;
    if (!isConsumedFromDist(p.pkg)) continue;

    violations.push({
      name: p.name,
      reason: `以 dist 产物被 ${consumers.join(", ")} 依赖，但缺少 dev 脚本；turbo run dev 会跳过它，依赖方在 watch 模式下将解析失败`,
    });
  }

  return violations;
}

/** 收集仓库内全部 workspace 包的 manifest。 */
function collectPackages(root: string): PkgInfo[] {
  const out: PkgInfo[] = [];
  for (const glob of WORKSPACE_GLOBS) {
    const base = path.join(root, glob);
    if (!fs.existsSync(base)) continue;
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = path.join(base, entry.name, "package.json");
      if (!fs.existsSync(manifestPath)) continue;
      const pkg = JSON.parse(
        fs.readFileSync(manifestPath, "utf-8"),
      ) as PackageManifest;
      if (!pkg.name) continue;
      out.push({ name: pkg.name, pkg });
    }
  }
  return out;
}

// ---- CLI 入口
function main() {
  const isStrict = process.argv.includes("--strict");

  const packages = collectPackages(ROOT);
  const violations = runDevScriptCheck(packages);

  if (violations.length === 0) {
    console.log(
      "[check:dev-script] OK — 所有 dist 产物消费型依赖包均声明了 dev 脚本",
    );
    process.exit(0);
  }

  for (const v of violations) {
    console.error(`[check:dev-script] FAIL: ${v.name} — ${v.reason}`);
  }

  if (isStrict) process.exit(1);
}

// 仅作为 CLI 直接运行时执行 main()；被 spec import 时不触发（避免误扫真仓库）。
if (require.main === module) {
  main();
}
