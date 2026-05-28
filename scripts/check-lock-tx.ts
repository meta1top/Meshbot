#!/usr/bin/env tsx
/**
 * Lock-Tx Inversion Fence v0 — 静态围栏检测「事务-锁倒置」漏洞
 *
 * 严禁：在 @Transactional 方法内嵌套调用 @WithLock。
 *
 * 检查 2 类问题：
 *   A. LOCK_INSIDE_TX_DECORATOR — 同方法装饰器顺序倒置：@Transactional 在源码上方（外层），@WithLock 在下方（内层）
 *   B. LOCK_INSIDE_TX_CALL      — @Transactional 方法体内调用了带 @WithLock 的方法（同类 this.x() / 跨类 this.field.x()）
 *
 * 核心原理（参见规则）：
 *   锁的临界区 ⊊ 事务的临界区 → 锁释放时事务尚未 COMMIT → 唯一性 / 幂等保护被静默绕过
 *   = "持锁期间事务对外不可见的重入攻击"
 *
 * 用法：
 *   pnpm check:lock-tx                          全仓扫描，stdout + 增量写报告
 *   pnpm check:lock-tx -- --json                stdout 改为 JSON 格式
 *   pnpm check:lock-tx -- --strict              发现问题时 exit 1（CI 用）
 *   pnpm check:lock-tx -- --paths libs/agent    仅扫指定路径（逗号分隔，启用过滤即不写报告）
 *   pnpm check:lock-tx -- --types LOCK_INSIDE_TX_CALL   仅展示指定类别（逗号分隔，启用过滤即不写报告）
 *   pnpm check:lock-tx -- --no-report           强制跳过报告文件写入
 *   pnpm check:lock-tx -- --force-report        强制写报告（无视增量判定，刷 baseline 用）
 *   pnpm check:lock-tx -- --out-dir <path>      覆盖报告目录（默认 docs/audits/lock-tx-fence）
 *
 * 报告输出位置：
 *   docs/audits/lock-tx-fence/<YYYY-MM-DD-HHmm>.md   人读
 *   docs/audits/lock-tx-fence/<YYYY-MM-DD-HHmm>.json 机读
 *
 * 局部豁免：
 *   - 文件首部 500 字符内 `lock-tx-check: ignore-file` → 跳过整个文件
 *   - 方法上方 leading 注释中 `lock-tx-check: ignore` → 跳过该方法
 *   - 方法 JSDoc 中 `@allow-lock-inside-tx` → 跳过该方法（语义化标记）
 *
 * v0 已知局限：
 *   - 调用链只展开 1 层：A.tx 调 A.normal，A.normal 再调 B.lockedMethod 不会被检出
 *   - 跨类调用必须通过 constructor 参数类型解析；动态字段 / 工厂注入解析失败时跳过该调用（避免误报）
 *   - 不分析 super 调用、不分析 mixin
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  type ClassDeclaration,
  type ConstructorDeclaration,
  type MethodDeclaration,
  Node,
  type ParameterDeclaration,
  Project,
  type SourceFile,
} from "ts-morph";

const ROOT = path.resolve(__dirname, "..");

const SKIP_CLASS_DECORATORS = new Set([
  "Controller",
  "Resolver",
  "WebSocketGateway",
  "EventPattern",
]);

type IssueType = "LOCK_INSIDE_TX_DECORATOR" | "LOCK_INSIDE_TX_CALL";

interface LockedMethodRef {
  className: string;
  methodName: string;
  file: string;
  line: number;
}

interface Issue {
  type: IssueType;
  file: string;
  line: number;
  className: string;
  methodName: string;
  details: string;
  evidence?: string[];
  hint?: string;
  /** LOCK_INSIDE_TX_CALL 专用：被调用的 @WithLock 方法的位置 */
  lockedTarget?: LockedMethodRef;
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
const DEFAULT_REPORT_DIR = "docs/audits/lock-tx-fence";

const HINT_DECORATOR =
  "@Transactional 在源码上方（外层）= 事务先开。同方法上 @WithLock 必须严格在 @Transactional 之上。";

