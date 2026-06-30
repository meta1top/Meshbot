import type { DriveNode } from "@/rest/drive";

export type SortKey = "name" | "size" | "modified";
export type SortDir = "asc" | "desc";

/**
 * 网盘列表排序：文件夹始终排在文件之前（不受方向影响），组内按 key 排序。
 * - name：按中文/字母 localeCompare
 * - size：按 sizeBytes 数值
 * - modified：按 updatedAt（ISO 字符串，可直接比较）
 */
export function sortNodes(
  nodes: DriveNode[],
  key: SortKey,
  dir: SortDir,
): DriveNode[] {
  const factor = dir === "asc" ? 1 : -1;
  return [...nodes].sort((a, b) => {
    if (a.type !== b.type) {
      // 文件夹恒在文件前
      return a.type === "folder" ? -1 : 1;
    }
    let cmp = 0;
    if (key === "name") {
      cmp = a.name.localeCompare(b.name, "zh");
    } else if (key === "size") {
      cmp = a.sizeBytes - b.sizeBytes;
    } else {
      cmp = a.updatedAt.localeCompare(b.updatedAt);
    }
    return cmp * factor;
  });
}
