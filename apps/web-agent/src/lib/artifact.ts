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

/** 构造产物 serving URL（相对，同源）。 */
export function artifactRawUrl(
  filePath: string,
  opts?: { download?: boolean },
): string {
  const base = `/api/artifacts/raw?path=${encodeURIComponent(filePath)}`;
  return opts?.download ? `${base}&download=1` : base;
}
