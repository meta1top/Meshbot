#!/usr/bin/env tsx
/**
 * Dead Export Fence v0 — 静态围栏检测「跨文件死导出符号」
 *
 * 与 .cursor/rules/dev-workflow.mdc 「代码卫生」章节对齐，与 biome 的 noUnusedImports/noUnusedVariables（L1，单文件）
 * 互补：本脚本检测 L2，即 export 出去但全仓没有任何文件 import 的符号。
 *
 * 核心策略：保守优先，宁漏不误
 *   - **不**自动删除任何代码，只生成报告供人审
 *   - **跳过**所有可能被框架反射 / DI / 路由 / Swagger / TypeORM 等"非 import"路径消费的导出（详见 SAFE_DECORATORS）
 *   - 同名跨文件 export 时，只要任一处被 import 就算活（避免误报，会导致漏报，可接受）
 *
 * 检查 1 类问题：
 *   DEAD_EXPORT — 命名 export 在全仓 import 列表中找不到匹配（且不命中保守过滤白名单）
 *
 * 用法：
 *   pnpm check:dead                                 全仓扫描，stdout + 增量写报告
 *   pnpm check:dead -- --json                       stdout 改为 JSON
 *   pnpm check:dead -- --strict                     有 finding 时 exit 1（CI 用）
 *   pnpm check:dead -- --paths libs/agent           仅扫指定路径（启用过滤即不写报告）
 *   pnpm check:dead -- --no-report                  强制不写报告（仅 stdout）
 *   pnpm check:dead -- --force-report               强制写报告（无视增量判定，刷 baseline 用）
 *   pnpm check:dead -- --out-dir <path>             覆盖报告目录（默认 docs/audits/dead-fence）
 *
 * 报告输出位置：
 *   docs/audits/dead-fence/<YYYY-MM-DD-HHmm>.md   人读
 *   docs/audits/dead-fence/<YYYY-MM-DD-HHmm>.json 机读
 *
 * 局部豁免：
 *   - 文件首部 500 字符内 `dead-check: ignore-file` → 跳过整个文件
 *   - export 上方 leading 注释中 `dead-check: ignore` → 跳过该 export
 *   - JSDoc 中 `@public-api` → 跳过该 export（语义化：标记为对外 API、即使现在无引用方）
 *
 * v0 已知局限：
 *   - 同名跨文件 export 任一被 import 即算活 → 漏报，不会误报
 *   - 不解析 barrel re-export 链路；用 `export * from` / `export { x } from` 的纯中转文件整文件跳过
 *   - 不识别动态 import / require / 字符串 import 路径
 *   - default export 一律跳过（框架文件加载常用）
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  type ClassDeclaration,
  type EnumDeclaration,
  type FunctionDeclaration,
  type InterfaceDeclaration,
  Node,
  Project,
  type SourceFile,
  SyntaxKind,
  type TypeAliasDeclaration,
  type VariableStatement,
} from "ts-morph";

const ROOT = path.resolve(__dirname, "..");

/**
 * 命中以下任一装饰器的类，被视为「框架/反射消费」，跳过死导出检测
 * （DI 注册、路由注册、Swagger 反射、TypeORM 元数据等不通过 import 链路引用）
 */
const SAFE_DECORATORS = new Set([
  "Injectable",
  "Controller",
  "Module",
  "Global",
  "Processor",
  "Resolver",
  "Catch",
  "WebSocketGateway",
  "SubscribeMessage",
  "EventPattern",
  "MessagePattern",
  "Sse",
  "Entity",
  "ViewEntity",
  "ChildEntity",
  "EventSubscriber",
  "MigrationInterface",
  "ApiTags",
  "ApiExtraModels",
  "Schema",
  "ObjectType",
  "InputType",
  "Args",
  "Mutation",
  "Query",
  "Field",
]);

/**
 * 命中以下基类名的类，被视为框架反射消费（DTO / Entity / Migration）
 */
const SAFE_BASE_CLASSES = new Set([
  "MigrationInterface",
  "BaseEntity",
  "createZodDto",
  "createI18nZodDto",
]);

/**
 * 命中以下文件名后缀，整文件跳过死导出检测
 */
