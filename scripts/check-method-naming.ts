#!/usr/bin/env tsx
/**
 * Method Naming Fence v0 — 静态围栏检查 Service 层"事务方法命名"是否合规
 *
 * 与 scripts/check-transactional.ts 形成闭环：
 *   - tx-check  → 验证「该挂事务的方法是否挂了」
 *   - naming-check → 验证「方法命名与 @Transactional() 装饰器是否一致」
 *
 * 检查 2 类问题：
 *   A. PRIVATE_TX_NAMING        — private @Transactional() 方法命名不在约定后缀/前缀范围内
 *   B. MISSING_TX_ON_NAMED      — 命名命中约定后缀/前缀（私有）但未挂 @Transactional()
 *
 * 命名约定（命中其一即视为「事务方法」）：
 *   - 后缀：*InDb / *InTx / *InTransaction
 *   - 前缀：persist[A-Z]*
 *
 * 用法：
 *   pnpm check:naming                          全仓扫描，stdout + 增量写报告
 *   pnpm check:naming -- --json                stdout 改为 JSON 格式
 *   pnpm check:naming -- --strict              发现问题时 exit 1（CI 用）
 *   pnpm check:naming -- --paths libs/common   仅扫描指定路径（逗号分隔，启用过滤即不写报告）
 *   pnpm check:naming -- --types PRIVATE_TX_NAMING   仅展示指定类别（逗号分隔，启用过滤即不写报告）
 *   pnpm check:naming -- --no-report           强制跳过报告文件写入
 *   pnpm check:naming -- --force-report        强制写报告（无视增量判定，刷 baseline 用）
 *   pnpm check:naming -- --out-dir <path>      覆盖报告目录（默认 docs/audits/method-naming）
 *
 * 报告写入策略（增量）：
 *   - 默认仅当当前 finding 集合相对最新 baseline JSON 出现【新增/恶化】时才写新报告。
 *   - 若仅是减少（修复）或完全持平 → 跳过写入，stdout 提示。
 *   - 启用 --paths / --types 过滤、或加 --force-report → 关闭增量。
 *
 * 报告输出位置：
 *   docs/audits/method-naming/<YYYY-MM-DD-HHmm>.md   人读
 *   docs/audits/method-naming/<YYYY-MM-DD-HHmm>.json 机读
 *
 * 局部豁免：
 *   - 文件首部 500 字符内出现 `naming-check: ignore-file` → 跳过整个文件
 *   - 方法上方的 leading 注释中出现 `naming-check: ignore` → 跳过该方法
 *   - 方法 JSDoc 中出现 `@no-tx-naming` → 跳过该方法（语义化标记，等价 ignore）
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { type ClassDeclaration, type MethodDeclaration, Project, type SourceFile, SyntaxKind } from "ts-morph";

const ROOT = path.resolve(__dirname, "..");

const SUFFIX_REGEX = /(InDb|InTx|InTransaction)$/;
const PREFIX_REGEX = /^persist[A-Z]/;

const SKIP_CLASS_DECORATORS = new Set(["Controller", "Resolver", "Processor", "WebSocketGateway", "EventPattern"]);

type IssueType = "PRIVATE_TX_NAMING" | "MISSING_TX_ON_NAMED";

interface Issue {
  type: IssueType;
  file: string;
  line: number;
  className: string;
  methodName: string;
  visibility: "public" | "private" | "protected";
  details: string;
  hint?: string;
}

interface CliOptions {
  json: boolean;
  strict: boolean;
  paths: string[];
  types: Set<IssueType> | null;
  /** false = --no-report 强制不写；true = 默认状态，是否写由增量判定决定 */
  writeReport: boolean;
  /** true = --force-report 无视增量判定一定写 */
  forceReport: boolean;
  /** 标记 paths 是否被用户显式指定（用于关闭增量） */
  pathsExplicit: boolean;
  outDir: string;
}

const DEFAULT_PATHS = ["libs", "apps"];
const DEFAULT_REPORT_DIR = "docs/audits/method-naming";

