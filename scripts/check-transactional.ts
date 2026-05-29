#!/usr/bin/env tsx
/**
 * Transactional Fence v0 — 静态围栏检查事务装饰器使用是否合规
 *
 * 检查 3 类问题：
 *   A. MISSING       — 方法体内 ≥2 处写动作但未挂 @Transactional()
 *   B. WRONG_IMPORT  — @Transactional 导入来源 ≠ @meshbot/common
 *   D. REDUNDANT     — 挂了 @Transactional() 但写动作 ≤1（事务无意义）
 *
 * 用法：
 *   pnpm check:tx                          全仓扫描，stdout + 增量写报告
 *   pnpm check:tx -- --json                stdout 改为 JSON 格式
 *   pnpm check:tx -- --strict              发现问题时 exit 1（CI 用）
 *   pnpm check:tx -- --paths libs/common   仅扫描指定路径（逗号分隔，启用过滤即不写报告）
 *   pnpm check:tx -- --types MISSING       仅展示指定类别（逗号分隔，启用过滤即不写报告）
 *   pnpm check:tx -- --no-report           强制跳过报告文件写入
 *   pnpm check:tx -- --force-report        强制写报告（无视增量判定，刷 baseline 用）
 *   pnpm check:tx -- --out-dir <path>      覆盖报告目录（默认 docs/audits/tx-fence）
 *
 * 报告写入策略（增量）：
 *   - 默认仅当当前 finding 集合相对最新 baseline JSON 出现【新增/恶化】时才写新报告。
 *   - 若仅是减少（修复）或完全持平 → 跳过写入，stdout 提示。
 *   - 启用 --paths / --types 过滤、或加 --force-report → 关闭增量，行为回退到旧版（始终写 / 始终不写）。
 *
 * 报告输出位置：
 *   docs/audits/tx-fence/<YYYY-MM-DD-HHmm>.md   人读
 *   docs/audits/tx-fence/<YYYY-MM-DD-HHmm>.json 机读
 *
 * 局部豁免：
 *   - 文件首部 500 字符内出现 `tx-check: ignore-file` → 跳过整个文件
 *   - 方法上方的 leading 注释中出现 `tx-check: ignore` → 跳过该方法
 *
 * 已知局限（v0）：
 *   - 仅靠命名约定（Repo 后缀 / Service 后缀）识别写动作，不读 type info
 *   - 跨 service 写仅展开 1 层，A→B→C 中 C 的写在 A 看不到
 *   - 不检 C 类 DANGEROUS（事务内调 HTTP/MQ），留待 v1
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  type ClassDeclaration,
  type MethodDeclaration,
  Node,
  Project,
  type SourceFile,
} from "ts-morph";
import { collectTsFiles } from "./lib/ts-files";

const ROOT = path.resolve(__dirname, "..");

const ALLOWED_TX_IMPORT = "@meshbot/common";

const WRITE_REPO_METHODS = new Set([
  "save",
  "insert",
  "update",
  "delete",
  "softDelete",
  "softRemove",
  "remove",
  "upsert",
  "increment",
  "decrement",
  "restore",
]);

/**
 * 跨 service 写动作的"动词前缀"白名单。
 * 匹配规则：方法名以下列前缀开头，且后续是 word boundary（大写字母或末尾）。
 *   ✓ create  → createForUser / createMany / create
 *   ✓ revoke  → revokeAllForUser / revokeBy
 *   ✗ set     → 不放（容易误命中 setupContext / setOptions 等辅助方法）
 */
const SUB_SERVICE_WRITE_VERB_PREFIXES = [
  "create",
  "update",
  "delete",
  "save",
  "upsert",
  "remove",
  "archive",
  "disable",
  "enable",
  "revoke",
  "reset",
  "seed",
  "grant",
  "register",
  "insert",
  "persist",
  "deactivate",
  "activate",
  "softDelete",
  "softRemove",
  "reassign",
  "bind",
  "unbind",
  "attach",
  "detach",
  "approve",
  "reject",
  "publish",
  "unpublish",
  "mark",
  "purge",
];

