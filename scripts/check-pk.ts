#!/usr/bin/env tsx
/**
 * check-pk: 确保所有 @Entity 类都继承自 SnowflakeBaseEntity。
 *
 * 检查 2 类问题：
 *   A. MISSING_BASE     — @Entity 类未继承 SnowflakeBaseEntity
 *   B. LEGACY_PRIMARY   — 残留 @PrimaryGeneratedColumn 或裸 @PrimaryColumn（非基类文件）
 *
 * 用法：
 *   pnpm check:pk                  扫描全仓
 *   pnpm check:pk -- --strict      发现违规时 exit 1（CI 用）
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { Project } from "ts-morph";
import { collectTsFiles } from "./lib/ts-files";

const ROOT = path.resolve(__dirname, "..");

export interface PkViolation {
  file: string;
  className: string;
  reason: string;
}

/** 核心检查逻辑；接受 { filePath: fileContent } map，便于单测注入虚拟内容。 */
export function runPkCheck(files: Record<string, string>): PkViolation[] {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [fp, src] of Object.entries(files)) {
    project.createSourceFile(fp, src, { overwrite: true });
  }

  const violations: PkViolation[] = [];

  for (const sf of project.getSourceFiles()) {
    const fp = sf.getFilePath();
    if (fp.endsWith("snowflake-base.entity.ts")) continue;
    if (!fp.endsWith(".entity.ts")) continue;

    for (const cls of sf.getClasses()) {
      const decorators = cls.getDecorators().map((d) => d.getName());
      if (!decorators.includes("Entity")) continue;

      const className = cls.getName() ?? "<anonymous>";

      // A. 未继承 SnowflakeBaseEntity
      const extendsSnowflake = cls
        .getExtends()
        ?.getExpression()
        .getText()
        .includes("SnowflakeBaseEntity");
      if (!extendsSnowflake) {
        violations.push({
          file: fp,
          className,
          reason: "缺少 extends SnowflakeBaseEntity",
        });
      }

      // B. 残留 @PrimaryGeneratedColumn 或裸 @PrimaryColumn
      for (const prop of cls.getProperties()) {
        const propDecorators = prop.getDecorators().map((d) => d.getName());
        if (propDecorators.includes("PrimaryGeneratedColumn")) {
          violations.push({
            file: fp,
            className,
            reason: `属性 ${prop.getName()} 残留 @PrimaryGeneratedColumn（应继承 SnowflakeBaseEntity）`,
          });
        }
        if (propDecorators.includes("PrimaryColumn")) {
          violations.push({
            file: fp,
            className,
            reason: `属性 ${prop.getName()} 残留裸 @PrimaryColumn（应继承 SnowflakeBaseEntity）`,
          });
        }
      }
    }
  }

  return violations;
}

// ---- CLI 入口
function main() {
  const isStrict = process.argv.includes("--strict");

  const entityFiles = collectTsFiles(ROOT, { pruneDirs: ["__tests__"] }).filter(
    (f) => f.endsWith(".entity.ts"),
  );

  const fileMap: Record<string, string> = {};
  for (const f of entityFiles) {
    fileMap[f] = fs.readFileSync(f, "utf-8");
  }

  const violations = runPkCheck(fileMap);

  if (violations.length === 0) {
    console.log("[check:pk] OK — 全部 entity 均继承 SnowflakeBaseEntity");
    process.exit(0);
  }

  for (const v of violations) {
    const rel = path.relative(ROOT, v.file);
    console.error(`[check:pk] FAIL: ${rel} — ${v.className}: ${v.reason}`);
  }

  if (isStrict) process.exit(1);
}

// 仅作为 CLI 直接运行时执行 main()；被 spec import 时不触发（避免误扫真仓库）。
if (require.main === module) {
  main();
}
