#!/usr/bin/env tsx
/**
 * Scope Access Fence v0 — 账号隔离静态围栏（per-account data isolation v3 的机械护栏）
 *
 * 背景：账号作用域 Entity 现都带 `cloud_user_id` 列；其归属 Service 必须把所有查询
 * 路由到 `ScopedRepository`（工厂 `scopedFactory.create(rawRepo)` 包出的作用域仓库，
 * 自动注入当前账号过滤 / 盖章）。本围栏机械拦截「开发者在裸 `Repository` 上直接写
 * `this.repo.find(...)` 而忘了账号过滤」——这类裸查询会跨账号泄露数据。
 *
 * 检查 1 类问题：
 *   UNSCOPED_QUERY — 在「裸仓库」（@InjectRepository 注入的 Repository 参数，或直接
 *                    从该参数赋值的字段 tx-anchor）上直接调用查询方法，绕过 ScopedRepository。
 *
 * 判定细节：
 *   1. 作用域 Entity：扫 *.entity.ts，@Entity 类里存在某属性的 @Column/@PrimaryColumn
 *      装饰器设置了 name:"cloud_user_id"。显式排除 CloudIdentity（账号注册表本身，其
 *      cloud_user_id 是身份键，CloudIdentityService 按 cloudUserId 查它是合法的）。
 *   2. 归属 Service：构造函数参数 @InjectRepository(X)（X 属作用域 Entity 集合）。
 *      记录裸参数名；以及「直接从该参数赋值的字段」（如 this.txAnchorRepo = rawRepo）。
 *   3. 违规：在裸参数 / 裸字段上直接调用查询方法 ∈ QUERY_METHODS。
 *      - 合规模式：裸参数传入 scopedFactory.create(raw) 后存进字段，查询走那个【作用域
 *        字段】（ScopedRepository，非裸仓库）→ 不算违规。
 *      - 裸参数 / 裸字段仅 (a) 传给 create(...) 和/或 (b) 持作 tx-anchor 字段、但从未被
 *        调用查询方法 → 不算违规。
 *      - this.scopedField.unscoped().find(...)：.unscoped() 是 ScopedRepository 的方法
 *        （被认可、可审计的逃逸口），其 receiver 不是裸仓库 → 不 flag。
 *   4. 行级豁免：携带 `// scope-check: allow-unscoped` 的语句行豁免。
 *      文件级豁免：首部 500 字符内出现 `scope-check: ignore-file` → 跳过整个文件。
 *   5. 跳过 test/spec、dist、node_modules、非 server-agent 应用（前端 / CLI / 桌面 / agent）。
 *
 * 用法（与 check:repo 对齐）：
 *   pnpm check:scope                          全仓扫描，stdout + 增量写报告
 *   pnpm check:scope -- --json                stdout 改为 JSON 格式
 *   pnpm check:scope -- --strict              发现问题时 exit 1（CI 用）
 *   pnpm check:scope -- --paths apps/server-agent  仅扫描指定路径（逗号分隔，启用过滤即不写报告）
 *   pnpm check:scope -- --no-report           强制跳过报告文件写入
 *   pnpm check:scope -- --force-report        强制写报告（无视增量判定，刷 baseline 用）
 *   pnpm check:scope -- --out-dir <path>      覆盖报告目录（默认 docs/audits/scope-fence）
 *
 * 报告写入策略（增量，复用 check:repo 机制）：
 *   - 默认仅当当前 finding 集合相对最新 baseline JSON 出现【新增】时才写新报告。
 *   - 启用 --paths 过滤、或加 --force-report → 关闭增量，直接写。
 *
 * 报告输出位置：
 *   docs/audits/scope-fence/<YYYY-MM-DD-HHmm>.md   人读
 *   docs/audits/scope-fence/<YYYY-MM-DD-HHmm>.json 机读（baseline 比对源）
 *
 * 单元测试入口：export 的 {@link runScopeCheck} 接受 虚拟文件名→源码 的 map，内存
 * 构建 ts-morph project 并返回 findings —— 供 check-scope-access.spec.ts 喂固件。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  type ClassDeclaration,
  type Decorator,
  type Expression,
  type Node,
  Project,
  type SourceFile,
  SyntaxKind,
} from "ts-morph";
import { collectTsFiles } from "./lib/ts-files";

const ROOT = path.resolve(__dirname, "..");

/**
 * 账号注册表本身的显式豁免：CloudIdentity 的 cloud_user_id 是【身份键】而非
 * 「当前账号」过滤字段，CloudIdentityService 合法地按 cloudUserId 查它，不应被
 * ScopedRepository 包裹。硬编码这唯一一个排除项。
 */