const SKIP_FILENAME_SUFFIXES = [
  ".d.ts",
  ".spec.ts",
  ".test.ts",
  ".e2e-spec.ts",
  ".config.ts",
  ".module.ts",
  ".entity.ts",
  ".migration.ts",
  ".dto.ts",
  ".controller.ts",
  ".processor.ts",
  ".resolver.ts",
  ".gateway.ts",
  ".guard.ts",
  ".interceptor.ts",
  ".filter.ts",
  ".pipe.ts",
  ".strategy.ts",
];

/**
 * 命中以下 basename 整文件跳过（框架/构建/入口文件）
 */
const SKIP_FILENAMES = new Set([
  "main.ts",
  "app.module.ts",
  "next.config.ts",
  "jest.config.ts",
  "vite.config.ts",
  "vitest.config.ts",
  "instrumentation.ts",
  "middleware.ts",
  "proxy.ts",
  "tailwind.config.ts",
  "postcss.config.ts",
  "tsup.config.ts",
  "drizzle.config.ts",
]);

/**
 * 命中以下路径片段整文件跳过
 */
const SKIP_PATH_FRAGMENTS = [
  "/node_modules/",
  "/dist/",
  "/.next/",
  "/coverage/",
  "/test/",
  "/tests/",
  "/__tests__/",
  "/migrations/",
  "/openspec/",
  "/scripts/",
  "/e2b/",
  "/apps/web-",
  "/apps/cli-agent/",
  "/apps/desktop/",
  "/libs/agent/",
  "/packages/",
  /**
   * libs/types* 是公共 SDK 类型包，对外暴露 zod schema / 推断 type / 常量 enum，
   * 即使当前没有内部消费方，也不应算"死代码"——它们的存在意义就是对外 API。
   */
  "/libs/types/src/",
  "/libs/types-agent/src/",
  "/libs/types-main/src/",
  /**
   * .schema.ts 文件是 zod schema DSL 文件，常见模式是同文件内 z.infer / z.enum 消费，
   * 大量 schema/type 误报，整文件跳过更稳。
   */
];

/**
 * .schema.ts 后缀文件整文件跳过（zod schema 文件，类似 SDK 类型）
 * （其余后缀已包含在 SKIP_FILENAME_SUFFIXES）
 */
const EXTRA_SKIP_SUFFIXES = [".schema.ts"];

type ExportKind = "class" | "function" | "const" | "let" | "var" | "type" | "interface" | "enum";

interface ExportRecord {
  file: string;
  line: number;
  name: string;
  kind: ExportKind;
}

interface Issue {
  type: "DEAD_EXPORT";
  file: string;
  line: number;
  className: string; // 这里复用字段：放 export 所在的 file basename，便于报告对齐
  methodName: string; // 这里复用字段：放 export 名
  details: string;
  evidence?: string[];
  hint?: string;
}

interface CliOptions {
  json: boolean;
  strict: boolean;
  paths: string[];
  pathsExplicit: boolean;
  writeReport: boolean;
  forceReport: boolean;
  outDir: string;
}

const DEFAULT_PATHS = ["libs", "apps"];
const DEFAULT_REPORT_DIR = "docs/audits/dead-fence";

const HINT =
  "全仓未发现对该 export 的命名 import。请确认：\n" +
  "      1. 是否真的不再被任何代码引用 → 直接删除（含 export 关键字本身）\n" +
  "      2. 是否通过反射 / 字符串路径 / 动态 import 被消费 → 在符号上方加 `// dead-check: ignore` 或 `@public-api` JSDoc\n" +
  "      3. 是否本就是对外 API（如 SDK 包公开导出）→ 加 `@public-api` 标记说明意图";

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    json: false,
    strict: false,
    paths: DEFAULT_PATHS,
    pathsExplicit: false,
    writeReport: true,
    forceReport: false,
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
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  return opts;
}