function matchesWriteVerbPrefix(methodName: string): boolean {
  for (const prefix of SUB_SERVICE_WRITE_VERB_PREFIXES) {
    if (methodName === prefix) return true;
    if (methodName.startsWith(prefix)) {
      const next = methodName[prefix.length];
      if (next && next === next.toUpperCase()) return true;
    }
  }
  return false;
}

const READ_ONLY_PREFIXES = [
  "find",
  "get",
  "list",
  "count",
  "exists",
  "has",
  "load",
  "fetch",
  "read",
  "query",
  "resolve",
  "check",
  "verify",
  "validate",
  "preview",
  "render",
  "describe",
  "summarize",
];

const SKIP_CLASS_DECORATORS = new Set([
  "Controller",
  "Resolver",
  "Processor",
  "WebSocketGateway",
  "EventPattern",
]);

const REPO_IDENT_REGEX = /(repo|repository)$/i;
const SERVICE_IDENT_REGEX = /Service$/;
const DATASOURCE_IDENT_REGEX = /datasource$/i;

/**
 * BYPASS 检测：识别绕过 TxTypeOrmModule Proxy 的写法。
 *
 * 这些文件是事务体系自身的实现，不应被业务侧规则拦截。
 */
const BYPASS_INFRA_WHITELIST = new Set<string>([
  "libs/common/src/typeorm/tx-typeorm.module.ts",
  "libs/common/src/decorators/transactional.decorator.ts",
]);

const RAW_SQL_WRITE_KEYWORDS =
  /^\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)*?(UPDATE|INSERT|DELETE|MERGE|REPLACE|TRUNCATE|ALTER|DROP|CREATE)\b/i;

type IssueType = "MISSING" | "WRONG_IMPORT" | "REDUNDANT" | "BYPASS";

type BypassSubtype =
  | "TX_NESTED" // dataSource.transaction(...)
  | "QUERY_RUNNER" // dataSource.createQueryRunner()
  | "MANAGER_WRITE" // dataSource.manager.<save|update|...>(...)
  | "GET_REPOSITORY" // dataSource.getRepository(...)
  | "RAW_SQL_WRITE"; // dataSource.query("UPDATE/INSERT/...")

interface Issue {
  type: IssueType;
  subtype?: BypassSubtype;
  file: string;
  line: number;
  className: string;
  methodName: string;
  details: string;
  evidence?: string[];
  hint?: string;
}

interface WriteSignal {
  text: string;
  line: number;
  kind: "repo" | "subservice";
}

