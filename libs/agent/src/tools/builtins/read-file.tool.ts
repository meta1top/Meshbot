import { readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { MeshbotConfigService } from "../../config/meshbot-config.service";
import { Tool } from "../tool.decorator";
import type { MeshbotTool, ToolContext } from "../tool.types";
import { resolveFilePath } from "./file-path.util";
import { FileStateService } from "./file-state.service";

const DEFAULT_LIMIT = 2000;
const MAX_LINE = 2000;

const ReadArgsSchema = z.object({
  file_path: z
    .string()
    .min(1)
    .describe("Absolute path, or relative to the workspace directory."),
  offset: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("1-based start line. Default 1."),
  limit: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(`Max lines to read. Default ${DEFAULT_LIMIT}.`),
});
type ReadArgs = z.infer<typeof ReadArgsSchema>;

/** 读文本文件并以 cat -n（行号 + Tab + 内容）返回。读后记录新鲜度基线。 */
@Tool()
export class ReadFileTool implements MeshbotTool<ReadArgs, string> {
  readonly name = "read_file";
  readonly description =
    "Read a text file. Returns cat -n style (line number + tab + content). " +
    "Use offset/limit for large files. You MUST read a file before editing or overwriting it.";
  readonly schema = ReadArgsSchema;

  constructor(
    private readonly config: MeshbotConfigService,
    private readonly fileState: FileStateService,
  ) {}

  async execute(args: ReadArgs, ctx: ToolContext): Promise<string> {
    const abs = resolveFilePath(args.file_path, this.config.getWorkspaceDir());
    let raw: Buffer;
    let stat: { mtimeMs: number; size: number };
    try {
      stat = statSync(abs);
      raw = readFileSync(abs);
    } catch {
      return `Error: cannot read ${abs} (not found or not accessible)`;
    }
    if (isBinary(raw)) {
      return `Error: ${abs} appears to be a binary file; refusing to read as text`;
    }
    this.fileState.recordRead(ctx.sessionId, abs, stat);
    const text = raw.toString("utf8");
    if (text.length === 0) return `(file ${abs} is empty)`;
    return formatNumbered(text, args.offset ?? 1, args.limit ?? DEFAULT_LIMIT);
  }
}

/** 探测前 8KB 是否含 NUL 字节，有则视作二进制。 */
function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/** 从 offset 起取 limit 行，按 cat -n 渲染，单行超 MAX_LINE 截断。 */
function formatNumbered(text: string, offset: number, limit: number): string {
  const lines = text.split("\n");
  const start = offset - 1;
  const slice = lines.slice(start, start + limit);
  const width = String(start + slice.length).length;
  return slice
    .map((line, i) => {
      const n = String(start + i + 1).padStart(width, " ");
      const body =
        line.length > MAX_LINE
          ? `${line.slice(0, MAX_LINE)}… [line truncated]`
          : line;
      return `${n}\t${body}`;
    })
    .join("\n");
}
