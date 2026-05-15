/**
 * 把 `apps/<app>/migrations/` 下已执行的迁移文件归档到 `migrations/archive/`。
 *
 * 用法：
 *   pnpm migration:archive:main
 *   pnpm migration:archive:agent
 *   tsx scripts/archive-migrations.ts apps/server-main
 *
 * 行为：
 *   - 扫描 `<app>/migrations/*.{ts,sql,js}`（顶层文件，不递归）
 *   - 跳过 archive/ 子目录
 *   - 移到 `<app>/migrations/archive/`
 *   - 输出归档清单（dry-run 模式：`--dry-run` 仅打印，不移动）
 *
 * Phase 3 起线上发布前归档已上线的迁移文件，保持目录干净。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const VALID_EXT = new Set([".ts", ".sql", ".js"]);

interface Options {
  appPath: string;
  dryRun: boolean;
}

function parseArgs(): Options {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const appArg = args.find((a) => !a.startsWith("--"));
  if (!appArg) {
    console.error(
      "[archive-migrations] 用法：tsx scripts/archive-migrations.ts <appPath> [--dry-run]",
    );
    process.exit(2);
  }
  return { appPath: path.resolve(process.cwd(), appArg), dryRun };
}

async function main(): Promise<void> {
  const { appPath, dryRun } = parseArgs();
  const migrationsDir = path.join(appPath, "migrations");
  const archiveDir = path.join(migrationsDir, "archive");

  try {
    await fs.access(migrationsDir);
  } catch {
    console.error(
      `[archive-migrations] 未找到 migrations 目录：${migrationsDir}`,
    );
    process.exit(1);
  }

  await fs.mkdir(archiveDir, { recursive: true });

  const entries = await fs.readdir(migrationsDir, { withFileTypes: true });
  const candidates = entries.filter(
    (e) => e.isFile() && VALID_EXT.has(path.extname(e.name)),
  );

  if (candidates.length === 0) {
    console.log(`[archive-migrations] 无可归档迁移：${migrationsDir}`);
    return;
  }

  console.log(
    `[archive-migrations] 准备归档 ${candidates.length} 个文件 → ${path.relative(process.cwd(), archiveDir)}/`,
  );
  for (const entry of candidates) {
    const src = path.join(migrationsDir, entry.name);
    const dst = path.join(archiveDir, entry.name);
    console.log(`  ${entry.name}`);
    if (!dryRun) {
      await fs.rename(src, dst);
    }
  }
  if (dryRun) console.log("[archive-migrations] dry-run：未移动文件");
}

main().catch((err) => {
  console.error("[archive-migrations] 失败：", err);
  process.exit(1);
});