const REGISTRY_ENTITY_EXCLUSION = new Set<string>(["CloudIdentity"]);

/** 触发违规判定的 TypeORM 查询 / 写入方法名（在裸仓库上调用即泄露风险）。 */
const QUERY_METHODS = new Set<string>([
  "find",
  "findOne",
  "findOneBy",
  "findBy",
  "findAndCount",
  "count",
  "countBy",
  "save",
  "insert",
  "update",
  "delete",
  "remove",
  "upsert",
  "createQueryBuilder",
  "query",
]);

type IssueType = "UNSCOPED_QUERY";

interface Issue {
  type: IssueType;
  entity: string;
  file: string;
  line: number;
  className: string;
  details: string;
  hint?: string;
}

interface CliOptions {
  json: boolean;
  strict: boolean;
  paths: string[];
  mapOnly: boolean;
  /** false = --no-report 强制不写；true = 默认，是否写由增量判定决定 */
  writeReport: boolean;
  /** true = --force-report 无视增量判定一定写 */
  forceReport: boolean;
  /** 标记 paths 是否被用户显式指定（用于关闭增量） */
  pathsExplicit: boolean;
  outDir: string;
}

// 作用域 Entity 只在 server-agent；但 libs 也可能持有 Service，扫描范围与 check:repo 对齐。
const DEFAULT_PATHS = ["apps/server-agent", "libs"];
const DEFAULT_REPORT_DIR = "docs/audits/scope-fence";

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    json: false,
    strict: false,
    paths: DEFAULT_PATHS,
    mapOnly: false,
    writeReport: true,
    forceReport: false,
    pathsExplicit: false,
    outDir: DEFAULT_REPORT_DIR,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") opts.json = true;
    else if (a === "--strict") opts.strict = true;
    else if (a === "--map") opts.mapOnly = true;
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
Scope Access Fence v0 — 账号隔离静态围栏

用法:
  pnpm check:scope                              全仓扫描，stdout + 增量写报告
  pnpm check:scope -- --json                    stdout 改为 JSON 格式
  pnpm check:scope -- --strict                  有问题时 exit 1（CI 用）
  pnpm check:scope -- --paths apps/server-agent 仅扫指定路径（逗号分隔，启用过滤即不写报告）
  pnpm check:scope -- --map                     仅打印作用域 Entity / 归属 Service 映射，不做检查
  pnpm check:scope -- --no-report               强制跳过报告文件写入（仅 stdout）
  pnpm check:scope -- --force-report            强制写报告（无视增量判定，刷 baseline 用）
  pnpm check:scope -- --out-dir <path>          覆盖报告输出目录（默认 ${DEFAULT_REPORT_DIR}）

检查规则:
  UNSCOPED_QUERY  裸仓库（@InjectRepository 注入的 Repository 参数 / 直接赋值字段）
                  上直接调用查询方法，绕过 ScopedRepository 的账号过滤。
