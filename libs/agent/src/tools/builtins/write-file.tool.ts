import {
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import { MeshbotConfigService } from "../../config/meshbot-config.service";
import { Tool } from "../tool.decorator";
import type { MeshbotTool, ToolContext } from "../tool.types";
import { resolveFilePath } from "./file-path.util";
import { FileStateService } from "./file-state.service";

const WriteArgsSchema = z.object({
  file_path: z
    .string()
    .min(1)
    .describe("Absolute path, or relative to the workspace directory."),
  content: z.string().describe("Full file content to write."),
});
type WriteArgs = z.infer<typeof WriteArgsSchema>;

/** 原子写文件：创建或覆写。覆写已存在文件前要求本会话 read 过且未被改动。 */
@Tool()
export class WriteFileTool implements MeshbotTool<WriteArgs, string> {
  readonly name = "write_file";
  readonly description =
    "Write (create or overwrite) a text file with the given content. " +
    "Overwriting an existing file requires you to have read it first this session. " +
    "Creates parent directories as needed.";
  readonly schema = WriteArgsSchema;

  constructor(
    private readonly config: MeshbotConfigService,
    private readonly fileState: FileStateService,
  ) {}

  async execute(args: WriteArgs, ctx: ToolContext): Promise<string> {
    const abs = resolveFilePath(args.file_path, this.config.getWorkspaceDir());
    if (existsSync(abs)) {
      try {
        this.fileState.assertFresh(ctx.sessionId, abs, statSync(abs));
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    try {
      atomicWrite(abs, args.content);
    } catch (err) {
      return `Error: cannot write ${abs}: ${err instanceof Error ? err.message : String(err)}`;
    }
    this.fileState.recordWrite(ctx.sessionId, abs, statSync(abs));
    const lineCount = args.content === "" ? 0 : args.content.split("\n").length;
    return `Wrote ${lineCount} line(s) to ${abs}`;
  }
}

let tmpSeq = 0;

/** 原子写：同目录临时文件 + rename（同盘原子），杜绝半成品文件。 */
export function atomicWrite(abs: string, content: string): void {
  const dir = path.dirname(abs);
  mkdirSync(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(abs)}.${process.pid}.${tmpSeq++}.tmp`,
  );
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, abs);
}
