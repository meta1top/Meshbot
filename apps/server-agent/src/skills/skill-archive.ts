import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { AppError } from "@meshbot/common";
import { unzipSync, zipSync } from "fflate";
import { AgentErrorCode } from "../errors/agent.error-codes";

/** 递归收集目录文件为 {相对路径: 内容}。 */
async function collectFiles(
  root: string,
  rel = "",
  acc: Record<string, Uint8Array> = {},
): Promise<Record<string, Uint8Array>> {
  const dir = path.join(root, rel);
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const childRel = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) {
      await collectFiles(root, childRel, acc);
    } else if (ent.isFile()) {
      acc[childRel] = await readFile(path.join(root, childRel));
    }
  }
  return acc;
}

/**
 * 将目录内容打包成 zip Buffer（用于发布技能）。
 */
export async function packDir(dir: string): Promise<Buffer> {
  const files = await collectFiles(dir);
  return Buffer.from(zipSync(files));
}

/**
 * 安全解包 zip 到目标目录。
 *
 * 安全约束：每个 entry 的解析路径必须以 `destDir + path.sep` 开头，
 * 否则抛出 SKILL_UNSAFE_ARCHIVE（路径穿越 / 绝对路径均被拒）。
 * 先全量校验所有路径，通过后才清空 destDir 并写文件（先验后写）。
 */
export async function extractToDir(
  zip: Buffer,
  destDir: string,
): Promise<void> {
  const resolvedDest = path.resolve(destDir);
  const prefix = resolvedDest + path.sep;
  const entries = unzipSync(zip);

  // 第一遍：校验所有路径，逃逸即抛（不写任何文件）
  for (const name of Object.keys(entries)) {
    if (!name || name.endsWith("/")) {
      continue;
    }
    const resolved = path.resolve(resolvedDest, name);
    if (resolved !== resolvedDest && !resolved.startsWith(prefix)) {
      throw new AppError(AgentErrorCode.SKILL_UNSAFE_ARCHIVE);
    }
  }

  // 通过后：清空重建并写文件
  await rm(resolvedDest, { recursive: true, force: true });
  await mkdir(resolvedDest, { recursive: true });
  for (const [name, data] of Object.entries(entries)) {
    if (!name || name.endsWith("/")) {
      continue;
    }
    const target = path.resolve(resolvedDest, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data);
  }
}

/**
 * 在 zip 中查找含 SKILL.md 的目录。
 *
 * - SKILL.md 在根 → 返回 "."
 * - SKILL.md 在单层子目录（如 `repo-main/SKILL.md`）→ 返回该子目录名
 * - 无 SKILL.md → 返回 null
 */
export async function findSkillRoot(zip: Buffer): Promise<string | null> {
  const names = Object.keys(unzipSync(zip));
  const skillMd = names.filter((p) => path.basename(p) === "SKILL.md");

  for (const entry of skillMd) {
    const dir = path.dirname(entry);
    if (dir === "." || dir === "") {
      return ".";
    }
    const parts = dir.split("/").filter(Boolean);
    if (parts.length === 1) {
      return parts[0];
    }
  }

  return null;
}
