import fs from "node:fs";
import path from "node:path";

/** 默认剪枝目录：构建产物 / 依赖 / 版本控制，均不含待审业务源码。 */
const DEFAULT_PRUNE = new Set([
  "node_modules",
  "dist",
  "release-stage",
  ".next",
  ".turbo",
  ".git",
]);

export interface CollectOptions {
  /** 收集的扩展名，默认 [".ts"]；需要 tsx 时传 [".ts", ".tsx"]。 */
  exts?: string[];
  /** 追加剪枝目录（叠加在默认集合之上）。 */
  pruneDirs?: string[];
}

/**
 * 递归收集 root 下的源文件,返回绝对路径数组。
 *
 * 关键不变量:**不跟随符号链接目录** —— release-stage 的 .pnpm 软链会指回 desktop
 * 包自身形成自引用环,ts-morph 的 glob 爬虫会一头扎进去直到 ENAMETOOLONG 崩溃。
 * 这里用 fs.readdirSync(withFileTypes) 手动遍历并跳过软链,从根上断开环;产出的是
 * 显式文件列表(非 glob),交给 ts-morph 时不会再触发目录爬取。
 *
 * 默认排除 *.d.ts 与构建/依赖目录;spec/test 等过滤由各调用方按需自行处理。
 */
export function collectTsFiles(
  root: string,
  opts: CollectOptions = {},
): string[] {
  const exts = opts.exts ?? [".ts"];
  const prune = new Set(DEFAULT_PRUNE);
  for (const d of opts.pruneDirs ?? []) prune.add(d);
  const out: string[] = [];
  walk(root, exts, prune, out);
  return out;
}

function walk(
  dir: string,
  exts: string[],
  prune: Set<string>,
  out: string[],
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (prune.has(e.name)) continue;
      walk(full, exts, prune, out);
    } else if (e.isFile()) {
      if (e.name.endsWith(".d.ts")) continue;
      if (exts.some((ext) => e.name.endsWith(ext))) out.push(full);
    }
  }
}
