import { readFileSync } from "node:fs";
import { load } from "js-yaml";

/** 深合并两个普通对象：后者覆盖前者，嵌套对象递归合并（数组按整体替换）。 */
function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      continue;
    }
    const prev = out[key];
    const bothPlainObject =
      prev !== null &&
      typeof prev === "object" &&
      !Array.isArray(prev) &&
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value);
    out[key] = bothPlainObject
      ? deepMerge(
          prev as Record<string, unknown>,
          value as Record<string, unknown>,
        )
      : value;
  }
  return out;
}

/** 读取一组本地 YAML 文件并深合并成嵌套配置对象。文件不存在则跳过。 */
export function loadYamlConfig(paths: string[]): Record<string, unknown> {
  let merged: Record<string, unknown> = {};
  for (const filePath of paths) {
    let raw: string;
    try {
      raw = readFileSync(filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    const parsed = load(raw);
    if (parsed === null || parsed === undefined) continue;
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(
        `[config-loader] YAML 文件 ${filePath} 顶层必须是对象（map）。`,
      );
    }
    merged = deepMerge(merged, parsed as Record<string, unknown>);
  }
  return merged;
}