const NAMING_CONVENTION_HINT =
  "约定：后缀 *InDb / *InTx / *InTransaction（首选 *InDb），或前缀 persist[A-Z]*。\n" +
  "      如确为合理例外（如方法体内含 HTTP/MQ 不能放事务），可在方法 JSDoc 中加 `@no-tx-naming` 豁免。";

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    json: false,
    strict: false,
    paths: DEFAULT_PATHS,
    types: null,
    writeReport: true,
    forceReport: false,
    pathsExplicit: false,
    outDir: DEFAULT_REPORT_DIR,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") opts.json = true;
    else if (a === "--strict") opts.strict = true;
    else if (a === "--no-report") opts.writeReport = false;
    else if (a === "--force-report") opts.forceReport = true;
    else if (a === "--out-dir") {
      const v = argv[++i];
      if (v) opts.outDir = v;
    } else if (a === "--paths") {
      const v = argv[++i];
      if (v) {
        opts.paths = v.split(",").filter(Boolean);
        opts.pathsExplicit = true;
      }
    } else if (a === "--types") {
      const v = argv[++i];
      if (v) {
        opts.types = new Set(
          v
            .split(",")
            .map((s) => s.trim().toUpperCase() as IssueType)
            .filter((s): s is IssueType => ["PRIVATE_TX_NAMING", "MISSING_TX_ON_NAMED"].includes(s)),
        );
      }
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  return opts;
}

function printHelp() {
  console.log(`
Method Naming Fence v0

用法:
  pnpm check:naming                                全仓扫描，stdout + 增量写报告
  pnpm check:naming -- --json                      stdout 改为 JSON 格式
  pnpm check:naming -- --strict                    有问题时 exit 1（CI 用）
  pnpm check:naming -- --paths libs/common         仅扫指定路径（逗号分隔，启用过滤即不写报告）
  pnpm check:naming -- --types PRIVATE_TX_NAMING   仅展示指定类别（逗号分隔，启用过滤即不写报告）
  pnpm check:naming -- --no-report                 强制跳过报告文件写入（仅 stdout）
  pnpm check:naming -- --force-report              强制写报告（无视增量判定，刷 baseline 用）
  pnpm check:naming -- --out-dir <path>            覆盖报告输出目录（默认 ${DEFAULT_REPORT_DIR}）

命名约定:
  - 后缀：*InDb / *InTx / *InTransaction（首选 *InDb）
  - 前缀：persist[A-Z]*

豁免:
  - 文件首部 500 字符内 \`naming-check: ignore-file\`
  - 方法 leading 注释中 \`naming-check: ignore\`
  - 方法 JSDoc 中 \`@no-tx-naming\`（语义化）
`);
}

function shouldSkipFile(filePath: string): boolean {
  const rel = path.relative(ROOT, filePath);
  if (rel.startsWith("node_modules") || rel.startsWith("dist")) return true;
  if (rel.includes("/test/") || rel.includes("/tests/") || rel.includes("/__tests__/")) return true;
  if (rel.endsWith(".spec.ts") || rel.endsWith(".e2e-spec.ts") || rel.endsWith(".test.ts")) {
    return true;
  }
  if (rel.includes("/migrations/")) return true;
  if (rel.includes("/openspec/")) return true;
  // meshbot 非 NestJS 服务层代码：前端、CLI、Agent 域（vitest）、桌面端
  if (rel.startsWith("apps/web-") || rel.includes("/apps/web-")) return true;
  if (rel.startsWith("apps/cli-agent") || rel.includes("/apps/cli-agent/")) return true;
  if (rel.startsWith("apps/desktop") || rel.includes("/apps/desktop/")) return true;
  if (rel.startsWith("libs/agent/") || rel.includes("/libs/agent/")) return true;
  if (rel.startsWith("packages/") || rel.includes("/packages/")) return true;
  if (rel.includes("/.next/")) return true;
  if (rel.endsWith(".d.ts")) return true;
  return false;
}

function classHasSkipDecorator(cls: ClassDeclaration): boolean {
  for (const dec of cls.getDecorators()) {
    if (SKIP_CLASS_DECORATORS.has(dec.getName())) return true;
  }
  return false;
}

function getDecoratorByName(method: MethodDeclaration, name: string) {
  return method.getDecorators().find((d) => d.getName() === name);
}

function getMethodVisibility(method: MethodDeclaration): "public" | "private" | "protected" {
  for (const mod of method.getModifiers()) {
    const k = mod.getKind();
    if (k === SyntaxKind.PrivateKeyword) return "private";
    if (k === SyntaxKind.ProtectedKeyword) return "protected";
  }
  return "public";
}

function methodHasIgnoreComment(method: MethodDeclaration): boolean {
  const ranges = method.getLeadingCommentRanges();
  for (const r of ranges) {
    const txt = r.getText();
    if (/naming-check:\s*ignore\b/.test(txt)) return true;
    if (/@no-tx-naming\b/.test(txt)) return true;
  }
  return false;
}

function fileHasIgnoreComment(sourceFile: SourceFile): boolean {
  return /naming-check:\s*ignore-file\b/.test(sourceFile.getFullText().slice(0, 500));
}