function printHelp() {
  console.log(`
Dead Export Fence v0

用法:
  pnpm check:dead                                       全仓扫描，stdout + 增量写报告
  pnpm check:dead -- --json                             stdout 改为 JSON
  pnpm check:dead -- --strict                           有 finding 时 exit 1（CI 用）
  pnpm check:dead -- --paths libs/agent                 仅扫指定路径
  pnpm check:dead -- --no-report                        强制跳过报告写入
  pnpm check:dead -- --force-report                     强制写报告（无视增量判定，刷 baseline 用）
  pnpm check:dead -- --out-dir <path>                   覆盖报告输出目录（默认 ${DEFAULT_REPORT_DIR}）

豁免:
  - 文件首部 500 字符内 \`dead-check: ignore-file\`
  - export 上方 leading 注释中 \`dead-check: ignore\`
  - JSDoc 中 \`@public-api\`（语义化）

设计原则: 保守优先，宁漏不误。所有命中 NestJS 装饰器 / TypeORM Entity / Migration / 各类框架后缀（.module.ts / .controller.ts /
.entity.ts / .processor.ts / .gateway.ts / .filter.ts ...）的文件整文件跳过。报告里的 finding 都是【纯业务符号】层面的死导出。
`);
}

function shouldSkipFile(filePath: string): boolean {
  const rel = `/${path.relative(ROOT, filePath)}`;
  for (const frag of SKIP_PATH_FRAGMENTS) {
    if (rel.includes(frag)) return true;
  }
  for (const suf of SKIP_FILENAME_SUFFIXES) {
    if (rel.endsWith(suf)) return true;
  }
  for (const suf of EXTRA_SKIP_SUFFIXES) {
    if (rel.endsWith(suf)) return true;
  }
  const base = path.basename(rel);
  if (SKIP_FILENAMES.has(base)) return true;
  if (rel.endsWith("/proxy.ts") || rel.endsWith("/page.tsx") || rel.endsWith("/layout.tsx")) {
    return true;
  }
  return false;
}

/**
 * 对源文件做文本 token 频次统计
 *   - 用 \b 包围的标识符 regex 切分全文（注释 / 字符串里的 token 也会被纳入，刻意保守）
 *   - 返回 Map<token, count>
 * 用途：
 *   - 同文件 count >= 2 的 export → 视为「同文件内已被消费」，不算死
 *   - 跨文件累加 → 视为该 token 在其他文件出现过 → 算活
 *   - 这种"漏报偏向"对 dead-code 检测正合适——不会误删真活代码
 */
const IDENT_RE = /\b[A-Za-z_$][A-Za-z0-9_$]*\b/g;