`);
}

function getRelPath(absPath: string): string {
  return path.relative(ROOT, absPath);
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
  )
    return true;
  // 作用域 Entity 只在 server-agent；其余应用不跑 Agent 业务逻辑，跳过。
  if (rel.startsWith("apps/web-") || rel.includes("/apps/web-")) return true;
  if (rel.startsWith("apps/cli") || rel.includes("/apps/cli/")) return true;
  if (rel.startsWith("apps/desktop") || rel.includes("/apps/desktop/"))
    return true;
  if (rel.startsWith("apps/server-main") || rel.includes("/apps/server-main/"))
    return true;
  // libs/main 是云端轨（server-main）的域 lib：Postgres + org/user 多租户，
  // 不跑账号隔离 SQLite 模型；同名 Entity（如 Agent）在此纯属云端/本地两个
  // 无关领域的巧合撞名，不该套用 cloud_user_id 作用域规则。
  if (rel.startsWith("libs/main") || rel.includes("/libs/main/")) return true;
  if (rel.endsWith(".d.ts")) return true;
  return false;
}

function hasIgnoreFileMarker(source: string): boolean {
  const head = source.slice(0, 500);
  return /scope-check:\s*ignore-file/.test(head);
}

/**
 * 提取 @Column(...) / @PrimaryColumn(...) 装饰器对象字面量参数里的 name 值。
 * 处理 @Column({ name: "cloud_user_id", type: "text" }) 等形式；无对象参数返回 null。
 */
function extractColumnName(dec: Decorator): string | null {
  const args = dec.getArguments();
  for (const arg of args) {
    const obj = arg.asKind(SyntaxKind.ObjectLiteralExpression);
    if (!obj) continue;
    const prop = obj.getProperty("name");
    if (!prop) continue;
    const assign = prop.asKind(SyntaxKind.PropertyAssignment);
    if (!assign) continue;
    const init = assign.getInitializer();
    if (!init) continue;
    const lit = init.asKind(SyntaxKind.StringLiteral);
    if (lit) return lit.getLiteralText();
  }
  return null;
}

const COLUMN_DECORATORS = new Set(["Column", "PrimaryColumn"]);

/**
 * 判定一个 Entity 类是否账号作用域：存在某属性的 @Column/@PrimaryColumn 装饰器
 * 设置了 name:"cloud_user_id"。
 */
function isScopedEntityClass(cls: ClassDeclaration): boolean {
  for (const prop of cls.getProperties()) {
    for (const dec of prop.getDecorators()) {
      if (!COLUMN_DECORATORS.has(dec.getName())) continue;
      if (extractColumnName(dec) === "cloud_user_id") return true;
    }
  }
  return false;
}

/** 全仓扫描 *.entity.ts，收集账号作用域 Entity 类名集合（已剔除 CloudIdentity）。 */
function collectScopedEntities(sourceFiles: SourceFile[]): Set<string> {
  const scoped = new Set<string>();
  for (const sf of sourceFiles) {
    if (!/\.entity\.ts$/.test(sf.getFilePath())) continue;
    for (const cls of sf.getClasses()) {
      const hasEntity = cls
        .getDecorators()
        .some((d) => d.getName() === "Entity");
      if (!hasEntity) continue;
      const name = cls.getName();
      if (!name) continue;
      if (REGISTRY_ENTITY_EXCLUSION.has(name)) continue;
      if (isScopedEntityClass(cls)) scoped.add(name);
    }
  }
  return scoped;
}

/** @InjectRepository(EntityName) → EntityName（处理带连接名第二参数的形式）。 */
function extractInjectedEntityName(dec: Decorator): string | null {
  if (dec.getName() !== "InjectRepository") return null;
  const args = dec.getArguments();
  if (args.length === 0) return null;
  const text = args[0].getText().trim();
  return text.length === 0 ? null : text;
}

/** 把 receiver 表达式归一为字段名（this.foo → "foo"）；非 this.字段返回 null。 */
function thisFieldName(expr: Expression): string | null {
  const pae = expr.asKind(SyntaxKind.PropertyAccessExpression);
  if (!pae) return null;
  if (pae.getExpression().getKind() !== SyntaxKind.ThisKeyword) return null;
  return pae.getName();
}

interface RawRepoBindings {
  /** 裸参数名 → Entity 名（构造函数局部）。 */
  rawParams: Map<string, string>;
  /** 裸字段名 → Entity 名（直接 this.F = rawParam 的字段）。 */
  rawFields: Map<string, string>;
  /** 作用域字段名集合（this.F = factory.create(rawParam) 的字段，安全）。 */
  scopedFields: Set<string>;
}

/**
 * 解析一个 Service 类的仓库绑定：
 * - 哪些构造函数参数是裸仓库（@InjectRepository 作用域 Entity）
 * - 哪些字段从工厂 create(rawParam) 赋值（作用域字段，安全）
 * - 哪些字段直接从裸参数赋值（裸字段，tx-anchor 误用风险）
 */
function resolveRawRepoBindings(
  cls: ClassDeclaration,
  scopedEntities: Set<string>,
): RawRepoBindings {
  const rawParams = new Map<string, string>();
  const rawFields = new Map<string, string>();
  const scopedFields = new Set<string>();

  for (const ctor of cls.getConstructors()) {
    for (const param of ctor.getParameters()) {
      for (const dec of param.getDecorators()) {
        const entity = extractInjectedEntityName(dec);
        if (!entity || !scopedEntities.has(entity)) continue;
        const name = param.getName();
        rawParams.set(name, entity);
        // 参数属性简写（private/public/protected/readonly 修饰）→ 该参数同时是
        // 类字段 this.<name>，且就是裸仓库本体。登记为裸字段，确保 this.<name>.find()
        // 被检出（这是「忘了套 ScopedRepository」最常见的写法）。
        if (param.getModifiers().length > 0) rawFields.set(name, entity);
      }
    }

    const body = ctor.getBody();
    if (!body) continue;
    for (const assign of body.getDescendantsOfKind(
      SyntaxKind.BinaryExpression,
    )) {
      if (assign.getOperatorToken().getKind() !== SyntaxKind.EqualsToken)
        continue;
      const field = thisFieldName(assign.getLeft());
      if (!field) continue;
      const rhs = assign.getRight();

      // this.F = <something>.create(<rawParam>) → 作用域字段（安全）
      const call = rhs.asKind(SyntaxKind.CallExpression);
      if (call) {
        const callee = call
          .getExpression()
          .asKind(SyntaxKind.PropertyAccessExpression);
        if (callee && callee.getName() === "create") {
          const arg0 = call.getArguments()[0];
          if (arg0?.asKind(SyntaxKind.Identifier)) {
            const argName = arg0.getText();
            if (rawParams.has(argName)) {
              scopedFields.add(field);
              continue;
            }
          }
        }
      }

      // this.F = <rawParam> → 裸字段（直接持有裸仓库）
      const ident = rhs.asKind(SyntaxKind.Identifier);
      if (ident && rawParams.has(ident.getText())) {
        rawFields.set(field, rawParams.get(ident.getText()) as string);
      }
    }
  }

  return { rawParams, rawFields, scopedFields };
}

/** 判定一条语句是否携带行级豁免注释 `// scope-check: allow-unscoped`。 */
function hasAllowUnscopedComment(node: Node): boolean {
  const stmt = node.getFirstAncestorByKind(SyntaxKind.ExpressionStatement);
  const probe = stmt ?? node;
  const sf = probe.getSourceFile();
  const full = sf.getFullText();
  // 检查节点所在语句之前的前导触发文本（含同行尾注释）。
  const leading = probe.getLeadingCommentRanges();
  for (const c of leading) {
    if (/scope-check:\s*allow-unscoped/.test(c.getText())) return true;
  }
  // 兜底：扫语句起始行往前若干行的源文本（处理装饰/格式差异）。
  const start = probe.getStart();
  const lineStart = full.lastIndexOf("\n", start) + 1;
  const windowText = full.slice(Math.max(0, lineStart - 200), start);
  if (/scope-check:\s*allow-unscoped/.test(windowText)) return true;
  // 同语句内（如尾注释紧跟）也算。
  const stmtText = full.slice(lineStart, probe.getEnd());
  return /scope-check:\s*allow-unscoped/.test(stmtText);
}