const HINT_CALL =
  "@Transactional 方法体内调用 @WithLock 方法 → 锁的临界区 ⊊ 事务的临界区 → 锁释放时事务未 COMMIT → 唯一性/幂等保护被静默绕过。\n" +
  "      修复：把 @WithLock 提升到外层（覆盖整个事务），或把被调用的方法拆成「无锁版本（事务内可调）+ 加锁版本（独立入口）」。";

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
              ["LOCK_INSIDE_TX_DECORATOR", "LOCK_INSIDE_TX_CALL"].includes(s),
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
Lock-Tx Inversion Fence v0

用法:
  pnpm check:lock-tx                                       全仓扫描，stdout + 增量写报告
  pnpm check:lock-tx -- --json                             stdout 改为 JSON 格式
  pnpm check:lock-tx -- --strict                           有问题时 exit 1（CI 用）
  pnpm check:lock-tx -- --paths libs/agent                 仅扫指定路径
  pnpm check:lock-tx -- --types LOCK_INSIDE_TX_CALL        仅看指定类别
  pnpm check:lock-tx -- --no-report                        强制跳过报告文件写入（仅 stdout）
  pnpm check:lock-tx -- --force-report                     强制写报告（无视增量判定，刷 baseline 用）
  pnpm check:lock-tx -- --out-dir <path>                   覆盖报告输出目录（默认 ${DEFAULT_REPORT_DIR}）

