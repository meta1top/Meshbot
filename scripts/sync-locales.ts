#!/usr/bin/env tsx
import fs from "node:fs";
import path from "node:path";
/**
 * sync-locales —— 扫描前后端所有 t() / i18n.translate() 调用，
 * 对比 locale JSON 文件，输出 missing / orphan / asymmetric。
 *
 * 用法：
 *   pnpm sync:locales              # 只报告
 *   pnpm sync:locales -- --write   # 把 missing 在 zh/en 都补占位
 *   pnpm sync:locales -- --check   # 仅 diff；有不一致则 exit 1（用于 pre-commit）
 *   pnpm sync:locales -- --prune   # 删 orphan（危险，需 PR 评审）
 */
import { Project, SyntaxKind } from "ts-morph";

const ROOT = path.resolve(__dirname, "..");
const WEB_APPS = ["web-agent", "web-main"];
const SERVER_APPS = ["server-agent", "server-main"];

interface LocaleSet {
  app: string;
  locales: Record<string, Record<string, string>>; // {zh: {flatKey: value}, en: {...}}
}

function flatten(obj: any, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof obj[k] === "object" && obj[k] !== null) {
      Object.assign(out, flatten(obj[k], key));
    } else {
      out[key] = String(obj[k]);
    }
  }
  return out;
}

