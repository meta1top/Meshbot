import { spawn } from "node:child_process";
import { rgPath } from "@vscode/ripgrep";
import { z } from "zod";
import { MeshbotConfigService } from "../../config/meshbot-config.service";
import { Tool } from "../tool.decorator";
import type { MeshbotTool, ToolContext } from "../tool.types";

const TIMEOUT_MS = 30_000;
const OUTPUT_LIMIT = 30_000;

const GrepArgsSchema = z.object({
  pattern: z.string().min(1).describe("Regular expression to search for."),
  path: z
    .string()
    .optional()
    .describe("File or directory to search. Default: workspace directory."),
  glob: z.string().optional().describe("Glob to filter files, e.g. '*.ts'."),
  type: z.string().optional().describe("ripgrep file type filter, e.g. 'ts'."),
  output_mode: z
    .enum(["files_with_matches", "content", "count"])
    .optional()
    .describe("files_with_matches (default) | content | count."),
  case_insensitive: z.boolean().optional().describe("Case-insensitive (-i)."),
  context: z
    .number()
    .int()
    .min(0)
    .max(20)
    .optional()
    .describe("Lines of surrounding context for content mode (-C)."),
  head_limit: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe("Cap number of output lines."),
});
type GrepArgs = z.infer<typeof GrepArgsSchema>;

/** 用 ripgrep 搜索文件内容（正则）。默认遵守 .gitignore。 */
@Tool()
export class GrepTool implements MeshbotTool<GrepArgs, string> {
  readonly name = "grep";
  readonly description =
    "Search file contents with ripgrep (regular expressions). Respects .gitignore by default.";
  readonly schema = GrepArgsSchema;

  constructor(private readonly config: MeshbotConfigService) {}

  /** 在 workspace 目录下执行 ripgrep 搜索并返回结果字符串。 */
  async execute(args: GrepArgs, ctx: ToolContext): Promise<string> {
    const cwd = this.config.getWorkspaceDir();
    return runRg(buildRgArgs(args), cwd, ctx.signal, args.head_limit);
  }
}

/** 把 GrepArgs 映射为 rg 命令行参数（纯函数，便于单测）。 */
export function buildRgArgs(args: GrepArgs): string[] {
  const argv: string[] = [];
  const mode = args.output_mode ?? "files_with_matches";
  if (mode === "files_with_matches") argv.push("-l");
  else if (mode === "count") argv.push("-c");
  else argv.push("-n");
  if (args.case_insensitive) argv.push("-i");
  if (mode === "content" && args.context !== undefined) {
    argv.push("-C", String(args.context));
  }
  if (args.glob) argv.push("-g", args.glob);
  if (args.type) argv.push("-t", args.type);
  argv.push("--", args.pattern);
  argv.push(args.path ?? ".");
  return argv;
}

/** spawn rg，收集 stdout，封顶 + head_limit；exit code 1（无匹配）不视作错误。 */
function runRg(
  argv: string[],
  cwd: string,
  signal: AbortSignal,
  headLimit?: number,
): Promise<string> {
  return new Promise((resolve) => {
    const buf: string[] = [];
    let len = 0;
    const child = spawn(rgPath, argv, { cwd, signal });
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
    child.stdout.on("data", (c: Buffer) => {
      if (len < OUTPUT_LIMIT) {
        const s = c.toString("utf8");
        buf.push(s);
        len += s.length;
      }
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (err.name === "AbortError" || err.code === "ABORT_ERR") {
        resolve("[search aborted]");
      } else {
        resolve(`Error: ripgrep failed: ${err.message}`);
      }
    });
    child.on("close", () => {
      clearTimeout(timer);
      let out = buf.join("");
      if (headLimit !== undefined) {
        out = out.split("\n").slice(0, headLimit).join("\n");
      }
      if (out.length > OUTPUT_LIMIT) {
        out = `${out.slice(0, OUTPUT_LIMIT)}\n[output truncated]`;
      }
      resolve(out.trim() === "" ? "No matches found." : out);
    });
  });
}
