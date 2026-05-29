#!/usr/bin/env tsx
/**
 * Error Code Fence v0 — 静态围栏校验 `defineErrorCode({...})` 调用。
 *
 * Phase 5 Track E2。与其它 4 个 fence 同套机制（增量 baseline / strict / report）。
 *
 * 检查 3 类问题：
 *   DUPLICATE_CODE — 同一 `code` 数字在 ≥ 2 处定义（不同 ErrorCode 常量）
 *   OUT_OF_RANGE   — `code` 落在该 lib / app 的允许范围之外
 *   GAP            — 同一 `defineErrorCode({...})` 内 code 序列跳号
 *                    （可加 JSDoc `@skip-gap` 整块豁免，或注释 `error-code: ignore-gap`）
 *
 * 范围划分（与 spec §2.3 一致）：
 *   libs/common/**     → 0-999     （框架级）
 *   libs/main/**       → 2000-2999
 *   libs/agent/**      → 3000-3999
 *   apps/server-main/* → 2000-2999（继承 libs/main 范围；通常只 re-export）
 *   apps/server-agent/* → 3000-3999
 *   预留：4000+
 *
 * 用法：
 *   pnpm check:error-code                          报告 + 增量写入
 *   pnpm check:error-code -- --strict              有 finding 即 exit 1（CI 用）
 *   pnpm check:error-code -- --no-report           仅 stdout 不写报告
 *   pnpm check:error-code -- --force-report        强制写报告（刷 baseline）
 *
 * 报告输出：docs/audits/error-code/<YYYY-MM-DD-HHmm>.{md,json}
 *
 * 豁免：
 *   - JSDoc `@skip-gap` 在 defineErrorCode 调用上方 → 跳过该块跳号检查
 *   - 注释 `error-code: ignore` 在 ErrorCode 属性上方 → 跳过该项全部检查
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { Node, Project, SyntaxKind } from "ts-morph";
import { collectTsFiles } from "./lib/ts-files";

const ROOT = path.resolve(__dirname, "..");
const REPORT_DIR = "docs/audits/error-code";

interface RangeRule {
  prefix: string;
  min: number;
  max: number;
  label: string;
}

const RANGES: RangeRule[] = [
  { prefix: "libs/common/", min: 0, max: 999, label: "common" },
  { prefix: "libs/main/", min: 2000, max: 2999, label: "main" },
  { prefix: "libs/agent/", min: 3000, max: 3999, label: "agent" },
  { prefix: "apps/server-main/", min: 2000, max: 2999, label: "main (app)" },
  { prefix: "apps/server-agent/", min: 3000, max: 3999, label: "agent (app)" },
];

type IssueType = "DUPLICATE_CODE" | "OUT_OF_RANGE" | "GAP";

interface Finding {
  type: IssueType;
  file: string;
  line: number;
  key: string;
  code: number;
  details: string;
}

interface CodeDeclaration {
  file: string;
  line: number;
  key: string;
  code: number;
  blockId: string; // 同一 defineErrorCode 调用的 ID（用于 GAP 检查）
  blockIgnoreGap: boolean;
}

interface CliOptions {
  strict: boolean;
  writeReport: boolean;
  forceReport: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    strict: false,
    writeReport: true,
    forceReport: false,
    json: false,
  };
  for (const a of argv) {
    if (a === "--strict") opts.strict = true;
    else if (a === "--no-report") opts.writeReport = false;
    else if (a === "--force-report") opts.forceReport = true;
    else if (a === "--json") opts.json = true;
  }
  return opts;
}

function relPath(abs: string): string {
  return path.relative(ROOT, abs);
}

function classifyRange(file: string): RangeRule | null {
  const rel = relPath(file);
  for (const r of RANGES) {
    if (rel.startsWith(r.prefix)) return r;
  }
  return null;
}

function hasIgnoreComment(node: Node, kind: "skip-gap" | "ignore"): boolean {
  const ranges = node.getLeadingCommentRanges();
  for (const r of ranges) {
    const txt = r.getText();
    if (kind === "skip-gap" && /@skip-gap\b/.test(txt)) return true;
    if (kind === "ignore" && /error-code:\s*ignore\b/.test(txt)) return true;
  }
  return false;
}

function collect(): CodeDeclaration[] {
  const project = new Project({
    tsConfigFilePath: path.join(ROOT, "tsconfig.base.json"),
    skipAddingFilesFromTsConfig: true,
  });
  const srcSeg = `${path.sep}src${path.sep}`;
  const files = [
    ...collectTsFiles(path.join(ROOT, "libs")),
    ...collectTsFiles(path.join(ROOT, "apps")).filter((f) =>
      f.includes(srcSeg),
    ),
  ];
  for (const f of files) project.addSourceFileAtPath(f);

  const out: CodeDeclaration[] = [];

  for (const sf of project.getSourceFiles()) {
    const file = sf.getFilePath();
    if (file.includes("/dist/") || file.includes("/node_modules/")) continue;
    if (file.endsWith(".spec.ts") || file.endsWith(".test.ts")) continue;

    sf.forEachDescendant((node) => {
      if (!Node.isCallExpression(node)) return;
      const expr = node.getExpression();
      if (!Node.isIdentifier(expr) || expr.getText() !== "defineErrorCode") {
        return;
      }
      const args = node.getArguments();
      if (args.length === 0 || !Node.isObjectLiteralExpression(args[0])) return;

      const obj = args[0];
      // blockId：用文件路径 + 行号定位 defineErrorCode 调用本身
      const blockId = `${file}:${node.getStartLineNumber()}`;
      // 找承载语句（变量声明 / export 声明），用其 leading comments 检查 @skip-gap
      const stmt =
        node.getFirstAncestorByKind(SyntaxKind.VariableStatement) ?? node;
      const blockIgnoreGap = hasIgnoreComment(stmt, "skip-gap");

      for (const prop of obj.getProperties()) {
        if (!Node.isPropertyAssignment(prop)) continue;
        if (hasIgnoreComment(prop, "ignore")) continue;
        const key = prop.getName();
        const init = prop.getInitializer();
        if (!init || !Node.isObjectLiteralExpression(init)) continue;
        const codeProp = init.getProperty("code");
        if (!codeProp || !Node.isPropertyAssignment(codeProp)) continue;
        const codeInit = codeProp.getInitializer();
        if (!codeInit || !Node.isNumericLiteral(codeInit)) continue;
        const code = Number(codeInit.getLiteralText());
        out.push({
          file,
          line: prop.getStartLineNumber(),
          key,
          code,
          blockId,
          blockIgnoreGap,
        });
      }
    });
  }
  return out;
}

function analyze(decls: CodeDeclaration[]): Finding[] {
  const findings: Finding[] = [];

  // DUPLICATE_CODE：全局同 code 出现 ≥ 2 处
  const byCode = new Map<number, CodeDeclaration[]>();
  for (const d of decls) {
    const arr = byCode.get(d.code) ?? [];
    arr.push(d);
    byCode.set(d.code, arr);
  }
  for (const [code, list] of byCode) {
    if (list.length < 2) continue;
    // success 哨兵 0 可在多处定义吗？按惯例不允许；仍报
    for (const d of list) {
      const others = list
        .filter((x) => x !== d)
        .map((x) => `${relPath(x.file)}:${x.line}`)
        .join(", ");
      findings.push({
        type: "DUPLICATE_CODE",
        file: d.file,
        line: d.line,
        key: d.key,
        code,
        details: `code ${code} 在其它位置也被定义：${others}`,
      });
    }
  }

  // OUT_OF_RANGE
  for (const d of decls) {
    const r = classifyRange(d.file);
    if (!r) continue; // 路径不在范围表，跳过（容忍）
    if (d.code < r.min || d.code > r.max) {
      findings.push({
        type: "OUT_OF_RANGE",
        file: d.file,
        line: d.line,
        key: d.key,
        code: d.code,
        details: `code ${d.code} 不在 ${r.label} 允许范围 [${r.min}-${r.max}]`,
      });
    }
  }

  // GAP：同 block 内按 code 升序应连续
  const byBlock = new Map<string, CodeDeclaration[]>();
  for (const d of decls) {
    if (d.blockIgnoreGap) continue;
    const arr = byBlock.get(d.blockId) ?? [];
    arr.push(d);
    byBlock.set(d.blockId, arr);
  }
  for (const list of byBlock.values()) {
    list.sort((a, b) => a.code - b.code);
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1];
      const cur = list[i];
      if (cur.code - prev.code > 1) {
        findings.push({
          type: "GAP",
          file: cur.file,
          line: cur.line,
          key: cur.key,
          code: cur.code,
          details: `相对前一个 code ${prev.code}（${prev.key}）跳号至 ${cur.code}；如确需跳号，在 defineErrorCode 上方 JSDoc 加 \`@skip-gap\``,
        });
      }
    }
  }

  return findings.sort((a, b) =>
    a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file),
  );
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function dateStamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

interface BaselineSnapshot {
  generatedAt: string;
  total: number;
  fingerprints: string[];
}

function fingerprint(f: Finding): string {
  return `${f.type}|${relPath(f.file)}|${f.key}|${f.code}`;
}

function findLatestBaseline(): string | null {
  const dir = path.join(ROOT, REPORT_DIR);
  if (!fs.existsSync(dir)) return null;
  const files = fs
    .readdirSync(dir)
    .filter((n) => n.endsWith(".json"))
    .sort()
    .reverse();
  return files[0] ? path.join(dir, files[0]) : null;
}

function loadBaselineFps(file: string): Set<string> {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf-8")) as BaselineSnapshot;
    return new Set(data.fingerprints ?? []);
  } catch {
    return new Set();
  }
}

function writeReportFiles(findings: Finding[]) {
  const dir = path.join(ROOT, REPORT_DIR);
  ensureDir(dir);
  const stamp = dateStamp();
  const json: BaselineSnapshot = {
    generatedAt: new Date().toISOString(),
    total: findings.length,
    fingerprints: findings.map(fingerprint),
  };
  fs.writeFileSync(
    path.join(dir, `${stamp}.json`),
    JSON.stringify(json, null, 2),
  );
  const md = [
    `# error-code fence report ${stamp}`,
    "",
    `- 生成时间：${json.generatedAt}`,
    `- 总 finding：${findings.length}`,
    "",
    "## 详情",
    "",
    ...findings.map(
      (f) =>
        `- **${f.type}** ${relPath(f.file)}:${f.line} \`${f.key}\` (code=${f.code}) — ${f.details}`,
    ),
    "",
  ].join("\n");
  fs.writeFileSync(path.join(dir, `${stamp}.md`), md);
  return path.join(dir, `${stamp}.json`);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const decls = collect();
  const findings = analyze(decls);

  // 输出
  if (opts.json) {
    console.log(JSON.stringify({ total: findings.length, findings }, null, 2));
  } else {
    console.log(
      `[error-code v0] 扫描 defineErrorCode 调用：发现 ${decls.length} 个 code 声明`,
    );
    console.log("");
    console.log(`[error-code v0] 共发现 ${findings.length} 个问题`);
    for (const t of ["DUPLICATE_CODE", "OUT_OF_RANGE", "GAP"] as const) {
      const n = findings.filter((f) => f.type === t).length;
      console.log(`  ${t.padEnd(20)} ${n}`);
    }
    console.log("");
    for (const f of findings) {
      console.log(
        `  ${f.type} ${relPath(f.file)}:${f.line} ${f.key} (code=${f.code})`,
      );
      console.log(`    ${f.details}`);
    }
  }

  // 增量 / 报告
  const baselinePath = findLatestBaseline();
  const baselineFps = baselinePath ? loadBaselineFps(baselinePath) : new Set();
  const currentFps = new Set(findings.map(fingerprint));
  const added = [...currentFps].filter((fp) => !baselineFps.has(fp));
  const removed = [...baselineFps].filter((fp) => !currentFps.has(fp));
  const unchanged = [...currentFps].filter((fp) => baselineFps.has(fp)).length;

  console.log("");
  if (opts.writeReport && (opts.forceReport || added.length > 0)) {
    const out = writeReportFiles(findings);
    console.log(`[error-code v0] 写入报告：${path.relative(ROOT, out)}`);
  } else {
    console.log("[error-code v0] 增量判定：无新增 finding，跳过写入报告");
    if (baselinePath) {
      console.log(`  baseline: ${path.relative(ROOT, baselinePath)}`);
    }
    console.log(
      `  unchanged=${unchanged}  removed=${removed.length}  added=${added.length}`,
    );
    if (removed.length > 0) {
      console.log(`  ✓ 已修复 ${removed.length} 条历史 finding`);
    }
  }

  if (opts.strict && findings.length > 0) {
    console.error(
      `[error-code v0] strict 模式：${findings.length} 个 finding，退出码 1`,
    );
    process.exit(1);
  }
}

main();