function unflatten(flat: Record<string, string>): any {
  const out: any = {};
  for (const [k, v] of Object.entries(flat)) {
    const parts = k.split(".");
    let cur = out;
    for (let i = 0; i < parts.length - 1; i++) {
      cur[parts[i]] ??= {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = v;
  }
  return out;
}

function loadWebMessages(app: string): LocaleSet | null {
  const dir = path.join(ROOT, "apps", app, "messages");
  if (!fs.existsSync(dir)) return null;
  const set: LocaleSet = { app, locales: {} };
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const lang = file.replace(".json", "");
    set.locales[lang] = flatten(
      JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8")),
    );
  }
  return set;
}

function loadServerI18n(app: string): LocaleSet | null {
  const dir = path.join(ROOT, "apps", app, "i18n");
  if (!fs.existsSync(dir)) return null;
  const set: LocaleSet = { app, locales: {} };
  for (const lang of fs.readdirSync(dir)) {
    const langDir = path.join(dir, lang);
    if (!fs.statSync(langDir).isDirectory()) continue;
    set.locales[lang] = {};
    for (const file of fs.readdirSync(langDir)) {
      if (!file.endsWith(".json")) continue;
      const ns = file.replace(".json", "");
      const flat = flatten(
        JSON.parse(fs.readFileSync(path.join(langDir, file), "utf-8")),
      );
      for (const [k, v] of Object.entries(flat)) {
        set.locales[lang][`${ns}.${k}`] = v;
      }
    }
  }
  return set;
}

function scanKeys(app: string, kind: "web" | "server"): Set<string> {
  const project = new Project({
    tsConfigFilePath: path.join(ROOT, "tsconfig.base.json"),
    skipAddingFilesFromTsConfig: true,
  });
  const glob = path.join(
    ROOT,
    "apps",
    app,
    kind === "web" ? "src/**/*.{ts,tsx}" : "src/**/*.ts",
  );
  project.addSourceFilesAtPaths(glob);

  const keys = new Set<string>();
  for (const sf of project.getSourceFiles()) {
    sf.forEachDescendant((node) => {
      if (node.getKind() !== SyntaxKind.CallExpression) return;
      const call = node.asKindOrThrow(SyntaxKind.CallExpression);
      const expr = call.getExpression().getText();
      const isT =
        expr === "t" ||
        expr.endsWith(".t") ||
        expr.endsWith(".translate") ||
        expr === "useTranslations" ||
        expr === "getTranslations";

      if (!isT) return;

      const args = call.getArguments();
      if (args.length === 0) return;
      const first = args[0];
      if (first.getKind() === SyntaxKind.StringLiteral) {
        keys.add(first.getText().slice(1, -1));
      } else if (first.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral) {
        keys.add(first.getText().slice(1, -1));
      }
      // 跳过动态 key（模板字符串含 ${}）
    });
  }
  return keys;
}

function diff(set: LocaleSet, usedKeys: Set<string>) {
  const langs = Object.keys(set.locales);
  const allDefined = new Set<string>();
  for (const l of langs) {
    for (const k of Object.keys(set.locales[l])) allDefined.add(k);
  }

  // 注意：useTranslations(namespace) 模式 — 收集到的"key"既可能是
  //   - 顶层 namespace 名（useTranslations("login")）
  //   - 完整路径（t("auth.alreadyRegistered")）
  // 二者都视为"被使用过的 prefix/full key"。missing 判定时只检查 full key 命中。

  const missing = [...usedKeys].filter((k) => {
    // 若 usedKey 是某个 defined key 的前缀（namespace 引用），视为"使用过"
    if (allDefined.has(k)) return false;
    for (const def of allDefined) if (def.startsWith(`${k}.`)) return false;
    return true;
  });

  const orphan = [...allDefined].filter((k) => {
    // defined 但代码没用到 — 不仅看完整 key，还要看任何 namespace prefix 命中
    if (usedKeys.has(k)) return false;
    for (const used of usedKeys) {
      if (k.startsWith(`${used}.`) || k === used) return false;
    }
    return true;
  });

  const asymmetric: string[] = [];
  if (langs.length >= 2) {
    for (const k of new Set([
      ...Object.keys(set.locales[langs[0]]),
      ...Object.keys(set.locales[langs[1]]),
    ])) {
      const inA = k in set.locales[langs[0]];
      const inB = k in set.locales[langs[1]];
      if (inA !== inB) asymmetric.push(k);
    }
  }
  return { missing, orphan, asymmetric };
}

const args = process.argv.slice(2);
const write = args.includes("--write");
const check = args.includes("--check");
const prune = args.includes("--prune");

let totalMissing = 0;
let totalAsymmetric = 0;

for (const app of WEB_APPS) {
  const set = loadWebMessages(app);
  if (!set) continue;
  const used = scanKeys(app, "web");
  const { missing, orphan, asymmetric } = diff(set, used);

  console.log(`\n=== web/${app} ===`);
  const definedCount = Object.keys(
    set.locales[Object.keys(set.locales)[0]] || {},
  ).length;
  console.log(`  used: ${used.size}, defined: ${definedCount}`);
  if (missing.length)
    console.log(
      `  MISSING (${missing.length}):`,
      missing.slice(0, 10),
      missing.length > 10 ? `... +${missing.length - 10} more` : "",
    );
  if (orphan.length)
    console.log(`  ORPHAN (${orphan.length}):`, orphan.slice(0, 10));
  if (asymmetric.length)
    console.log(
      `  ASYMMETRIC (${asymmetric.length}):`,
      asymmetric.slice(0, 10),
    );

  totalMissing += missing.length;
  totalAsymmetric += asymmetric.length;

  if (write && (missing.length || asymmetric.length)) {
    for (const lang of Object.keys(set.locales)) {
      for (const k of [...missing, ...asymmetric]) {
        if (!(k in set.locales[lang])) set.locales[lang][k] = "";
      }
      const file = path.join(ROOT, "apps", app, "messages", `${lang}.json`);
      fs.writeFileSync(
        file,
        JSON.stringify(unflatten(set.locales[lang]), null, 2) + "\n",
        "utf-8",
      );
      console.log(`  wrote: ${file}`);
    }
  }
  if (prune && orphan.length) {
    for (const lang of Object.keys(set.locales)) {
      for (const k of orphan) delete set.locales[lang][k];
      const file = path.join(ROOT, "apps", app, "messages", `${lang}.json`);
      fs.writeFileSync(
        file,
        JSON.stringify(unflatten(set.locales[lang]), null, 2) + "\n",
        "utf-8",
      );
      console.log(`  pruned: ${file}`);
    }
  }
}

for (const app of SERVER_APPS) {
  const set = loadServerI18n(app);
  if (!set) continue;
  const used = scanKeys(app, "server");
  const { missing, orphan, asymmetric } = diff(set, used);
  console.log(`\n=== server/${app} ===`);
  console.log(`  used: ${used.size}`);
  if (missing.length)
    console.log(`  MISSING (${missing.length}):`, missing.slice(0, 10));
  if (orphan.length)
    console.log(`  ORPHAN (${orphan.length}):`, orphan.slice(0, 10));
  if (asymmetric.length)
    console.log(
      `  ASYMMETRIC (${asymmetric.length}):`,
      asymmetric.slice(0, 10),
    );
  totalMissing += missing.length;
  totalAsymmetric += asymmetric.length;
}

if (check && (totalMissing > 0 || totalAsymmetric > 0)) {
  console.error(
    `\n[FAIL] missing=${totalMissing} asymmetric=${totalAsymmetric}; run \`pnpm sync:locales -- --write\` to fix`,
  );
  process.exit(1);
}

console.log(`\nDone (missing=${totalMissing}, asymmetric=${totalAsymmetric})`);
process.exit(0);
