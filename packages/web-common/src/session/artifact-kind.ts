/**
 * 产物预览类型分类（纯逻辑，按扩展名判定）。
 *
 * 从 `apps/web-agent/src/lib/artifact.ts` 迁入（Task 8）——原文件保留
 * `artifactRawUrl`（app 专属路由拼接，依赖 web-agent 自身 API 路由，不下沉），
 * `artifactKind`/`ArtifactKind` 改为从本模块 re-export。
 */
export type ArtifactKind =
  | "html"
  | "pdf"
  | "image"
  | "markdown"
  | "text"
  | "binary";

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);
const TEXT_EXTS = new Set([
  ".txt",
  ".csv",
  ".json",
  ".log",
  ".js",
  ".ts",
  ".py",
  ".sh",
  ".yml",
  ".yaml",
  ".xml",
]);

/** 按扩展名判定产物预览类型。 */
export function artifactKind(filePath: string): ArtifactKind {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  if (ext === ".html" || ext === ".htm") return "html";
  if (ext === ".pdf") return "pdf";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (ext === ".md" || ext === ".markdown") return "markdown";
  if (TEXT_EXTS.has(ext)) return "text";
  return "binary";
}