/**
 * 扫描一个 Service 类内所有 查询方法调用，命中「裸参数 / 裸字段」receiver 即违规。
 * .unscoped() 链的 receiver 是 CallExpression（非裸标识符/字段），天然不命中。
 */
function detectClassIssues(
  cls: ClassDeclaration,
  sf: SourceFile,
  bindings: RawRepoBindings,
  issues: Issue[],
) {
  if (bindings.rawParams.size === 0) return;
  const className = cls.getName() ?? "<anonymous>";
  const filePath = sf.getFilePath();

  for (const call of cls.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call
      .getExpression()
      .asKind(SyntaxKind.PropertyAccessExpression);
    if (!callee) continue;
    const method = callee.getName();
    if (!QUERY_METHODS.has(method)) continue;

    const receiver = callee.getExpression();
    let entity: string | null = null;

    // receiver = this.<field>
    const field = thisFieldName(receiver);
    if (field !== null) {
      if (bindings.scopedFields.has(field)) continue; // 作用域字段，安全
      entity = bindings.rawFields.get(field) ?? null;
    } else {
      // receiver = <rawParam> 标识符（在构造函数体里直接 raw.find() 之类）
      const ident = receiver.asKind(SyntaxKind.Identifier);
      if (ident) entity = bindings.rawParams.get(ident.getText()) ?? null;
    }

    if (!entity) continue;
    if (hasAllowUnscopedComment(call)) continue;

    issues.push({
      type: "UNSCOPED_QUERY",
      entity,
      file: filePath,
      line: call.getStartLineNumber(),
      className,
      details: `${className} 在裸 ${entity} 仓库上直接调用 ${method}(...)，绕过 ScopedRepository 账号过滤`,
      hint: `应改为通过 scopedFactory.create(rawRepo) 包出的作用域仓库查询；确属系统级跨账号操作请用 .unscoped() 并加 // scope-check: allow-unscoped 注释`,
    });
  }
}