function matchesNamingConvention(name: string): boolean {
  return SUFFIX_REGEX.test(name) || PREFIX_REGEX.test(name);
}

function analyzeMethod(method: MethodDeclaration, className: string, sourceFile: SourceFile, out: Issue[]) {
  const methodName = method.getName();
  if (!methodName) return;
  if (methodHasIgnoreComment(method)) return;

  const visibility = getMethodVisibility(method);
  const txDecorator = getDecoratorByName(method, "Transactional");
  const hasTx = !!txDecorator;
  const namingMatched = matchesNamingConvention(methodName);

  if (hasTx && visibility === "private" && !namingMatched) {
    out.push({
      type: "PRIVATE_TX_NAMING",
      file: sourceFile.getFilePath(),
      line: txDecorator.getStartLineNumber(),
      className,
      methodName,
      visibility,
      details: `private @Transactional() 方法 \`${methodName}\` 命名不符合事务方法约定`,
      hint: NAMING_CONVENTION_HINT,
    });
    return;
  }

  if (!hasTx && namingMatched && (visibility === "private" || visibility === "protected")) {
    out.push({
      type: "MISSING_TX_ON_NAMED",
      file: sourceFile.getFilePath(),
      line: method.getStartLineNumber(),
      className,
      methodName,
      visibility,
      details: `方法名 \`${methodName}\` 命中事务命名约定但未挂 @Transactional()`,
      hint:
        "若方法体确实需要事务，加 @Transactional()。若命名带 persist*/InDb 但实际无事务需求（如含 HTTP 调用、单 SQL 写），\n" +
        "      请改名（如 updateXxx / saveXxx）或在 JSDoc 中加 `@no-tx-naming` 豁免。",
    });
  }
}

function analyzeFile(sourceFile: SourceFile, out: Issue[]) {
  if (shouldSkipFile(sourceFile.getFilePath())) return;
  if (fileHasIgnoreComment(sourceFile)) return;

  for (const cls of sourceFile.getClasses()) {
    if (classHasSkipDecorator(cls)) continue;
    const className = cls.getName() ?? "<anonymous>";
    for (const m of cls.getMethods()) {
      analyzeMethod(m, className, sourceFile, out);
    }
  }
}

function loadProject(targets: string[]): Project {
  const project = new Project({
    tsConfigFilePath: path.join(ROOT, "tsconfig.base.json"),
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { allowJs: false, noEmit: true },
  });
  for (const target of targets) {
    const abs = path.resolve(ROOT, target);
    if (!fs.existsSync(abs)) {
      console.warn(`[naming-check] target 不存在: ${target}`);
      continue;
    }
    project.addSourceFilesAtPaths([
      `${abs}/**/*.ts`,
      `!${abs}/**/*.d.ts`,
      `!${abs}/**/node_modules/**`,
      `!${abs}/**/dist/**`,
    ]);
  }
  return project;
}

function printTextReport(issues: Issue[], filterTypes: Set<IssueType> | null) {
  const grouped: Record<IssueType, Issue[]> = {
    PRIVATE_TX_NAMING: [],
    MISSING_TX_ON_NAMED: [],
  };
  for (const i of issues) grouped[i.type].push(i);

  const total = issues.length;
  console.log(`\n[naming-check v0] 共发现 ${total} 个问题`);
  console.log(`  PRIVATE_TX_NAMING:   ${grouped.PRIVATE_TX_NAMING.length}  private @Transactional() 方法命名不规范`);
  console.log(`  MISSING_TX_ON_NAMED: ${grouped.MISSING_TX_ON_NAMED.length}  命名命中约定但缺 @Transactional()\n`);

  const order: IssueType[] = ["PRIVATE_TX_NAMING", "MISSING_TX_ON_NAMED"];
  for (const type of order) {
    if (filterTypes && !filterTypes.has(type)) continue;
    const list = grouped[type];
    if (list.length === 0) continue;
    console.log(`──────── ${type} (${list.length}) ────────`);
    for (const i of list) {
      const rel = path.relative(ROOT, i.file);
      console.log(`\n  ${rel}:${i.line}`);
      console.log(`    [${i.visibility}] ${i.className}.${i.methodName}: ${i.details}`);
      if (i.hint) {
        console.log(`    → ${i.hint}`);
      }
    }
    console.log("");
  }
}

