import path from "node:path";

/** 绝对路径直接 normalize；相对路径对 workspaceDir 解析。 */
export function resolveFilePath(
  filePath: string,
  workspaceDir: string,
): string {
  return path.isAbsolute(filePath)
    ? path.normalize(filePath)
    : path.resolve(workspaceDir, filePath);
}
