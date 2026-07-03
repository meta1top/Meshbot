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
import {
  type Identifier,
  Node,
  Project,
  type SourceFile,
  SyntaxKind,
  VariableDeclarationKind,
} from "ts-morph";

const ROOT = path.resolve(__dirname, "..");
const WEB_APPS = ["web-agent", "web-main"];
const SERVER_APPS = ["server-agent", "server-main"];

interface LocaleSet {
  app: string;
  locales: Record<string, Record<string, string>>; // {zh: {flatKey: value}, en: {...}}
}

/** 把嵌套的 locale 对象拍平成 `"a.b.c": "值"` 的单层 Record（key 为完整路径）。 */
export function flatten(obj: any, prefix = ""): Record<string, string> {
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

/** {@link flatten} 的逆操作：把 `"a.b.c": "值"` 的单层 Record 还原成嵌套对象。 */
export function unflatten(flat: Record<string, string>): any {
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

/** 提取字符串字面量 / 无替换模板字面量的文本；动态表达式（变量、模板插值）返回 null。 */
function extractLiteralText(node: Node): string | null {
  if (node.getKind() === SyntaxKind.StringLiteral) {
    return node.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralText();
  }
  if (node.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral) {
    return node
      .asKindOrThrow(SyntaxKind.NoSubstitutionTemplateLiteral)
      .getLiteralText();
  }
  return null;
}

/**
 * 解析标识符调用（如 `t("x")` / `tNav("x")`）里 `t` 这个标识符的命名空间来源。
 *
 * 沿标识符的定义节点找到其 `const` 变量声明，展开可能的 `await`，判断初始化表达式
 * 是否为 `useTranslations(ns?)` / `getTranslations(ns?)` 调用：
 * - 无首参（`useTranslations()`）→ 视为无命名空间，`resolved: true, namespace: null`
 *   （调用方传入的 key 本身已是完整路径，原样使用）。
 * - 首参是字符串字面量 → `resolved: true, namespace: <字面量>`。
 * - 首参是动态表达式（无法确定具体 namespace 字符串）→ 视为不可解析，跳过该定义
 *   继续找其它定义；全部找不到则返回 `resolved: false`。
 *
 * 解析不到（非 `useTranslations`/`getTranslations` 初始化、非 `const` 声明、
 * 函数参数透传、动态 namespace 等）一律返回 `resolved: false`，由调用方决定
 * 是否退回裸键收集（历史行为，避免回归）。
 */
export function resolveTranslatorNamespace(identifier: Identifier): {
  resolved: boolean;
  namespace: string | null;
} {
  for (const def of identifier.getDefinitionNodes()) {
    const varDecl = Node.isVariableDeclaration(def)
      ? def
      : def.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
    if (!varDecl) continue;

    // 只信任 const 声明：let/var 存在被重新赋值的可能，声明处初始化器不代表调用点的
    // 实际值，重赋值场景应退回不可解析（历史裸键兜底）。
    const declList = varDecl.getFirstAncestorByKind(
      SyntaxKind.VariableDeclarationList,
    );
    if (
      !declList ||
      declList.getDeclarationKind() !== VariableDeclarationKind.Const
    )
      continue;

    let init = varDecl.getInitializer();
    if (!init) continue;
    if (init.getKind() === SyntaxKind.AwaitExpression) {
      init = init.asKindOrThrow(SyntaxKind.AwaitExpression).getExpression();
    }
    const call = init.asKind(SyntaxKind.CallExpression);
    if (!call) continue;

    const calleeName = call.getExpression().getText();
    if (calleeName !== "useTranslations" && calleeName !== "getTranslations")
      continue;

    const callArgs = call.getArguments();
    if (callArgs.length === 0) return { resolved: true, namespace: null };

    const ns = extractLiteralText(callArgs[0]);
    if (ns === null) continue; // 动态 namespace 参数，无法确定，视为不可解析
    return { resolved: true, namespace: ns };
  }
  return { resolved: false, namespace: null };
}

/**
 * 扫描单个源文件，收集其中所有翻译调用引用到的 locale key（完整路径）。
 *
 * 三种调用形态：
 * - `xxx.t(...)` / `xxx.translate(...)`（属性访问，多为服务端 `i18n.translate`）——
 *   首参字面量本身已是完整 key，原样收集，不做命名空间推导。
 * - `useTranslations("ns")` / `getTranslations("ns")` 本身——首参字面量当作被引用的
 *   namespace 前缀收集（供 diff() 的前缀命中判定使用）。
 * - 裸标识符调用 `t("x")` / `tNav("x")` 等——通过 {@link resolveTranslatorNamespace}
 *   解析该标识符声明的初始化表达式：能解析到 `useTranslations`/`getTranslations`
 *   命名空间则拼成 `ns.x`（或无命名空间时原样用 `x`）收集；解析不到时，仅对字面量
 *   标识符名 `t` 退回收裸键（历史行为，避免回归），其余标识符名跳过——避免把无关
 *   函数调用（如 `useState("initial")`）误判为翻译键，反而制造假 missing。
 */
export function collectUsedKeysFromFile(sf: SourceFile): Set<string> {
  const keys = new Set<string>();
  sf.forEachDescendant((node) => {
    if (node.getKind() !== SyntaxKind.CallExpression) return;
    const call = node.asKindOrThrow(SyntaxKind.CallExpression);
    const calleeExpr = call.getExpression();
    const exprText = calleeExpr.getText();

    const args = call.getArguments();
    if (args.length === 0) return;
    const literal = extractLiteralText(args[0]);
    if (literal === null) return; // 跳过动态 key（模板字符串含 ${}、变量等）

    if (exprText.endsWith(".t") || exprText.endsWith(".translate")) {
      keys.add(literal);
      return;
    }
    if (exprText === "useTranslations" || exprText === "getTranslations") {
      keys.add(literal);
      return;
    }

    const identifier = calleeExpr.asKind(SyntaxKind.Identifier);
    if (!identifier) return;

    const resolved = resolveTranslatorNamespace(identifier);
    if (resolved.resolved) {
      keys.add(
        resolved.namespace ? `${resolved.namespace}.${literal}` : literal,
      );
    } else if (exprText === "t") {
      keys.add(literal);
    }
  });
  return keys;
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
    for (const k of collectUsedKeysFromFile(sf)) keys.add(k);
  }
  return keys;
}

/**
 * 对比某个 app 的 locale 定义集合与代码里扫描到的 used key 集合，输出：
 * - `missing`：代码用到但任何语言都没定义的 key（含 namespace 前缀命中判定）。
 * - `orphan`：locale 里定义了但代码扫描不到任何引用（含 namespace 前缀命中判定）。
 * - `asymmetric`：仅在部分语言文件里存在的 key（zh/en 不对称）。
 */
export function diff(set: LocaleSet, usedKeys: Set<string>) {
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

/** CLI 驱动逻辑：只在直接以脚本方式运行时执行，被 spec import 时不触发。 */
function main() {
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

  console.log(
    `\nDone (missing=${totalMissing}, asymmetric=${totalAsymmetric})`,
  );
  process.exit(0);
}

// 仅作为 CLI 直接运行时执行 main()；被 spec import 时不触发（避免误跑整个仓库扫描）。
if (require.main === module) {
  main();
}