interface BypassSignal {
  subtype: BypassSubtype;
  text: string;
  line: number;
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
const DEFAULT_REPORT_DIR = "docs/audits/tx-fence";

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
            .filter((s): s is IssueType =>
              ["MISSING", "WRONG_IMPORT", "REDUNDANT", "BYPASS"].includes(s),
            ),
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
Transactional Fence v0

用法:
  pnpm check:tx                            全仓扫描，stdout + 增量写报告
  pnpm check:tx -- --json                  stdout 改为 JSON 格式
  pnpm check:tx -- --strict                有问题时 exit 1（CI 用）
  pnpm check:tx -- --paths libs/common     仅扫指定路径（逗号分隔，启用过滤即不写报告）
  pnpm check:tx -- --types MISSING         仅展示指定类别（逗号分隔，启用过滤即不写报告）
  pnpm check:tx -- --no-report             强制跳过报告文件写入（仅 stdout）
  pnpm check:tx -- --force-report          强制写报告（无视增量判定，刷 baseline 用）
  pnpm check:tx -- --out-dir <path>        覆盖报告输出目录（默认 ${DEFAULT_REPORT_DIR}）

报告写入策略（增量）:
  - 默认仅当当前 finding 集合相对最新 baseline JSON 出现【新增/恶化】时才写新报告。
  - 启用 --paths / --types 过滤、或加 --force-report → 关闭增量。
`);
}

function shouldSkipFile(filePath: string): boolean {
  const rel = path.relative(ROOT, filePath);
  if (rel.startsWith("node_modules") || rel.startsWith("dist")) return true;
  if (
    rel.includes("/test/") ||
    rel.includes("/tests/") ||
    rel.includes("/__tests__/")
  )
    return true;
  if (
    rel.endsWith(".spec.ts") ||
    rel.endsWith(".e2e-spec.ts") ||
    rel.endsWith(".test.ts")
  ) {
    return true;
  }
  if (rel.includes("/migrations/")) return true;
  if (rel.includes("/openspec/")) return true;
  // meshbot 非 NestJS 服务层代码：前端、CLI、Agent 域（vitest）、桌面端
  if (rel.startsWith("apps/web-") || rel.includes("/apps/web-")) return true;
  if (rel.startsWith("apps/cli-agent") || rel.includes("/apps/cli-agent/"))
    return true;
  if (rel.startsWith("apps/desktop") || rel.includes("/apps/desktop/"))
    return true;
  if (rel.startsWith("libs/agent/") || rel.includes("/libs/agent/"))
    return true;
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

function getTransactionalImportSource(sourceFile: SourceFile): string | null {
  for (const imp of sourceFile.getImportDeclarations()) {
    for (const ni of imp.getNamedImports()) {
      if (ni.getName() === "Transactional")
        return imp.getModuleSpecifierValue();
    }
  }
  return null;
}

function isReadOnlyMethodName(name: string): boolean {
  for (const p of READ_ONLY_PREFIXES) {
    if (name === p) return true;
    if (name.startsWith(p)) {
      const next = name[p.length];
      if (next && next === next.toUpperCase()) return true;
    }
  }
  return false;
}

function collectWriteSignals(method: MethodDeclaration): WriteSignal[] {
  const signals: WriteSignal[] = [];
  const body = method.getBody();
  if (!body) return signals;

  body.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return;
    const expr = node.getExpression();
    if (!Node.isPropertyAccessExpression(expr)) return;

    const propName = expr.getName();
    const target = expr.getExpression();

    if (Node.isPropertyAccessExpression(target)) {
      const targetPropName = target.getName();

      if (
        REPO_IDENT_REGEX.test(targetPropName) &&
        WRITE_REPO_METHODS.has(propName)
      ) {
        signals.push({
          text: `${target.getText()}.${propName}(...)`,
          line: node.getStartLineNumber(),
          kind: "repo",
        });
        return;
      }

      if (
        SERVICE_IDENT_REGEX.test(targetPropName) &&
        matchesWriteVerbPrefix(propName)
      ) {
        signals.push({
          text: `${target.getText()}.${propName}(...)`,
          line: node.getStartLineNumber(),
          kind: "subservice",
        });
      }
      return;
    }

    if (Node.isIdentifier(target)) {
      const targetName = target.getText();
      if (
        REPO_IDENT_REGEX.test(targetName) &&
        WRITE_REPO_METHODS.has(propName)
      ) {
        signals.push({
          text: `${targetName}.${propName}(...)`,
          line: node.getStartLineNumber(),
          kind: "repo",
        });
      }
    }
  });

  return signals;
}

const BYPASS_HINTS: Record<BypassSubtype, string> = {
  TX_NESTED:
    "自开内层事务，与 @Transactional() ALS 上下文不互通；若未来上层方法加 @Transactional() 并调到此方法，外层 rollback 撤销不了内层 commit → 裂态。\n      修复：用 TransactionContext.getQueryRunner() 复用上层事务（若存在）；或保证此方法绝不被 @Transactional 链路调用。",
  QUERY_RUNNER:
    "手动 createQueryRunner，不进入 ALS 事务上下文。\n      修复：除非有非常特殊需求，应改用 @Transactional() 装饰器。",
  MANAGER_WRITE:
    "直接拿 dataSource.manager 做写入，绕过 TxTypeOrmModule Proxy。\n      修复：用 @InjectRepository 注入 Repository（自动事务感知）；或在事务内通过 TransactionContext.getQueryRunner().manager 操作。",
  GET_REPOSITORY:
    "通过 dataSource.getRepository(...) 获取 Repository，跳过 Proxy → 不感知事务。\n      修复：改为 @InjectRepository 注入。",
  RAW_SQL_WRITE:
    "raw SQL 写动作通过 dataSource.query() 执行，不感知 ALS 事务上下文。\n      修复：用 TransactionContext.getQueryRunner()?.manager.query(...) 或显式注入 QueryRunner。",
};

function getCallTargetIdentName(target: Node): string | null {
  if (Node.isPropertyAccessExpression(target)) return target.getName();
  if (Node.isIdentifier(target)) return target.getText();
  return null;
}

function getStringLiteralFirstArg(callExpr: Node): string | null {
  if (!Node.isCallExpression(callExpr)) return null;
  const arg = callExpr.getArguments()[0];
  if (!arg) return null;
  if (Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg)) {
    return arg.getLiteralText();
  }
  if (Node.isTemplateExpression(arg)) {
    return arg.getHead().getLiteralText();
  }
  return null;
}

function collectBypassSignals(method: MethodDeclaration): BypassSignal[] {
  const signals: BypassSignal[] = [];
  const body = method.getBody();
  if (!body) return signals;

  body.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return;
    const expr = node.getExpression();
    if (!Node.isPropertyAccessExpression(expr)) return;

    const propName = expr.getName();
    const target = expr.getExpression();

    if (Node.isPropertyAccessExpression(target)) {
      const targetPropName = target.getName();
      const targetTargetName = getCallTargetIdentName(target.getExpression());

      if (
        targetPropName === "manager" &&
        targetTargetName &&
        DATASOURCE_IDENT_REGEX.test(targetTargetName) &&
        (WRITE_REPO_METHODS.has(propName) || propName === "query")
      ) {
        signals.push({
          subtype: "MANAGER_WRITE",
          text: `${target.getText()}.${propName}(...)`,
          line: node.getStartLineNumber(),
        });
        return;
      }

      const dsName = targetPropName;
      if (DATASOURCE_IDENT_REGEX.test(dsName)) {
        const sig = matchDataSourceCall(target.getText(), propName, node);
        if (sig) signals.push(sig);
        return;
      }
    }

    if (Node.isIdentifier(target)) {
      const targetName = target.getText();
      if (DATASOURCE_IDENT_REGEX.test(targetName)) {
        const sig = matchDataSourceCall(targetName, propName, node);
        if (sig) signals.push(sig);
      }
    }
  });

  return signals;
}

function matchDataSourceCall(
  targetText: string,
  propName: string,
  callNode: Node,
): BypassSignal | null {
  const line = callNode.getStartLineNumber();
  if (propName === "transaction") {
    return {
      subtype: "TX_NESTED",
      text: `${targetText}.transaction(...)`,
      line,
    };
  }
  if (propName === "createQueryRunner") {
    return {
      subtype: "QUERY_RUNNER",
      text: `${targetText}.createQueryRunner()`,
      line,
    };
  }
  if (propName === "getRepository") {
    return {
      subtype: "GET_REPOSITORY",
      text: `${targetText}.getRepository(...)`,
      line,
    };
  }
  if (propName === "query") {
    const sql = getStringLiteralFirstArg(callNode);
    if (sql && RAW_SQL_WRITE_KEYWORDS.test(sql)) {
      const preview = sql.replace(/\s+/g, " ").slice(0, 60);
      return {
        subtype: "RAW_SQL_WRITE",
        text: `${targetText}.query("${preview}${sql.length > 60 ? "..." : ""}")`,
        line,
      };
    }
  }
  return null;
}

function methodHasIgnoreComment(method: MethodDeclaration): boolean {
  const ranges = method.getLeadingCommentRanges();
  for (const r of ranges) {
    if (/tx-check:\s*ignore\b/.test(r.getText())) return true;
  }
  return false;
}

function fileHasIgnoreComment(sourceFile: SourceFile): boolean {
  return /tx-check:\s*ignore-file\b/.test(
    sourceFile.getFullText().slice(0, 500),
  );
}

function analyzeMethod(
  method: MethodDeclaration,
  className: string,
  sourceFile: SourceFile,
  txImportSource: string | null,
  bypassEnabled: boolean,
  out: Issue[],
) {
  const methodName = method.getName();
  if (!methodName) return;
  if (methodHasIgnoreComment(method)) return;

  const txDecorator = getDecoratorByName(method, "Transactional");
  const hasTx = !!txDecorator;
  const writes = collectWriteSignals(method);

  if (bypassEnabled) {
    for (const sig of collectBypassSignals(method)) {
      out.push({
        type: "BYPASS",
        subtype: sig.subtype,
        file: sourceFile.getFilePath(),
        line: sig.line,
        className,
        methodName,
        details: `检测到 ${sig.text}`,
        hint: BYPASS_HINTS[sig.subtype],
      });
    }
  }

  if (hasTx) {
    if (txImportSource && txImportSource !== ALLOWED_TX_IMPORT) {
      out.push({
        type: "WRONG_IMPORT",
        file: sourceFile.getFilePath(),
        line: txDecorator.getStartLineNumber(),
        className,
        methodName,
        details: `@Transactional 来自 ${txImportSource}，仅允许从 ${ALLOWED_TX_IMPORT} 导入`,
      });
    }

    if (writes.length <= 1) {
      out.push({
        type: "REDUNDANT",
        file: sourceFile.getFilePath(),
        line: txDecorator.getStartLineNumber(),
        className,
        methodName,
        details:
          writes.length === 0
            ? "挂了 @Transactional() 但方法体内未检测到任何写动作"
            : "挂了 @Transactional() 但仅 1 处写动作（事务无意义）",
        evidence: writes.map((w) => `${w.line}: ${w.text}`),
      });
    }
    return;
  }

  if (isReadOnlyMethodName(methodName)) return;

  if (writes.length >= 2) {
    out.push({
      type: "MISSING",
      file: sourceFile.getFilePath(),
      line: method.getStartLineNumber(),
      className,
      methodName,
      details: `检测到 ${writes.length} 处写动作但未挂 @Transactional()`,
      evidence: writes.map((w) => `${w.line}: ${w.text}`),
    });
  }
}

function isBypassInfraWhitelisted(filePath: string): boolean {
  const rel = path.relative(ROOT, filePath);
  return BYPASS_INFRA_WHITELIST.has(rel);
}

function analyzeFile(sourceFile: SourceFile, out: Issue[]) {
  if (shouldSkipFile(sourceFile.getFilePath())) return;
  if (fileHasIgnoreComment(sourceFile)) return;

  const txImportSource = getTransactionalImportSource(sourceFile);
  const bypassEnabled = !isBypassInfraWhitelisted(sourceFile.getFilePath());

  for (const cls of sourceFile.getClasses()) {
    if (classHasSkipDecorator(cls)) continue;
    const className = cls.getName() ?? "<anonymous>";
    for (const m of cls.getMethods()) {
      analyzeMethod(
        m,
        className,
        sourceFile,
        txImportSource,
        bypassEnabled,
        out,
      );
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
      console.warn(`[tx-check] target 不存在: ${target}`);
      continue;
    }
    for (const f of collectTsFiles(abs)) project.addSourceFileAtPath(f);
  }
  return project;
}

function printTextReport(issues: Issue[], filterTypes: Set<IssueType> | null) {
  const grouped: Record<IssueType, Issue[]> = {
    MISSING: [],
    WRONG_IMPORT: [],
    REDUNDANT: [],
    BYPASS: [],
  };
  for (const i of issues) grouped[i.type].push(i);

  const total = issues.length;
  console.log(`\n[tx-check v0] 共发现 ${total} 个问题`);
  console.log(
    `  WRONG_IMPORT: ${grouped.WRONG_IMPORT.length}  @Transactional 导入来源不合法`,
  );
  console.log(
    `  MISSING:      ${grouped.MISSING.length}  应挂 @Transactional() 但未挂`,
  );
  console.log(
    `  REDUNDANT:    ${grouped.REDUNDANT.length}  挂了 @Transactional() 但写动作 ≤1`,
  );
  console.log(
    `  BYPASS:       ${grouped.BYPASS.length}  绕过 TxTypeOrmModule Proxy / 自开事务\n`,
  );

  const order: IssueType[] = ["WRONG_IMPORT", "MISSING", "REDUNDANT", "BYPASS"];
  for (const type of order) {
    if (filterTypes && !filterTypes.has(type)) continue;
    const list = grouped[type];
    if (list.length === 0) continue;
    console.log(`──────── ${type} (${list.length}) ────────`);
    for (const i of list) {
      const rel = path.relative(ROOT, i.file);
      const tag = i.subtype ? `[${i.subtype}] ` : "";
      console.log(`\n  ${tag}${rel}:${i.line}`);
      console.log(`    ${i.className}.${i.methodName}: ${i.details}`);
      if (i.evidence?.length) {
        for (const e of i.evidence) console.log(`    - ${e}`);
      }
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
    MISSING: [],
    WRONG_IMPORT: [],
    REDUNDANT: [],
    BYPASS: [],
  };
  for (const i of issues) grouped[i.type].push(i);

  const lines: string[] = [];
  lines.push(`# tx-fence report ${formatReportTimestamp(meta.generatedAt)}`);
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