interface ReportMeta {
  generatedAt: Date;
  paths: string[];
  fileCount: number;
  filterTypes: Set<IssueType> | null;
  strict: boolean;
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

function formatReportTimestamp(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}`;
}

function formatHumanTimestamp(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function buildMarkdownReport(issues: Issue[], meta: ReportMeta): string {
  const grouped: Record<IssueType, Issue[]> = {
    PRIVATE_TX_NAMING: [],
    MISSING_TX_ON_NAMED: [],
  };
  for (const i of issues) grouped[i.type].push(i);

  const lines: string[] = [];
  lines.push(`# method-naming fence report ${formatReportTimestamp(meta.generatedAt)}`);
  lines.push("");
  lines.push(`- **生成时间**: ${formatHumanTimestamp(meta.generatedAt)}`);
  lines.push(`- **扫描路径**: ${meta.paths.join(", ")}`);
  lines.push(`- **扫描文件数**: ${meta.fileCount}`);
  lines.push(`- **执行模式**: ${meta.strict ? "strict (CI)" : "report-only"}`);
  if (meta.filterTypes) {
    lines.push(`- **类别过滤**: ${[...meta.filterTypes].join(", ")}`);
  }
  lines.push(`- **总 finding 数**: ${issues.length}`);
  lines.push("");

  lines.push("## 命名约定");
  lines.push("");
  lines.push("- 后缀：`*InDb` / `*InTx` / `*InTransaction`（首选 `*InDb`）");
  lines.push("- 前缀：`persist[A-Z]*`");
  lines.push("- 豁免：方法 JSDoc 中加 `@no-tx-naming` 标记可跳过校验（如方法体含 HTTP/MQ 不能放事务）");
  lines.push("");

  lines.push("## 摘要");
  lines.push("");
  lines.push("| 类别 | 数量 | 含义 |");
  lines.push("| --- | ---: | --- |");
  lines.push(
    `| PRIVATE_TX_NAMING | ${grouped.PRIVATE_TX_NAMING.length} | private @Transactional() 方法命名不在约定范围内 |`,
  );
  lines.push(
    `| MISSING_TX_ON_NAMED | ${grouped.MISSING_TX_ON_NAMED.length} | 命名命中约定（私有）但未挂 @Transactional() |`,
  );
  lines.push(`| **总计** | **${issues.length}** | |`);
  lines.push("");

  if (issues.length === 0) {
    lines.push("## 详情");
    lines.push("");
    lines.push("> 命名围栏全绿，无 finding。");
    lines.push("");
    return lines.join("\n");
  }

