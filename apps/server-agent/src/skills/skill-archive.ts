import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { AppError } from "@meshbot/common";
import * as tar from "tar";
import { AgentErrorCode } from "../errors/agent.error-codes";

/**
 * 将目录内容打包成 tar.gz Buffer（用于发布技能）。
 */
export async function packDir(dir: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const pack = tar.c(
      {
        gzip: true,
        cwd: dir,
        preservePaths: false,
      },
      ["."],
    );
    pack.on("data", (chunk: Buffer) => chunks.push(chunk));
    pack.on("end", resolve);
    pack.on("error", reject);
  });
  return Buffer.concat(chunks);
}

/**
 * 安全解包 tar.gz 到目标目录。
 *
 * 安全约束：每个 entry 的解析路径必须以 `destDir + path.sep` 开头，
 * 否则抛出 SKILL_UNSAFE_ARCHIVE（路径穿越 / 绝对路径 / 符号链接逃逸均被拒）。
 *
 * 解包前：清空并重建 destDir。
 */
export async function extractToDir(
  tarGz: Buffer,
  destDir: string,
): Promise<void> {
  const resolvedDest = path.resolve(destDir);
  const prefix = resolvedDest + path.sep;

  // 第一遍：扫描所有 entry 路径，遇到逃逸路径立即抛出（不写任何文件）
  await new Promise<void>((resolve, reject) => {
    const stream = Readable.from(tarGz);
    const parser = tar.t({
      onentry(entry: tar.ReadEntry) {
        const p = entry.path;
        if (!p || p === "." || p === "./") {
          entry.resume();
          return;
        }
        const resolved = path.resolve(resolvedDest, p);
        if (resolved !== resolvedDest && !resolved.startsWith(prefix)) {
          reject(new AppError(AgentErrorCode.SKILL_UNSAFE_ARCHIVE));
        }
        entry.resume();
      },
    });
    parser.on("finish", resolve);
    parser.on("error", reject);
    stream.on("error", reject);
    stream.pipe(parser);
  });

  // 路径安全验证通过后：清空目标目录并解包
  await rm(resolvedDest, { recursive: true, force: true });
  await mkdir(resolvedDest, { recursive: true });

  await new Promise<void>((resolve, reject) => {
    const stream = Readable.from(tarGz);
    const extract = tar.x({ cwd: resolvedDest, preservePaths: false });
    extract.on("finish", resolve);
    extract.on("error", (e: Error) => reject(e));
    stream.on("error", (e: Error) => reject(e));
    stream.pipe(extract);
  });
}

/**
 * 在 tar.gz 中查找含 SKILL.md 的目录。
 *
 * - SKILL.md 在根 → 返回 "."
 * - SKILL.md 在单层子目录（如 `repo-main/SKILL.md`）→ 返回该子目录名
 * - 无 SKILL.md → 返回 null
 */
export async function findSkillRoot(tarGz: Buffer): Promise<string | null> {
  const entries: string[] = [];

  await new Promise<void>((resolve, reject) => {
    const stream = Readable.from(tarGz);
    const parser = tar.t({
      onentry(entry: tar.ReadEntry) {
        entries.push(entry.path);
        entry.resume();
      },
    });
    parser.on("finish", resolve);
    parser.on("error", reject);
    stream.on("error", reject);
    stream.pipe(parser);
  });

  // 找含 SKILL.md 的路径
  const skillMdEntries = entries.filter((p) => path.basename(p) === "SKILL.md");

  for (const entry of skillMdEntries) {
    // 规范化：去掉前缀 "./"（tar.c 生成的路径带 "./"）
    const normalized = entry.replace(/^\.\//, "");
    const dir = path.dirname(normalized);
    // 根目录：dir === "." 或 entry === "SKILL.md"
    if (dir === "." || dir === "") {
      return ".";
    }
    // 单层子目录：dir 不含路径分隔符
    const parts = dir.split("/").filter(Boolean);
    if (parts.length === 1) {
      return parts[0];
    }
  }

  return null;
}