/**
 * 核心检测：内存 / 全仓通用。给定 ts-morph SourceFile 集合，返回全部 finding。
 */
function analyze(sourceFiles: SourceFile[]): Issue[] {
  const scopedEntities = collectScopedEntities(sourceFiles);
  const issues: Issue[] = [];

  for (const sf of sourceFiles) {
    if (hasIgnoreFileMarker(sf.getFullText())) continue;
    for (const cls of sf.getClasses()) {
      const bindings = resolveRawRepoBindings(cls, scopedEntities);
      detectClassIssues(cls, sf, bindings, issues);
    }
  }
  return issues;
}

/**
 * 单元测试入口：接受 虚拟文件名→源码 的 map，内存构建 ts-morph project，返回 findings。
 * 不读磁盘、不写报告，纯函数，供 spec 喂固件。
 */
export function runScopeCheck(files: Record<string, string>): Issue[] {
  const project = new Project({
    useInMemoryFileSystem: true,
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { allowJs: false, noEmit: true },
  });
  for (const [name, source] of Object.entries(files)) {
    project.createSourceFile(name, source, { overwrite: true });
  }
  return analyze(project.getSourceFiles());
}

// ──────────────────────────── 报告 / CLI（复用 check:repo 机制）────────────────────────────

interface ReportMeta {
  generatedAt: Date;
  paths: string[];
  fileCount: number;
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

function printTextReport(issues: Issue[]) {
  console.log(`\n[scope-check v0] 共发现 ${issues.length} 个问题`);
  console.log(
    `  UNSCOPED_QUERY: ${issues.length}  裸仓库上直接查询，绕过 ScopedRepository\n`,
  );
  if (issues.length === 0) return;
  console.log(`──────── UNSCOPED_QUERY (${issues.length}) ────────`);
  for (const i of issues) {
    const rel = getRelPath(i.file);
    console.log(`\n  ${rel}:${i.line}`);
    console.log(`    ${i.className}: ${i.details}`);
    if (i.hint) console.log(`    → ${i.hint}`);
  }
  console.log("");
}

function buildMarkdownReport(issues: Issue[], meta: ReportMeta): string {
  const lines: string[] = [];
  lines.push(`# scope-fence report ${formatReportTimestamp(meta.generatedAt)}`);
  lines.push("");
  lines.push(`- **生成时间**: ${formatHumanTimestamp(meta.generatedAt)}`);
  lines.push(`- **扫描路径**: ${meta.paths.join(", ")}`);
  lines.push(`- **扫描文件数**: ${meta.fileCount}`);
  lines.push(`- **执行模式**: ${meta.strict ? "strict (CI)" : "report-only"}`);
  lines.push(`- **总 finding 数**: ${issues.length}`);
  lines.push("");
  lines.push("## 摘要");
  lines.push("");
  lines.push("| 类别 | 数量 | 含义 |");
  lines.push("| --- | ---: | --- |");
  lines.push(
    `| UNSCOPED_QUERY | ${issues.length} | 裸仓库上直接查询，绕过 ScopedRepository 账号过滤 |`,
  );
  lines.push("");

  if (issues.length === 0) {
    lines.push("## 详情");
    lines.push("");
    lines.push("> 账号隔离围栏全绿，无 finding。");
    lines.push("");
    return lines.join("\n");
  }

  lines.push("## 详情");
  lines.push("");
  lines.push(`### UNSCOPED_QUERY (${issues.length})`);
  lines.push("");
  for (const i of issues) {
    const rel = getRelPath(i.file);
    lines.push(
      `- **\`${rel}:${i.line}\`** — \`${i.className}\` / \`${i.entity}\``,
    );
    lines.push(`  - ${i.details}`);
    if (i.hint) lines.push(`  - hint: ${i.hint}`);
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Issue 指纹：跨次运行对比「是不是同一条 finding」，故意忽略 line（行号位移不算新增）。
 */
function issueFingerprint(i: Issue): string {
  const rel = path.relative(ROOT, i.file);
  return `${i.type}|${i.entity}|${rel}|${i.className}`;
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
    if (baselineFps.has(fp)) unchanged += 1;
    else added.push(i);
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
      console.warn(`[scope-check] target 不存在: ${target}`);
      continue;
    }
    for (const f of collectTsFiles(abs)) project.addSourceFileAtPath(f);
  }
  return project;
}

/** 收集纳入检测的 SourceFile（已过滤跳过文件）。 */
function collectScannedFiles(project: Project): SourceFile[] {
  return project
    .getSourceFiles()
    .filter((sf) => !shouldSkipFile(sf.getFilePath()));
}

function printScopeMap(sourceFiles: SourceFile[]) {
  const scoped = collectScopedEntities(sourceFiles);
  const sorted = Array.from(scoped).sort((a, b) => a.localeCompare(b));
  console.log(
    `\n[scope-check v0] 账号作用域 Entity（带 cloud_user_id，已排除 CloudIdentity）共 ${sorted.length} 个`,
  );
  console.log("─".repeat(60));
  for (const name of sorted) console.log(`  ${name}`);
  console.log("");
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const project = loadProject(opts.paths);
  const scanned = collectScannedFiles(project);

  if (opts.mapOnly) {
    printScopeMap(scanned);
    return;
  }

  const issues = analyze(scanned);

  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify({ total: issues.length, issues }, null, 2)}\n`,
    );
  } else {
    console.log(
      `[scope-check v0] 扫描 ${scanned.length} 个 .ts 文件 (targets: ${opts.paths.join(", ")})`,
    );
    printTextReport(issues);
    if (issues.length === 0) printScopeMap(scanned);
  }

  if (opts.writeReport) {
    const isPartialScan = opts.pathsExplicit;
    const incrementalEnabled = !opts.forceReport && !isPartialScan;

    const absOutDir = path.isAbsolute(opts.outDir)
      ? opts.outDir
      : path.join(ROOT, opts.outDir);
    const diff = incrementalEnabled
      ? diffAgainstBaseline(issues, absOutDir)
      : null;

    const shouldWrite =
      opts.forceReport ||
      isPartialScan ||
      !diff ||
      diff.added.length > 0 ||
      diff.baselinePath === null;

    if (!shouldWrite && diff) {
      if (!opts.json) {
        console.log(`[scope-check v0] 增量判定: 无新增 finding，跳过写入报告`);
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
        fileCount: scanned.length,
        strict: opts.strict,
      };
      const { mdPath, jsonPath } = writeReportFiles(issues, meta, opts.outDir);
      if (!opts.json) {
        if (diff && diff.baselinePath) {
          console.log(
            `[scope-check v0] 增量判定: 检测到新增 finding，写入新报告`,
          );
          console.log(`  baseline: ${path.relative(ROOT, diff.baselinePath)}`);
          console.log(
            `  added=${diff.added.length}  removed=${diff.removed.length}  unchanged=${diff.unchanged}`,
          );
        } else if (incrementalEnabled) {
          console.log(
            `[scope-check v0] 增量判定: 未找到 baseline，写入首份报告`,
          );
        } else if (isPartialScan) {
          console.log(
            `[scope-check v0] 局部扫描（启用了 --paths），跳过增量判定，直接写报告`,
          );
        } else if (opts.forceReport) {
          console.log(
            `[scope-check v0] --force-report 已开启，无视增量判定直接写报告`,
          );
        }
        console.log(`[scope-check v0] 报告已写入:`);
        console.log(`  ${path.relative(ROOT, mdPath)}`);
        console.log(`  ${path.relative(ROOT, jsonPath)}`);
      }
    }
  }

  if (opts.strict && issues.length > 0) process.exit(1);
}

// 仅作为 CLI 直接运行时执行 main()；被 spec import 时不触发（避免误扫真仓库）。
if (require.main === module) {
  main();
}