豁免:
  - 文件首部 500 字符内 \`lock-tx-check: ignore-file\`
  - 方法 leading 注释中 \`lock-tx-check: ignore\`
  - 方法 JSDoc 中 \`@allow-lock-inside-tx\`（语义化）
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

function methodHasIgnoreComment(method: MethodDeclaration): boolean {
  const ranges = method.getLeadingCommentRanges();
  for (const r of ranges) {
    const txt = r.getText();
    if (/lock-tx-check:\s*ignore\b/.test(txt)) return true;
    if (/@allow-lock-inside-tx\b/.test(txt)) return true;
  }
  return false;
}

function fileHasIgnoreComment(sourceFile: SourceFile): boolean {
  return /lock-tx-check:\s*ignore-file\b/.test(
    sourceFile.getFullText().slice(0, 500),
  );
}

/**
 * Pass 1: 收集所有带 @WithLock 的 service 方法
 * 返回 className -> Set<methodName> 映射
 */
function collectLockedMethods(
  sourceFiles: SourceFile[],
): Map<string, Map<string, LockedMethodRef>> {
  const map = new Map<string, Map<string, LockedMethodRef>>();
  for (const sf of sourceFiles) {
    if (shouldSkipFile(sf.getFilePath())) continue;
    for (const cls of sf.getClasses()) {
      if (classHasSkipDecorator(cls)) continue;
      const className = cls.getName();
      if (!className) continue;
      for (const m of cls.getMethods()) {
        const lockDec = getDecoratorByName(m, "WithLock");
        if (!lockDec) continue;
        const methodName = m.getName();
        if (!methodName) continue;
        let inner = map.get(className);
        if (!inner) {
          inner = new Map();
          map.set(className, inner);
        }
        inner.set(methodName, {
          className,
          methodName,
          file: sf.getFilePath(),
          line: lockDec.getStartLineNumber(),
        });
      }
    }
  }
  return map;
}

/**
 * 解析 class 的 constructor 参数：fieldName -> ClassName
 * 仅识别 NestJS 风格的字段注入：constructor(private readonly foo: FooService)
 */
function buildFieldTypeMap(cls: ClassDeclaration): Map<string, string> {
  const fieldMap = new Map<string, string>();
  const ctors: ConstructorDeclaration[] = cls.getConstructors();
  for (const ctor of ctors) {
    for (const param of ctor.getParameters()) {
      const fieldName = paramFieldName(param);
      if (!fieldName) continue;
      const typeNode = param.getTypeNode();
      if (!typeNode) continue;
      const typeText = typeNode.getText().replace(/\s+/g, "");
      const baseTypeName = extractBaseTypeName(typeText);
      if (baseTypeName) {
        fieldMap.set(fieldName, baseTypeName);
      }
    }
  }
  return fieldMap;
}

/**
 * NestJS 风格的字段注入：constructor(private readonly foo: FooService) → 直接成为 this.foo
 * 普通参数（无 modifier）不会自动成为字段，跳过
 */
function paramFieldName(param: ParameterDeclaration): string | null {
  const hasModifier = param.getModifiers().length > 0;
  if (!hasModifier) return null;
  return param.getName();
}

/**
 * 从类型文本中提取基础类名：去掉泛型参数、可选修饰、Injection 包装
 *   FooService            → FooService
 *   Repository<FooEntity> → Repository
 *   FooService | null     → FooService
 *   Inject(...) Foo       → Foo
 */
function extractBaseTypeName(typeText: string): string | null {
  const cleaned = typeText.split("|")[0].trim();
  const match = cleaned.match(/^([A-Z]\w*)/);
  return match ? match[1] : null;
}

/**
 * 在方法体内查找对 @WithLock 方法的调用
 * 返回 hits 数组，每条记录 { line, callText, target }
 */
interface CallHit {
  line: number;
  callText: string;
  target: LockedMethodRef;
}

function findLockedCalls(
  method: MethodDeclaration,
  currentClass: string,
  fieldTypeMap: Map<string, string>,
  lockedMethods: Map<string, Map<string, LockedMethodRef>>,
): CallHit[] {
  const hits: CallHit[] = [];
  const body = method.getBody();
  if (!body) return hits;

  body.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return;
    const expr = node.getExpression();
    if (!Node.isPropertyAccessExpression(expr)) return;

    const calledName = expr.getName();
    const target = expr.getExpression();

    if (Node.isThisExpression(target)) {
      const ref = lockedMethods.get(currentClass)?.get(calledName);
      if (ref) {
        hits.push({
          line: node.getStartLineNumber(),
          callText: `this.${calledName}(...)`,
          target: ref,
        });
      }
      return;
    }

    if (Node.isPropertyAccessExpression(target)) {
      const fieldHolder = target.getExpression();
      const fieldName = target.getName();
      if (!Node.isThisExpression(fieldHolder)) return;
      const className = fieldTypeMap.get(fieldName);
      if (!className) return;
      const ref = lockedMethods.get(className)?.get(calledName);
      if (ref) {
        hits.push({
          line: node.getStartLineNumber(),
          callText: `this.${fieldName}.${calledName}(...)`,
          target: ref,
        });
      }
    }
  });

  return hits;
}

function analyzeMethod(
  method: MethodDeclaration,
  className: string,
  sourceFile: SourceFile,
  fieldTypeMap: Map<string, string>,
  lockedMethods: Map<string, Map<string, LockedMethodRef>>,
  out: Issue[],
) {
  if (methodHasIgnoreComment(method)) return;

  const txDecorator = getDecoratorByName(method, "Transactional");
  if (!txDecorator) return;

  const methodName = method.getName();
  if (!methodName) return;

  const lockDecorator = getDecoratorByName(method, "WithLock");
  if (lockDecorator) {
    const decorators = method.getDecorators();
    const txIdx = decorators.indexOf(txDecorator);
    const lockIdx = decorators.indexOf(lockDecorator);
    if (txIdx < lockIdx) {
      out.push({
        type: "LOCK_INSIDE_TX_DECORATOR",
        file: sourceFile.getFilePath(),
        line: txDecorator.getStartLineNumber(),
        className,
        methodName,
        details: `@Transactional 装饰器位于 @WithLock 之上（外层）→ 事务先开、锁后获取，构成倒置`,
        evidence: [
          `${txDecorator.getStartLineNumber()}: @Transactional()`,
          `${lockDecorator.getStartLineNumber()}: @WithLock(...)`,
        ],
        hint: HINT_DECORATOR,
      });
    }
  }

  const callHits = findLockedCalls(
    method,
    className,
    fieldTypeMap,
    lockedMethods,
  );
  for (const hit of callHits) {
    out.push({
      type: "LOCK_INSIDE_TX_CALL",
      file: sourceFile.getFilePath(),
      line: hit.line,
      className,
      methodName,
      details: `@Transactional 方法内调用了 @WithLock 方法 \`${hit.target.className}.${hit.target.methodName}\``,
      evidence: [
        `${hit.line}: ${hit.callText}`,
        `→ @WithLock 定义: ${path.relative(ROOT, hit.target.file)}:${hit.target.line} ${hit.target.className}.${hit.target.methodName}`,
      ],
      hint: HINT_CALL,
      lockedTarget: hit.target,
    });
  }
}

