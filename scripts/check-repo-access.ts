#!/usr/bin/env tsx
/**
 * Repo Access Fence v0 — 静态围栏检查 Repository 注入是否合规
 *
 * 检查 3 类问题：
 *   A. DUP_OWNER         — 同一 Entity 在 2+ 个 Service 中出现 @InjectRepository（违反"唯一归属"）
 *   B. NON_SERVICE_INJECT — Controller / Processor / Gateway / Resolver / Tool 中出现 @InjectRepository
 *   C. CROSS_LIB_INJECT   — Service 跨 libs/<domain> 边界注入其他模块的 Entity Repository
 *
 * 用法：
 *   pnpm check:repo                          全仓扫描，stdout + 增量写报告
 *   pnpm check:repo -- --json                stdout 改为 JSON 格式
 *   pnpm check:repo -- --strict              发现问题时 exit 1（CI 用）
 *   pnpm check:repo -- --paths libs/agent    仅扫描指定路径（逗号分隔，启用过滤即不写报告）
 *   pnpm check:repo -- --types DUP_OWNER     仅展示指定类别（逗号分隔，启用过滤即不写报告）
 *   pnpm check:repo -- --map                 仅打印当前 Entity → Service 归属映射，不做合规检查
 *   pnpm check:repo -- --no-report           强制跳过报告文件写入
 *   pnpm check:repo -- --force-report        强制写报告（无视增量判定，刷 baseline 用）
 *   pnpm check:repo -- --out-dir <path>      覆盖报告目录（默认 docs/audits/repo-fence）
 *
 * 报告写入策略（增量）：
 *   - 默认仅当当前 finding 集合相对最新 baseline JSON 出现【新增】时才写新报告。
 *   - 若仅是减少（修复）或完全持平 → 跳过写入，stdout 提示。
 *   - 启用 --paths / --types 过滤、或加 --force-report → 关闭增量，直接写。
 *   - --map 仅可视化归属，不写报告。
 *
 * 报告输出位置：
 *   docs/audits/repo-fence/<YYYY-MM-DD-HHmm>.md   人读
 *   docs/audits/repo-fence/<YYYY-MM-DD-HHmm>.json 机读（baseline 比对源）
 *
 * 局部豁免：
 *   - 文件首部 500 字符内出现 `repo-check: ignore-file` → 跳过整个文件
 *
 * 设计取舍：
 *   - 不维护硬编码归属表；归属由代码现状（@InjectRepository 出现位置）反推
 *   - 仅扫描 libs/**；apps/** 通常不持有 Entity，可按需加 --paths apps
 *   - 不做"应该有归属 Service 但没有"的检查（unused entity 不是错误）
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  type ClassDeclaration,
  type Decorator,
  Project,
  type SourceFile,
} from "ts-morph";
import { collectTsFiles } from "./lib/ts-files";

const ROOT = path.resolve(__dirname, "..");

const SKIP_CLASS_DECORATORS = new Set([
  "Controller",
  "Resolver",
  "Processor",
  "WebSocketGateway",
]);

const NON_SERVICE_FILE_PATTERNS = [
  /\.controller\.ts$/,
  /\.processor\.ts$/,
  /\.gateway\.ts$/,
  /\.resolver\.ts$/,
  /\.tool\.ts$/,
];

/**
 * 基础设施豁免：事务 / Proxy / Store 等底层适配器不受业务规则约束。
 * 这些文件被允许注入任意 Repository，不会触发 NON_SERVICE_INJECT / CROSS_LIB_INJECT / DUP_OWNER。
 */
const INFRA_WHITELIST = new Set<string>([
  "libs/common/src/decorators/transactional.decorator.ts",
  "libs/common/src/typeorm/tx-typeorm.module.ts",
]);

type IssueType = "DUP_OWNER" | "NON_SERVICE_INJECT" | "CROSS_LIB_INJECT";

interface Issue {
  type: IssueType;
  entity: string;
  file: string;
  line: number;
  className: string;
  details: string;
  hint?: string;
}

interface InjectionSite {
  entity: string;
  file: string;
  line: number;
  className: string;
  classKind: "service" | "non-service" | "infra";
  lib: string | null;
}

interface EntityDef {
  name: string;
  file: string;
  lib: string | null;
}