function tokenCountsOf(sf: SourceFile): Map<string, number> {
  const counts = new Map<string, number>();
  const text = sf.getFullText();
  const matches = text.match(IDENT_RE);
  if (!matches) return counts;
  for (const t of matches) {
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return counts;
}

/**
 * 判断一个 .ts 文件是否是「纯 barrel re-export 文件」
 * 定义：所有顶层 statement 都是 ExportDeclaration with moduleSpecifier
 * 这种文件不参与 export 检测（它的 export 只是中转）
 */
function isPureBarrel(sf: SourceFile): boolean {
  const stmts = sf.getStatements();
  if (stmts.length === 0) return false;
  let hasReExport = false;
  for (const stmt of stmts) {
    if (Node.isImportDeclaration(stmt)) continue;
    if (Node.isExportDeclaration(stmt)) {
      if (stmt.getModuleSpecifier()) {
        hasReExport = true;
        continue;
      }
      return false;
    }
    return false;
  }
  return hasReExport;
}

function fileHasIgnoreComment(sf: SourceFile): boolean {
  return /dead-check:\s*ignore-file\b/.test(sf.getFullText().slice(0, 500));
}

function nodeHasIgnoreComment(node: Node): boolean {
  for (const r of node.getLeadingCommentRanges()) {
    const txt = r.getText();
    if (/dead-check:\s*ignore\b/.test(txt)) return true;
    if (/@public-api\b/.test(txt)) return true;
  }
  return false;
}

function classHasSafeDecorator(cls: ClassDeclaration): boolean {
  for (const dec of cls.getDecorators()) {
    if (SAFE_DECORATORS.has(dec.getName())) return true;
  }
  const ext = cls.getExtends();
  if (ext) {
    const txt = ext.getExpression().getText().split(/[<(]/)[0];
    if (SAFE_BASE_CLASSES.has(txt)) return true;
  }
  for (const impl of cls.getImplements()) {
    const txt = impl.getExpression().getText().split(/[<(]/)[0];
    if (SAFE_BASE_CLASSES.has(txt)) return true;
  }
  return false;
}

/**
 * Pass 1: 收集所有命名 export 符号（已过滤同文件内消费）
 *
 * @param sourceFiles 全仓 source files
 * @param countsByFile 每个文件的 token → count 频次表（用于过滤同文件消费的 export）
 */
function collectExports(
  sourceFiles: SourceFile[],
  countsByFile: Map<string, Map<string, number>>,
): ExportRecord[] {
  const records: ExportRecord[] = [];
  for (const sf of sourceFiles) {
    if (shouldSkipFile(sf.getFilePath())) continue;
    if (isPureBarrel(sf)) continue;
    if (fileHasIgnoreComment(sf)) continue;

    const fileTokens = countsByFile.get(sf.getFilePath()) ?? new Map();

    /**
     * 同文件 token 出现次数 >= 2 → 一次定义 + 至少一次其他位置使用 → 视为同文件消费
     * （宁漏不误：注释/字符串里的 token 也算消费，可以避免误报）
     */
    const pushIfNotSelfRef = (rec: ExportRecord) => {
      const cnt = fileTokens.get(rec.name) ?? 0;
      if (cnt >= 2) return;
      records.push(rec);
    };

    for (const cls of sf.getClasses() as ClassDeclaration[]) {
      if (!cls.isExported()) continue;
      if (cls.isDefaultExport()) continue;
      if (classHasSafeDecorator(cls)) continue;
      if (nodeHasIgnoreComment(cls)) continue;
      const name = cls.getName();
      if (!name) continue;
      pushIfNotSelfRef({
        file: sf.getFilePath(),
        line: cls.getStartLineNumber(),
        name,
        kind: "class",
      });
    }

    for (const fn of sf.getFunctions() as FunctionDeclaration[]) {
      if (!fn.isExported()) continue;
      if (fn.isDefaultExport()) continue;
      if (nodeHasIgnoreComment(fn)) continue;
      const name = fn.getName();
      if (!name) continue;
      pushIfNotSelfRef({
        file: sf.getFilePath(),
        line: fn.getStartLineNumber(),
        name,
        kind: "function",
      });
    }

    for (const vs of sf.getVariableStatements() as VariableStatement[]) {
      if (!vs.isExported()) continue;
      if (nodeHasIgnoreComment(vs)) continue;
      const kind: ExportKind =
        vs.getDeclarationKind() === "const" ? "const" : vs.getDeclarationKind() === "let" ? "let" : "var";
      for (const decl of vs.getDeclarations()) {
        const nameNode = decl.getNameNode();
        if (!Node.isIdentifier(nameNode)) continue;
        pushIfNotSelfRef({
          file: sf.getFilePath(),
          line: vs.getStartLineNumber(),
          name: nameNode.getText(),
          kind,
        });
      }
    }

    for (const ta of sf.getTypeAliases() as TypeAliasDeclaration[]) {
      if (!ta.isExported()) continue;
      if (ta.isDefaultExport()) continue;
      if (nodeHasIgnoreComment(ta)) continue;
      pushIfNotSelfRef({
        file: sf.getFilePath(),
        line: ta.getStartLineNumber(),
        name: ta.getName(),
        kind: "type",
      });
    }

    for (const itf of sf.getInterfaces() as InterfaceDeclaration[]) {
      if (!itf.isExported()) continue;
      if (itf.isDefaultExport()) continue;
      if (nodeHasIgnoreComment(itf)) continue;
      pushIfNotSelfRef({
        file: sf.getFilePath(),
        line: itf.getStartLineNumber(),
        name: itf.getName(),
        kind: "interface",
      });
    }

    for (const en of sf.getEnums() as EnumDeclaration[]) {
      if (!en.isExported()) continue;
      if (en.isDefaultExport()) continue;
      if (nodeHasIgnoreComment(en)) continue;
      pushIfNotSelfRef({
        file: sf.getFilePath(),
        line: en.getStartLineNumber(),
        name: en.getName(),
        kind: "enum",
      });
    }
  }
  return records;
}

/**
 * 计算「跨文件其他文件中出现的 token 计数」
 *   otherFilesCount(name, file_e) = globalCount(name) - localCount(name, file_e)
 * 一个 export `(file_e, name)` 是死的，当且仅当：
 *   localCount(name, file_e) <= 1   （未在自己文件其他位置消费，已在 collectExports 过滤）
 *   且 otherFilesCount(name, file_e) === 0  （全仓其他文件都没出现这个 token）
 *
 * 这种 token 频次判定相比"严格 import AST 解析"更宽松：
 *   - import { Foo } from '...'                  → 文件中出现 token Foo
 *   - import * as ns; ns.Foo                     → 文件中出现 token Foo
 *   - export { Foo } from '...' (barrel re-export) → 文件中出现 token Foo
 *   - 反射 / 字符串 / 注释里出现 token             → 也算"被引用"（保守，避免误删活代码）
 *   - 漏报方向：动态 import + 字符串拼接 / 同名跨文件混用，可能漏检真死代码
 */
function diagnoseDeadExports(
  exports: ExportRecord[],
  globalCounts: Map<string, number>,
  countsByFile: Map<string, Map<string, number>>,
): Issue[] {
  const issues: Issue[] = [];
  for (const e of exports) {
    const localCount = countsByFile.get(e.file)?.get(e.name) ?? 0;
    const globalCount = globalCounts.get(e.name) ?? 0;
    const otherFilesCount = globalCount - localCount;
    if (otherFilesCount > 0) continue;

    const rel = path.relative(ROOT, e.file);
    issues.push({
      type: "DEAD_EXPORT",
      file: e.file,
      line: e.line,
      className: path.basename(rel),
      methodName: e.name,
      details: `export ${e.kind} \`${e.name}\` 在全仓任何文件（含本文件本身）都找不到第二处引用（已跳过装饰器类 / 框架文件 / barrel / SDK types 包）`,
      evidence: [`${rel}:${e.line}: export ${e.kind} ${e.name}`],
      hint: HINT,
    });
  }
  return issues;
}

interface ReportMeta {
  generatedAt: Date;
  paths: string[];
  fileCount: number;
  exportCount: number;
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
  const lines: string[] = [];
  lines.push(`# dead-exports fence report ${formatReportTimestamp(meta.generatedAt)}`);
  lines.push("");
  lines.push(`- **生成时间**: ${formatHumanTimestamp(meta.generatedAt)}`);
  lines.push(`- **扫描路径**: ${meta.paths.join(", ")}`);
  lines.push(`- **扫描文件数**: ${meta.fileCount}`);
  lines.push(`- **候选 export 总数**（已过滤）: ${meta.exportCount}`);
  lines.push(`- **执行模式**: ${meta.strict ? "strict (CI)" : "report-only"}`);
  lines.push(`- **死导出 finding 数**: ${issues.length}`);
  lines.push("");
  lines.push("## 设计原则");
  lines.push("");
  lines.push("**保守优先，宁漏不误**：本围栏跳过所有可能被框架反射 / DI / 路由消费的导出，所以列出的 finding 都是「非框架装饰器修饰的纯业务符号」。");
  lines.push("");
  lines.push("自动跳过的范围：");
  lines.push("- NestJS 装饰器类：`@Injectable` / `@Controller` / `@Module` / `@Processor` / `@Resolver` / `@WebSocketGateway` 等");
  lines.push("- TypeORM 实体：`@Entity` / `@ViewEntity` / `MigrationInterface`");
  lines.push("- Swagger 反射：`@ApiTags` / `@ApiExtraModels` / `@ObjectType`");
  lines.push("- 框架文件后缀：`.module.ts` / `.controller.ts` / `.processor.ts` / `.gateway.ts` / `.entity.ts` / `.dto.ts` / `.config.ts` / `.guard.ts` / `.filter.ts` / `.schema.ts` / ...");
  lines.push("- 入口文件：`main.ts` / `app.module.ts` / `next.config.ts` / `proxy.ts` / `instrumentation.ts` / `*.config.ts`");
  lines.push("- 公共 SDK 类型包：`libs/types*` 系列（对外 API 暴露，即使无内部消费方也合理）");
  lines.push("- 纯 barrel re-export 文件（所有顶层语句都是 `export ... from`）");
  lines.push("- `default export`（框架按文件路径加载常见）");
  lines.push("- **同文件内消费**：export 名称在本文件其他位置被引用（如 zod 的 `z.enum(STATUSES)`、interface 内被 type 使用）");
  lines.push("- 测试文件 (`.spec.ts` / `.e2e-spec.ts` / `__tests__/`)、迁移文件、scripts、openspec、web-* 应用");
  lines.push("");
  lines.push("## 漏报说明");
  lines.push("");
  lines.push("- **同名跨文件 export**：任一处被 import 即算活，可能漏报真正死的同名 export");
  lines.push("- **命名空间 import** (`import * as ns`)：通过 `ns.X` 解析的属性视为消费 X，但跨文件解析仅在该 ns import 所在文件");
  lines.push("- **动态 import** / 字符串路径 / `require()` 不识别");
  lines.push("");

  if (issues.length === 0) {
    lines.push("## 详情");
    lines.push("");
    lines.push("> 死导出围栏全绿，无 finding。");
    lines.push("");
    return lines.join("\n");
  }

  lines.push("## 详情");
  lines.push("");
  const grouped = new Map<string, Issue[]>();
  for (const i of issues) {
    const dir = path.relative(ROOT, path.dirname(i.file));
    const key = dir;
    const arr = grouped.get(key) ?? [];
    arr.push(i);
    grouped.set(key, arr);
  }
  const sortedDirs = [...grouped.keys()].sort();
  for (const dir of sortedDirs) {
    const list = grouped.get(dir) ?? [];
    lines.push(`### \`${dir}\` (${list.length})`);
    lines.push("");
    for (const i of list) {
      const rel = path.relative(ROOT, i.file);
      lines.push(`- **\`${rel}:${i.line}\`** — \`${i.methodName}\``);
      lines.push(`  - ${i.details}`);
      if (i.evidence?.length) {
        for (const e of i.evidence) lines.push(`  - evidence: \`${e}\``);
      }
    }
    lines.push("");
  }
  lines.push("## 修复指引");
  lines.push("");
  lines.push("对每条 finding，按以下顺序判定：");
  lines.push("");
  lines.push("1. **真死代码** → 直接删除（连带 export 关键字一起）");
  lines.push("2. **被反射 / 字符串路径 / 动态 import 消费** → 在 export 上方加 `// dead-check: ignore` 或 JSDoc `@public-api`");
  lines.push("3. **对外 API（如 packages/* 的对外导出）** → JSDoc 加 `@public-api` 表明意图");
  lines.push("");
  return lines.join("\n");
}

/**
 * Issue 指纹：file + name + kind 描述（忽略行号）
 */
function issueFingerprint(i: Issue): string {
  const rel = path.relative(ROOT, i.file);
  return `${i.type}|${rel}|${i.methodName}`;
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
        exportCount: meta.exportCount,
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

function loadProject(targets: string[]): Project {
  const project = new Project({
    tsConfigFilePath: path.join(ROOT, "tsconfig.base.json"),
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { allowJs: false, noEmit: true },
  });
  for (const target of targets) {
    const abs = path.resolve(ROOT, target);
    if (!fs.existsSync(abs)) {
      console.warn(`[dead-check] target 不存在: ${target}`);
      continue;
    }
    project.addSourceFilesAtPaths([
      `${abs}/**/*.ts`,
      `${abs}/**/*.tsx`,
      `!${abs}/**/*.d.ts`,
      `!${abs}/**/node_modules/**`,
      `!${abs}/**/dist/**`,
      `!${abs}/**/.next/**`,
    ]);
  }
  return project;
}

function printTextReport(issues: Issue[]) {
  console.log(`\n[dead-check v0] 共发现 ${issues.length} 个死导出 finding\n`);
  if (issues.length === 0) return;

  const grouped = new Map<string, Issue[]>();
  for (const i of issues) {
    const dir = path.relative(ROOT, path.dirname(i.file));
    const arr = grouped.get(dir) ?? [];
    arr.push(i);
    grouped.set(dir, arr);
  }
  const sortedDirs = [...grouped.keys()].sort();
  for (const dir of sortedDirs) {
    const list = grouped.get(dir) ?? [];
    console.log(`──────── ${dir} (${list.length}) ────────`);
    for (const i of list) {
      const rel = path.relative(ROOT, i.file);
      console.log(`  ${rel}:${i.line}  ${i.methodName}  — ${i.details}`);
    }
    console.log("");
  }
  console.log(
    "  → 修复：删除 / 加 // dead-check: ignore / 加 @public-api JSDoc。详见 docs/audits/dead-fence/<最新>.md",
  );
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const project = loadProject(opts.paths);
  const sourceFiles = project.getSourceFiles();

  /**
   * 文本 token 化：一次遍历同时拿到「每个文件的 token 频次表」+「全仓 token 频次累加表」
   * 后续判定「同文件消费」「跨文件引用」都基于这两张表，避免昂贵的 AST 遍历
   */
  const countsByFile = new Map<string, Map<string, number>>();
  const globalCounts = new Map<string, number>();
  for (const sf of sourceFiles) {
    const counts = tokenCountsOf(sf);
    countsByFile.set(sf.getFilePath(), counts);
    for (const [name, c] of counts) {
      globalCounts.set(name, (globalCounts.get(name) ?? 0) + c);
    }
  }

  const exportRecords = collectExports(sourceFiles, countsByFile);
  const issues = diagnoseDeadExports(exportRecords, globalCounts, countsByFile);

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ total: issues.length, issues }, null, 2)}\n`);
  } else {
    console.log(
      `[dead-check v0] 扫描 ${sourceFiles.length} 个源文件 (targets: ${opts.paths.join(", ")})；候选 export ${exportRecords.length} 个`,
    );
    printTextReport(issues);
  }

  if (opts.writeReport) {
    const isPartialScan = opts.pathsExplicit;
    const incrementalEnabled = !opts.forceReport && !isPartialScan;
    const absOutDir = path.isAbsolute(opts.outDir) ? opts.outDir : path.join(ROOT, opts.outDir);
    const diff = incrementalEnabled ? diffAgainstBaseline(issues, absOutDir) : null;

    const shouldWrite =
      opts.forceReport || isPartialScan || !diff || diff.added.length > 0 || diff.baselinePath === null;

    if (!shouldWrite && diff) {
      if (!opts.json) {
        console.log(`[dead-check v0] 增量判定: 无新增 finding，跳过写入报告`);
        console.log(`  baseline: ${path.relative(ROOT, diff.baselinePath as string)}`);
        console.log(`  unchanged=${diff.unchanged}  removed=${diff.removed.length}  added=0`);
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
        exportCount: exportRecords.length,
        strict: opts.strict,
      };
      const { mdPath, jsonPath } = writeReportFiles(issues, meta, opts.outDir);
      if (!opts.json) {
        if (diff && diff.baselinePath) {
          console.log(`[dead-check v0] 增量判定: 检测到新增 finding，写入新报告`);
          console.log(`  baseline: ${path.relative(ROOT, diff.baselinePath)}`);
          console.log(`  added=${diff.added.length}  removed=${diff.removed.length}  unchanged=${diff.unchanged}`);
        } else if (incrementalEnabled) {
          console.log(`[dead-check v0] 增量判定: 未找到 baseline，写入首份报告`);
        } else if (isPartialScan) {
          console.log(`[dead-check v0] 局部扫描（启用了 --paths），跳过增量判定，直接写报告`);
        }
        console.log(`[dead-check v0] 报告已写入:`);
        console.log(`  ${path.relative(ROOT, mdPath)}`);
        console.log(`  ${path.relative(ROOT, jsonPath)}`);
      }
    }
  }

  if (opts.strict && issues.length > 0) process.exit(1);
}

main();