  lines.push("## 摘要");
  lines.push("");
  lines.push("| 类别 | 数量 | 含义 |");
  lines.push("| --- | ---: | --- |");
  lines.push(
    `| WRONG_IMPORT | ${grouped.WRONG_IMPORT.length} | @Transactional 导入来源不合法 |`,
  );
  lines.push(
    `| MISSING | ${grouped.MISSING.length} | 应挂 @Transactional() 但未挂 |`,
  );
  lines.push(
    `| REDUNDANT | ${grouped.REDUNDANT.length} | 挂了 @Transactional() 但写动作 ≤ 1 |`,
  );
  lines.push(
    `| BYPASS | ${grouped.BYPASS.length} | 绕过 TxTypeOrmModule Proxy / 自开事务 |`,
  );
  lines.push(`| **总计** | **${issues.length}** | |`);
  lines.push("");

  if (issues.length === 0) {
    lines.push("## 详情");
    lines.push("");
    lines.push("> 事务围栏全绿，无 finding。");
    lines.push("");
    return lines.join("\n");
  }

  lines.push("## 详情");
  lines.push("");
  const order: IssueType[] = ["WRONG_IMPORT", "MISSING", "REDUNDANT", "BYPASS"];
  for (const type of order) {
    if (meta.filterTypes && !meta.filterTypes.has(type)) continue;
    const list = grouped[type];
    if (list.length === 0) continue;
    lines.push(`### ${type} (${list.length})`);
    lines.push("");
    for (const i of list) {
      const rel = path.relative(ROOT, i.file);
      const tag = i.subtype ? `[${i.subtype}] ` : "";
      lines.push(
        `- **${tag}\`${rel}:${i.line}\`** — \`${i.className}.${i.methodName}\``,
      );
      lines.push(`  - ${i.details}`);
      if (i.evidence?.length) {
        for (const e of i.evidence) lines.push(`  - evidence: \`${e}\``);
      }
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
 * 故意忽略 line 与 details 内的可变信息（行号位移、写动作计数变化均不算"新增"）。
 */
function issueFingerprint(i: Issue): string {
  const subtype = i.subtype ?? "-";
  const rel = path.relative(ROOT, i.file);
  return `${i.type}|${subtype}|${rel}|${i.className}.${i.methodName}`;
}

interface BaselineDiff {
  /** 找到的 baseline 文件相对路径；null 表示首次运行无 baseline */
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

function diffAgainstBaseline(
  currentIssues: Issue[],
  absOutDir: string,
): BaselineDiff {
  const baselinePath = findLatestBaselineJson(absOutDir);
  if (!baselinePath) {
    return {
      baselinePath: null,
      added: currentIssues,
      removed: [],
      unchanged: 0,
    };
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

  return {
    baselinePath,
    added,
    removed,
    unchanged,
  };
}

function writeReportFiles(
  issues: Issue[],
  meta: ReportMeta,
  outDir: string,
): { mdPath: string; jsonPath: string } {
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

  const filtered = opts.types
    ? issues.filter((i) => opts.types?.has(i.type))
    : issues;

  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify({ total: filtered.length, issues: filtered }, null, 2)}\n`,
    );
  } else {
    console.log(
      `[tx-check v0] 扫描 ${sourceFiles.length} 个 .ts 文件 (targets: ${opts.paths.join(", ")})`,
    );
    printTextReport(filtered, opts.types);
  }

  if (opts.writeReport) {
    const isPartialScan = opts.pathsExplicit || !!opts.types;
    const incrementalEnabled = !opts.forceReport && !isPartialScan;

    const absOutDir = path.isAbsolute(opts.outDir)
      ? opts.outDir
      : path.join(ROOT, opts.outDir);
    const diff = incrementalEnabled
      ? diffAgainstBaseline(filtered, absOutDir)
      : null;

    const shouldWrite =
      opts.forceReport ||
      isPartialScan ||
      !diff ||
      diff.added.length > 0 ||
      diff.baselinePath === null;

    if (!shouldWrite && diff) {
      if (!opts.json) {
        console.log(`[tx-check v0] 增量判定: 无新增 finding，跳过写入报告`);
        console.log(
          `  baseline: ${path.relative(ROOT, diff.baselinePath as string)}`,
        );
        console.log(
          `  unchanged=${diff.unchanged}  removed=${diff.removed.length}  added=0`,
        );
        if (diff.removed.length > 0) {
          console.log(
            `  ✓ 已修复 ${diff.removed.length} 条历史 finding（如需刷新 baseline，重跑加 --force-report）`,
          );
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
      const { mdPath, jsonPath } = writeReportFiles(
        filtered,
        meta,
        opts.outDir,
      );
      if (!opts.json) {
        if (diff && diff.baselinePath) {
          console.log(`[tx-check v0] 增量判定: 检测到新增 finding，写入新报告`);
          console.log(`  baseline: ${path.relative(ROOT, diff.baselinePath)}`);
          console.log(
            `  added=${diff.added.length}  removed=${diff.removed.length}  unchanged=${diff.unchanged}`,
          );
        } else if (incrementalEnabled) {
          console.log(`[tx-check v0] 增量判定: 未找到 baseline，写入首份报告`);
        } else if (isPartialScan) {
          console.log(
            `[tx-check v0] 局部扫描（启用了 --paths/--types），跳过增量判定，直接写报告`,
          );
        }
        console.log(`[tx-check v0] 报告已写入:`);
        console.log(`  ${path.relative(ROOT, mdPath)}`);
        console.log(`  ${path.relative(ROOT, jsonPath)}`);
      }
    }
  }

  if (opts.strict && filtered.length > 0) process.exit(1);
}

main();