function analyzeFile(
  sourceFile: SourceFile,
  lockedMethods: Map<string, Map<string, LockedMethodRef>>,
  out: Issue[],
) {
  if (shouldSkipFile(sourceFile.getFilePath())) return;
  if (fileHasIgnoreComment(sourceFile)) return;

  for (const cls of sourceFile.getClasses()) {
    if (classHasSkipDecorator(cls)) continue;
    const className = cls.getName() ?? "<anonymous>";
    const fieldTypeMap = buildFieldTypeMap(cls);
    for (const m of cls.getMethods()) {
      analyzeMethod(m, className, sourceFile, fieldTypeMap, lockedMethods, out);
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
      console.warn(`[lock-tx-check] target 不存在: ${target}`);
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
    LOCK_INSIDE_TX_DECORATOR: [],
    LOCK_INSIDE_TX_CALL: [],
  };
  for (const i of issues) grouped[i.type].push(i);

  const total = issues.length;
  console.log(`\n[lock-tx-check v0] 共发现 ${total} 个问题`);
  console.log(
    `  LOCK_INSIDE_TX_DECORATOR: ${grouped.LOCK_INSIDE_TX_DECORATOR.length}  同方法装饰器顺序倒置（@Transactional 在外、@WithLock 在内）`,
  );
  console.log(
    `  LOCK_INSIDE_TX_CALL:      ${grouped.LOCK_INSIDE_TX_CALL.length}  @Transactional 方法体内调用了 @WithLock 方法\n`,
  );

  const order: IssueType[] = [
    "LOCK_INSIDE_TX_DECORATOR",
    "LOCK_INSIDE_TX_CALL",
  ];
  for (const type of order) {
    if (filterTypes && !filterTypes.has(type)) continue;
    const list = grouped[type];
    if (list.length === 0) continue;
    console.log(`──────── ${type} (${list.length}) ────────`);
    for (const i of list) {
      const rel = path.relative(ROOT, i.file);
      console.log(`\n  ${rel}:${i.line}`);
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
  lockedMethodCount: number;
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
    LOCK_INSIDE_TX_DECORATOR: [],
    LOCK_INSIDE_TX_CALL: [],
  };
  for (const i of issues) grouped[i.type].push(i);

  const lines: string[] = [];
  lines.push(
    `# lock-tx fence report ${formatReportTimestamp(meta.generatedAt)}`,
  );
  lines.push("");
  lines.push(`- **生成时间**: ${formatHumanTimestamp(meta.generatedAt)}`);
  lines.push(`- **扫描路径**: ${meta.paths.join(", ")}`);
  lines.push(`- **扫描文件数**: ${meta.fileCount}`);
  lines.push(`- **执行模式**: ${meta.strict ? "strict (CI)" : "report-only"}`);
  lines.push(`- **@WithLock 方法总数**: ${meta.lockedMethodCount}`);
  if (meta.filterTypes) {
    lines.push(`- **类别过滤**: ${[...meta.filterTypes].join(", ")}`);
  }
  lines.push(`- **总 finding 数**: ${issues.length}`);
  lines.push("");

  lines.push("## 漏洞机理");
  lines.push("");
  lines.push(
    "「事务-锁倒置」让锁的临界区 ⊊ 事务的临界区——锁释放时事务尚未 COMMIT，唯一性 / 幂等保护被静默绕过：",
  );
  lines.push("");
  lines.push("1. 进入 `@Transactional` → 数据库 BEGIN，开启事务快照");
  lines.push("2. 进入内层 `@WithLock` → Redis 拿到锁");
  lines.push(
    "3. 内层方法查询 → 只能看到自己事务的快照，看不到其他并发事务尚未 COMMIT 的写入",
  );
  lines.push("4. 内层方法 save → 仍在事务内，未真正落库");
  lines.push("5. 内层方法返回 → **Redis 锁立刻释放**");
  lines.push("6. 外层 `@Transactional` 还没 COMMIT");
  lines.push("7. 此时另一个并发请求拿到同把锁，做相同的「查询 → 校验 → 写入」");
  lines.push(
    "8. 它的查询同样看不到第一个事务的未提交数据 → 校验通过 → 也插入一条",
  );
  lines.push("9. 两个事务先后 COMMIT → **唯一性约束失效 / 幂等保护失效**");
  lines.push("");

  lines.push("## 摘要");
  lines.push("");
  lines.push("| 类别 | 数量 | 含义 |");
  lines.push("| --- | ---: | --- |");
  lines.push(
    `| LOCK_INSIDE_TX_DECORATOR | ${grouped.LOCK_INSIDE_TX_DECORATOR.length} | 同方法装饰器顺序倒置（@Transactional 在外、@WithLock 在内） |`,
  );
  lines.push(
    `| LOCK_INSIDE_TX_CALL | ${grouped.LOCK_INSIDE_TX_CALL.length} | @Transactional 方法体内调用了 @WithLock 方法 |`,
  );
  lines.push(`| **总计** | **${issues.length}** | |`);
  lines.push("");

  if (issues.length === 0) {
    lines.push("## 详情");
    lines.push("");
    lines.push("> 事务-锁倒置围栏全绿，无 finding。");
    lines.push("");
    return lines.join("\n");
  }

  lines.push("## 详情");
  lines.push("");
  const order: IssueType[] = [
    "LOCK_INSIDE_TX_DECORATOR",
    "LOCK_INSIDE_TX_CALL",
  ];
  for (const type of order) {
    if (meta.filterTypes && !meta.filterTypes.has(type)) continue;
    const list = grouped[type];
    if (list.length === 0) continue;
    lines.push(`### ${type} (${list.length})`);
    lines.push("");
    for (const i of list) {
      const rel = path.relative(ROOT, i.file);
      lines.push(
        `- **\`${rel}:${i.line}\`** — \`${i.className}.${i.methodName}\``,
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
 * 故意忽略 line（行号位移不算"新增"）。
 * LOCK_INSIDE_TX_CALL 把"被调用方"也纳入指纹，因为同一个 tx 方法可能调多个不同 lock 方法。
 */
function issueFingerprint(i: Issue): string {
  const rel = path.relative(ROOT, i.file);
  const target = i.lockedTarget
    ? `|${i.lockedTarget.className}.${i.lockedTarget.methodName}`
    : "";
  return `${i.type}|${rel}|${i.className}.${i.methodName}${target}`;
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
        filterTypes: meta.filterTypes ? [...meta.filterTypes] : null,
        strict: meta.strict,
        lockedMethodCount: meta.lockedMethodCount,
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

function countLockedMethods(
  map: Map<string, Map<string, LockedMethodRef>>,
): number {
  let n = 0;
  for (const inner of map.values()) n += inner.size;
  return n;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const project = loadProject(opts.paths);
  const sourceFiles = project.getSourceFiles();

  const lockedMethods = collectLockedMethods(sourceFiles);
  const lockedMethodCount = countLockedMethods(lockedMethods);

  const issues: Issue[] = [];
  for (const sf of sourceFiles) analyzeFile(sf, lockedMethods, issues);

  const filtered = opts.types
    ? issues.filter((i) => opts.types?.has(i.type))
    : issues;

  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify({ total: filtered.length, issues: filtered }, null, 2)}\n`,
    );
  } else {
    console.log(
      `[lock-tx-check v0] 扫描 ${sourceFiles.length} 个 .ts 文件 (targets: ${opts.paths.join(", ")})；@WithLock 方法 ${lockedMethodCount} 个`,
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
        console.log(
          `[lock-tx-check v0] 增量判定: 无新增 finding，跳过写入报告`,
        );
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
        lockedMethodCount,
      };
      const { mdPath, jsonPath } = writeReportFiles(
        filtered,
        meta,
        opts.outDir,
      );
      if (!opts.json) {
        if (diff && diff.baselinePath) {
          console.log(
            `[lock-tx-check v0] 增量判定: 检测到新增 finding，写入新报告`,
          );
          console.log(`  baseline: ${path.relative(ROOT, diff.baselinePath)}`);
          console.log(
            `  added=${diff.added.length}  removed=${diff.removed.length}  unchanged=${diff.unchanged}`,
          );
        } else if (incrementalEnabled) {
          console.log(
            `[lock-tx-check v0] 增量判定: 未找到 baseline，写入首份报告`,
          );
        } else if (isPartialScan) {
          console.log(
            `[lock-tx-check v0] 局部扫描（启用了 --paths/--types），跳过增量判定，直接写报告`,
          );
        }
        console.log(`[lock-tx-check v0] 报告已写入:`);
        console.log(`  ${path.relative(ROOT, mdPath)}`);
        console.log(`  ${path.relative(ROOT, jsonPath)}`);
      }
    }
  }

  if (opts.strict && filtered.length > 0) process.exit(1);
}

main();