  lines.push("## 详情");
  lines.push("");
  const order: IssueType[] = ["PRIVATE_TX_NAMING", "MISSING_TX_ON_NAMED"];
  for (const type of order) {
    if (meta.filterTypes && !meta.filterTypes.has(type)) continue;
    const list = grouped[type];
    if (list.length === 0) continue;
    lines.push(`### ${type} (${list.length})`);
    lines.push("");
    for (const i of list) {
      const rel = path.relative(ROOT, i.file);
      lines.push(`- **\`${rel}:${i.line}\`** — \`[${i.visibility}] ${i.className}.${i.methodName}\``);
      lines.push(`  - ${i.details}`);
      if (i.hint) {
        lines.push(`  - hint: ${i.hint}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Issue 指纹：用于跨次运行对比"是不是同一条 finding"。
 * 故意忽略 line（行号位移不算"新增"）。
 */
function issueFingerprint(i: Issue): string {
  const rel = path.relative(ROOT, i.file);
  return `${i.type}|${rel}|${i.className}.${i.methodName}`;
}

interface BaselineDiff {
  baselinePath: string | null;
  added: Issue[];
  removed: string[];
  unchanged: number;
}

function findLatestBaselineJson(absOutDir: string): string | null {
  if (!fs.existsSync(absOutDir)) return null;
  const entries = fs
    .readdirSync(absOutDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const full = path.join(absOutDir, f);
      return { full, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return entries[0]?.full ?? null;
}

function loadBaselineFingerprints(jsonPath: string): Set<string> | null {
  try {
    const raw = fs.readFileSync(jsonPath, "utf8");
    const parsed = JSON.parse(raw) as { issues?: Issue[] };
    if (!Array.isArray(parsed.issues)) return null;
    return new Set(parsed.issues.map(issueFingerprint));
  } catch {
    return null;
  }
}

function diffAgainstBaseline(currentIssues: Issue[], absOutDir: string): BaselineDiff {
  const baselinePath = findLatestBaselineJson(absOutDir);
  if (!baselinePath) {
    return { baselinePath: null, added: currentIssues, removed: [], unchanged: 0 };
  }
  const baselineFps = loadBaselineFingerprints(baselinePath);
  if (!baselineFps) {
    return { baselinePath, added: currentIssues, removed: [], unchanged: 0 };
  }

  const added: Issue[] = [];
  let unchanged = 0;
  const currentFps = new Set<string>();
  for (const i of currentIssues) {
    const fp = issueFingerprint(i);
    currentFps.add(fp);
    if (baselineFps.has(fp)) {
      unchanged += 1;
    } else {
      added.push(i);
    }
  }
  const removed: string[] = [];
  for (const fp of baselineFps) {
    if (!currentFps.has(fp)) removed.push(fp);
  }

  return { baselinePath, added, removed, unchanged };
}

function writeReportFiles(issues: Issue[], meta: ReportMeta, outDir: string): { mdPath: string; jsonPath: string } {
  const absOutDir = path.isAbsolute(outDir) ? outDir : path.join(ROOT, outDir);
  fs.mkdirSync(absOutDir, { recursive: true });

  const stem = formatReportTimestamp(meta.generatedAt);
  const mdPath = path.join(absOutDir, `${stem}.md`);
  const jsonPath = path.join(absOutDir, `${stem}.json`);

  fs.writeFileSync(mdPath, buildMarkdownReport(issues, meta), "utf8");
  fs.writeFileSync(
    jsonPath,
    `${JSON.stringify(
      {
        generatedAt: meta.generatedAt.toISOString(),
        paths: meta.paths,
        fileCount: meta.fileCount,
        filterTypes: meta.filterTypes ? [...meta.filterTypes] : null,
        strict: meta.strict,
        total: issues.length,
        issues,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return { mdPath, jsonPath };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const project = loadProject(opts.paths);
  const sourceFiles = project.getSourceFiles();

  const issues: Issue[] = [];
  for (const sf of sourceFiles) analyzeFile(sf, issues);

  const filtered = opts.types ? issues.filter((i) => opts.types?.has(i.type)) : issues;

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ total: filtered.length, issues: filtered }, null, 2)}\n`);
  } else {
    console.log(`[naming-check v0] 扫描 ${sourceFiles.length} 个 .ts 文件 (targets: ${opts.paths.join(", ")})`);
    printTextReport(filtered, opts.types);
  }

  if (opts.writeReport) {
    const isPartialScan = opts.pathsExplicit || !!opts.types;
    const incrementalEnabled = !opts.forceReport && !isPartialScan;

    const absOutDir = path.isAbsolute(opts.outDir) ? opts.outDir : path.join(ROOT, opts.outDir);
    const diff = incrementalEnabled ? diffAgainstBaseline(filtered, absOutDir) : null;

    const shouldWrite =
      opts.forceReport || isPartialScan || !diff || diff.added.length > 0 || diff.baselinePath === null;

    if (!shouldWrite && diff) {
      if (!opts.json) {
        console.log(`[naming-check v0] 增量判定: 无新增 finding，跳过写入报告`);
        console.log(`  baseline: ${path.relative(ROOT, diff.baselinePath as string)}`);
        console.log(`  unchanged=${diff.unchanged}  removed=${diff.removed.length}  added=0`);
        if (diff.removed.length > 0) {
          console.log(`  ✓ 已修复 ${diff.removed.length} 条历史 finding（如需刷新 baseline，重跑加 --force-report）`);
        }
      }
    } else {
      const meta: ReportMeta = {
        generatedAt: new Date(),
        paths: opts.paths,
        fileCount: sourceFiles.length,
        filterTypes: opts.types,
        strict: opts.strict,
      };
      const { mdPath, jsonPath } = writeReportFiles(filtered, meta, opts.outDir);
      if (!opts.json) {
        if (diff && diff.baselinePath) {
          console.log(`[naming-check v0] 增量判定: 检测到新增 finding，写入新报告`);
          console.log(`  baseline: ${path.relative(ROOT, diff.baselinePath)}`);
          console.log(`  added=${diff.added.length}  removed=${diff.removed.length}  unchanged=${diff.unchanged}`);
        } else if (incrementalEnabled) {
          console.log(`[naming-check v0] 增量判定: 未找到 baseline，写入首份报告`);
        } else if (isPartialScan) {
          console.log(`[naming-check v0] 局部扫描（启用了 --paths/--types），跳过增量判定，直接写报告`);
        }
        console.log(`[naming-check v0] 报告已写入:`);
        console.log(`  ${path.relative(ROOT, mdPath)}`);
        console.log(`  ${path.relative(ROOT, jsonPath)}`);
      }
    }
  }

  if (opts.strict && filtered.length > 0) process.exit(1);
}

main();