interface CliOptions {
  json: boolean;
  strict: boolean;
  paths: string[];
  types: Set<IssueType> | null;
  mapOnly: boolean;
  /** false = --no-report 强制不写；true = 默认状态，是否写由增量判定决定 */
  writeReport: boolean;
  /** true = --force-report 无视增量判定一定写 */
  forceReport: boolean;
  /** 标记 paths 是否被用户显式指定（用于关闭增量） */
  pathsExplicit: boolean;
  outDir: string;
}

// meshbot 的 Entity 当前放在 apps/server-agent/src/entities/，所以默认要扫 apps。
const DEFAULT_PATHS = ["libs", "apps"];
const DEFAULT_REPORT_DIR = "docs/audits/repo-fence";

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    json: false,
    strict: false,
    paths: DEFAULT_PATHS,
    types: null,
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
    } else if (a === "--types") {
      const v = argv[++i];
      if (v) {
        opts.types = new Set(
          v
            .split(",")
            .map((s) => s.trim().toUpperCase() as IssueType)
            .filter((s): s is IssueType =>
              ["DUP_OWNER", "NON_SERVICE_INJECT", "CROSS_LIB_INJECT"].includes(
                s,
              ),
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
Repo Access Fence v0

用法:
  pnpm check:repo                          全仓扫描（默认 libs/**），stdout + 增量写报告
  pnpm check:repo -- --json                stdout 改为 JSON 格式
  pnpm check:repo -- --strict              有问题时 exit 1（CI 用）
  pnpm check:repo -- --paths libs/agent    仅扫指定路径（逗号分隔，启用过滤即不写报告）
  pnpm check:repo -- --types DUP_OWNER     仅展示指定类别（逗号分隔，启用过滤即不写报告）
  pnpm check:repo -- --map                 仅打印 Entity → Service 归属映射，不写报告
  pnpm check:repo -- --no-report           强制跳过报告文件写入（仅 stdout）
  pnpm check:repo -- --force-report        强制写报告（无视增量判定，刷 baseline 用）
  pnpm check:repo -- --out-dir <path>      覆盖报告输出目录（默认 ${DEFAULT_REPORT_DIR}）

检查规则:
  DUP_OWNER          同一 Entity 在多个 Service 中被 @InjectRepository
  NON_SERVICE_INJECT Controller/Processor/Gateway/Resolver/Tool 中出现 @InjectRepository
  CROSS_LIB_INJECT   Service 跨 libs/<domain> 注入其他模块的 Entity Repository

报告写入策略（增量）:
  - 默认仅当当前 finding 集合相对最新 baseline JSON 出现【新增】时才写新报告。
  - 启用 --paths / --types 过滤、或加 --force-report → 关闭增量，直接写。
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
  )
    return true;
  // meshbot 非 NestJS 服务层代码：前端、CLI、Agent 域（vitest）、桌面端
  if (rel.startsWith("apps/web-") || rel.includes("/apps/web-")) return true;
  if (rel.startsWith("apps/cli-agent") || rel.includes("/apps/cli-agent/"))
    return true;
  if (rel.startsWith("apps/desktop") || rel.includes("/apps/desktop/"))
    return true;
  if (rel.startsWith("libs/agent/") || rel.includes("/libs/agent/"))
    return true;
  if (rel.startsWith("packages/") || rel.includes("/packages/")) return true;
  if (rel.endsWith(".d.ts")) return true;
  return false;
}

function hasIgnoreFileMarker(source: string): boolean {
  const head = source.slice(0, 500);
  return /repo-check:\s*ignore-file/.test(head);
}

function getRelPath(absPath: string): string {
  return path.relative(ROOT, absPath);
}

function isInfraWhitelisted(absPath: string): boolean {
  return INFRA_WHITELIST.has(getRelPath(absPath));
}

/**
 * 推断文件所属的 lib，例如 libs/agent/src/... → "agent"，apps/server-agent/src/... → null。
 * Entity 与 Service 的归属比较用此判定。
 */
function detectLibName(absPath: string): string | null {
  const rel = getRelPath(absPath);
  const m = rel.match(/^libs\/([^/]+)\//);
  return m ? m[1] : null;
}

function classifyClassKind(
  cls: ClassDeclaration,
  sourceFile: SourceFile,
): "service" | "non-service" | "infra" {
  const filePath = sourceFile.getFilePath();
  if (isInfraWhitelisted(filePath)) return "infra";

  for (const dec of cls.getDecorators()) {
    if (SKIP_CLASS_DECORATORS.has(dec.getName())) return "non-service";
  }
  for (const re of NON_SERVICE_FILE_PATTERNS) {
    if (re.test(filePath)) return "non-service";
  }
  return "service";
}

/**
 * 提取 @InjectRepository(EntityName) 装饰器中的 Entity 名称。
 * 处理 @InjectRepository(FooEntity)、@InjectRepository(FooEntity, "conn") 等形式。
 */
function extractInjectedEntityName(dec: Decorator): string | null {
  if (dec.getName() !== "InjectRepository") return null;
  const args = dec.getArguments();
  if (args.length === 0) return null;
  const first = args[0];
  const text = first.getText().trim();
  return text.length === 0 ? null : text;
}

function collectInjectionSites(sourceFile: SourceFile, sites: InjectionSite[]) {
  const filePath = sourceFile.getFilePath();
  const lib = detectLibName(filePath);

  for (const cls of sourceFile.getClasses()) {
    const className = cls.getName() ?? "<anonymous>";
    const classKind = classifyClassKind(cls, sourceFile);

    for (const ctor of cls.getConstructors()) {
      for (const param of ctor.getParameters()) {
        for (const dec of param.getDecorators()) {
          const entity = extractInjectedEntityName(dec);
          if (!entity) continue;
          sites.push({
            entity,
            file: filePath,
            line: dec.getStartLineNumber(),
            className,
            classKind,
            lib,
          });
        }
      }
    }
  }
}

function collectEntityDefs(sourceFile: SourceFile, defs: EntityDef[]) {
  const filePath = sourceFile.getFilePath();
  if (!/\.entity\.ts$/.test(filePath)) return;
  const lib = detectLibName(filePath);

  for (const cls of sourceFile.getClasses()) {
    const hasEntityDecorator = cls
      .getDecorators()
      .some((d) => d.getName() === "Entity");
    if (!hasEntityDecorator) continue;
    const name = cls.getName();
    if (!name) continue;
    defs.push({ name, file: filePath, lib });
  }
}

function buildOwnershipMap(
  sites: InjectionSite[],
): Map<string, InjectionSite[]> {
  const map = new Map<string, InjectionSite[]>();
  for (const s of sites) {
    if (s.classKind !== "service") continue; // ownership 仅由 Service 注入定义
    const arr = map.get(s.entity) ?? [];
    arr.push(s);
    map.set(s.entity, arr);
  }
  return map;
}

function detectIssues(
  sites: InjectionSite[],
  ownershipMap: Map<string, InjectionSite[]>,
  entityDefs: Map<string, EntityDef>,
): Issue[] {
  const issues: Issue[] = [];

  for (const s of sites) {
    if (s.classKind === "infra") continue;

    if (s.classKind === "non-service") {
      issues.push({
        type: "NON_SERVICE_INJECT",
        entity: s.entity,
        file: s.file,
        line: s.line,
        className: s.className,
        details: `${s.className} 不是 Service，但注入了 ${s.entity} 的 Repository`,
        hint: `应改为注入对应的 Service（如 ${s.entity.replace(/Entity$/, "")}Service），由 Service 暴露公开方法`,
      });
      continue;
    }

    const def = entityDefs.get(s.entity);
    if (def && def.lib && s.lib && def.lib !== s.lib) {
      issues.push({
        type: "CROSS_LIB_INJECT",
        entity: s.entity,
        file: s.file,
        line: s.line,
        className: s.className,
        details: `${s.className}（lib: ${s.lib}）注入了 ${s.entity}（lib: ${def.lib}）的 Repository`,
        hint: `跨 lib 数据访问应通过 ${def.lib} 模块的归属 Service 进行，不要直接注入其 Repository`,
      });
    }
  }

  for (const [entity, owners] of ownershipMap) {
    if (owners.length <= 1) continue;
    for (const o of owners) {
      issues.push({
        type: "DUP_OWNER",
        entity,
        file: o.file,
        line: o.line,
        className: o.className,
        details: `${entity} 在 ${owners.length} 个 Service 中被 @InjectRepository: ${owners
          .map((x) => x.className)
          .join(", ")}`,
        hint: `每个 Entity 应仅有一个归属 Service。请将 ${entity} 的 Repository 注入收敛到唯一的 Service`,
      });
    }
  }

  return issues;
}

function printOwnershipMap(
  ownershipMap: Map<string, InjectionSite[]>,
  entityDefs: Map<string, EntityDef>,
) {
  const sorted = Array.from(ownershipMap.entries()).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  console.log(
    `\n[repo-check v0] Entity → Service 归属映射 (共 ${sorted.length} 个 Entity)`,
  );
  console.log("─".repeat(80));
  console.log("Entity".padEnd(40), "归属 Service".padEnd(30), "lib");
  console.log("─".repeat(80));
  for (const [entity, owners] of sorted) {
    const def = entityDefs.get(entity);
    const libDisplay = def?.lib ?? "<unknown>";
    if (owners.length === 1) {
      console.log(
        entity.padEnd(40),
        owners[0].className.padEnd(30),
        libDisplay,
      );
    } else {
      console.log(
        entity.padEnd(40),
        `⚠ ${owners.length} 个归属:`.padEnd(30),
        libDisplay,
      );
      for (const o of owners) {
        console.log(
          "  ".padEnd(40),
          `  - ${o.className} (${getRelPath(o.file)}:${o.line})`,
        );
      }
    }
  }
  console.log("");
}

function printTextReport(issues: Issue[], filterTypes: Set<IssueType> | null) {
  const grouped: Record<IssueType, Issue[]> = {
    DUP_OWNER: [],
    NON_SERVICE_INJECT: [],
    CROSS_LIB_INJECT: [],
  };
  for (const i of issues) grouped[i.type].push(i);

  console.log(`\n[repo-check v0] 共发现 ${issues.length} 个问题`);
  console.log(
    `  DUP_OWNER:          ${grouped.DUP_OWNER.length}  同 Entity 在多 Service 中注入`,
  );
  console.log(
    `  NON_SERVICE_INJECT: ${grouped.NON_SERVICE_INJECT.length}  Controller/Processor/Gateway 等注入了 Repo`,
  );
  console.log(
    `  CROSS_LIB_INJECT:   ${grouped.CROSS_LIB_INJECT.length}  Service 跨 lib 注入其他域 Entity\n`,
  );

  const order: IssueType[] = [
    "NON_SERVICE_INJECT",
    "CROSS_LIB_INJECT",
    "DUP_OWNER",
  ];
  for (const type of order) {
    if (filterTypes && !filterTypes.has(type)) continue;
    const list = grouped[type];
    if (list.length === 0) continue;
    console.log(`──────── ${type} (${list.length}) ────────`);
    for (const i of list) {
      const rel = getRelPath(i.file);
      console.log(`\n  ${rel}:${i.line}`);
      console.log(`    ${i.className}: ${i.details}`);
      if (i.hint) console.log(`    → ${i.hint}`);
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
    DUP_OWNER: [],
    NON_SERVICE_INJECT: [],
    CROSS_LIB_INJECT: [],
  };
  for (const i of issues) grouped[i.type].push(i);

  const lines: string[] = [];
  lines.push(`# repo-fence report ${formatReportTimestamp(meta.generatedAt)}`);
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
    `| NON_SERVICE_INJECT | ${grouped.NON_SERVICE_INJECT.length} | Controller/Processor/Gateway/Resolver/Tool 注入 Repo |`,
  );
  lines.push(
    `| CROSS_LIB_INJECT | ${grouped.CROSS_LIB_INJECT.length} | Service 跨 lib 注入其他域 Entity |`,
  );
  lines.push(
    `| DUP_OWNER | ${grouped.DUP_OWNER.length} | 同 Entity 在多 Service 中被 @InjectRepository |`,
  );
  lines.push(`| **总计** | **${issues.length}** | |`);
  lines.push("");

  if (issues.length === 0) {
    lines.push("## 详情");
    lines.push("");
    lines.push("> Repo 访问围栏全绿，无 finding。");
    lines.push("");
    return lines.join("\n");
  }

  lines.push("## 详情");
  lines.push("");
  const order: IssueType[] = [
    "NON_SERVICE_INJECT",
    "CROSS_LIB_INJECT",
    "DUP_OWNER",
  ];
  for (const type of order) {
    if (meta.filterTypes && !meta.filterTypes.has(type)) continue;
    const list = grouped[type];
    if (list.length === 0) continue;
    lines.push(`### ${type} (${list.length})`);
    lines.push("");
    for (const i of list) {
      const rel = getRelPath(i.file);
      lines.push(
        `- **\`${rel}:${i.line}\`** — \`${i.className}\` / \`${i.entity}\``,
      );
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
 * 故意忽略 line 与 details 内的可变信息（行号位移、归属计数变化均不算"新增"）。
 */
function issueFingerprint(i: Issue): string {
  const rel = path.relative(ROOT, i.file);
  return `${i.type}|${i.entity}|${rel}|${i.className}`;
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

function loadProject(targets: string[]): Project {
  const project = new Project({
    tsConfigFilePath: path.join(ROOT, "tsconfig.base.json"),
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { allowJs: false, noEmit: true },
  });
  for (const target of targets) {
    const abs = path.resolve(ROOT, target);
    if (!fs.existsSync(abs)) {
      console.warn(`[repo-check] target 不存在: ${target}`);
      continue;
    }
    for (const f of collectTsFiles(abs)) project.addSourceFileAtPath(f);
  }
  return project;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const project = loadProject(opts.paths);
  const sourceFiles = project.getSourceFiles();

  const sites: InjectionSite[] = [];
  const entityDefs: EntityDef[] = [];

  for (const sf of sourceFiles) {
    const filePath = sf.getFilePath();
    if (shouldSkipFile(filePath)) continue;
    if (hasIgnoreFileMarker(sf.getFullText())) continue;
    collectInjectionSites(sf, sites);
    collectEntityDefs(sf, entityDefs);
  }

  const entityDefMap = new Map<string, EntityDef>();
  for (const d of entityDefs) entityDefMap.set(d.name, d);

  const ownershipMap = buildOwnershipMap(sites);

  if (opts.mapOnly) {
    if (opts.json) {
      const out = Array.from(ownershipMap.entries()).map(
        ([entity, owners]) => ({
          entity,
          lib: entityDefMap.get(entity)?.lib ?? null,
          owners: owners.map((o) => ({
            className: o.className,
            file: getRelPath(o.file),
            line: o.line,
          })),
        }),
      );
      process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    } else {
      printOwnershipMap(ownershipMap, entityDefMap);
    }
    return;
  }

  const issues = detectIssues(sites, ownershipMap, entityDefMap);
  const filtered = opts.types
    ? issues.filter((i) => opts.types?.has(i.type))
    : issues;

  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify({ total: filtered.length, issues: filtered }, null, 2)}\n`,
    );
  } else {
    console.log(
      `[repo-check v0] 扫描 ${sourceFiles.length} 个 .ts 文件 (targets: ${opts.paths.join(", ")})`,
    );
    printTextReport(filtered, opts.types);
    if (filtered.length === 0) {
      printOwnershipMap(ownershipMap, entityDefMap);
    }
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
        console.log(`[repo-check v0] 增量判定: 无新增 finding，跳过写入报告`);
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
          console.log(
            `[repo-check v0] 增量判定: 检测到新增 finding，写入新报告`,
          );
          console.log(`  baseline: ${path.relative(ROOT, diff.baselinePath)}`);
          console.log(
            `  added=${diff.added.length}  removed=${diff.removed.length}  unchanged=${diff.unchanged}`,
          );
        } else if (incrementalEnabled) {
          console.log(
            `[repo-check v0] 增量判定: 未找到 baseline，写入首份报告`,
          );
        } else if (isPartialScan) {
          console.log(
            `[repo-check v0] 局部扫描（启用了 --paths/--types），跳过增量判定，直接写报告`,
          );
        } else if (opts.forceReport) {
          console.log(
            `[repo-check v0] --force-report 已开启，无视增量判定直接写报告`,
          );
        }
        console.log(`[repo-check v0] 报告已写入:`);
        console.log(`  ${path.relative(ROOT, mdPath)}`);
        console.log(`  ${path.relative(ROOT, jsonPath)}`);
      }
    }
  }

  if (opts.strict && filtered.length > 0) process.exit(1);
}

main();
