import { statSync } from "node:fs";
import fg from "fast-glob";
import { z } from "zod";
import { MeshbotConfigService } from "../../config/meshbot-config.service";
import { Tool } from "../tool.decorator";
import type { MeshbotTool, ToolContext } from "../tool.types";

const RESULT_LIMIT = 1000;

const GlobArgsSchema = z.object({
  pattern: z.string().min(1).describe("Glob pattern, e.g. '**/*.ts'."),
  path: z
    .string()
    .optional()
    .describe("Base directory to search. Default: workspace directory."),
});
type GlobArgs = z.infer<typeof GlobArgsSchema>;

/** 按 glob 找文件，返回绝对路径，mtime 倒序（最近改的在前）。 */
@Tool()
export class GlobTool implements MeshbotTool<GlobArgs, string> {
  readonly name = "glob";
  readonly description =
    "Find files by glob pattern. Returns absolute paths sorted by modification time (newest first).";
  readonly schema = GlobArgsSchema;

  constructor(private readonly config: MeshbotConfigService) {}

  /** 在 workspace 目录下执行 glob 匹配并按 mtime 倒序返回结果。 */
  async execute(args: GlobArgs, _ctx: ToolContext): Promise<string> {
    const cwd = args.path ?? this.config.getWorkspaceDir();
    const matches = await fg(args.pattern, {
      cwd,
      absolute: true,
      dot: false,
      onlyFiles: true,
      suppressErrors: true,
    });
    if (matches.length === 0) return "No files matched.";
    const sorted = sortByMtimeDesc(matches).slice(0, RESULT_LIMIT);
    const more =
      matches.length > RESULT_LIMIT
        ? `\n[showing first ${RESULT_LIMIT} of ${matches.length}]`
        : "";
    return sorted.join("\n") + more;
  }
}

/** 按文件 mtime 倒序排序（读不到 stat 的当作最旧）。 */
export function sortByMtimeDesc(paths: string[]): string[] {
  return [...paths].sort((a, b) => mtimeOf(b) - mtimeOf(a));
}

function mtimeOf(p: string): number {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}
