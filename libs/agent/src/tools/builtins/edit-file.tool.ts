import { existsSync, readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { MeshbotConfigService } from "../../config/meshbot-config.service";
import { Tool } from "../tool.decorator";
import type { MeshbotTool, ToolContext } from "../tool.types";
import { resolveFilePath } from "./file-path.util";
import { FileStateService } from "./file-state.service";
import { atomicWrite } from "./write-file.tool";

const CONTEXT_LINES = 3;

const EditArgsSchema = z.object({
  file_path: z
    .string()
    .min(1)
    .describe("Absolute path, or relative to the workspace directory."),
  old_string: z
    .string()
    .describe(
      "Exact text to replace. Must match uniquely unless replace_all is set.",
    ),
  new_string: z
    .string()
    .describe("Replacement text. Must differ from old_string."),
  replace_all: z
    .boolean()
    .optional()
    .describe("Replace every occurrence. Default false."),
});
type EditArgs = z.infer<typeof EditArgsSchema>;

/** 字符串精确匹配替换。要求本会话 read 过且未被改动。返回编辑后行号片段。 */
@Tool()
export class EditFileTool implements MeshbotTool<EditArgs, string> {
  readonly name = "edit_file";
  readonly description =
    "Replace an exact string in a file. old_string must match uniquely " +
    "(or set replace_all=true). Requires you to have read the file first this session. " +
    "Returns a line-numbered snippet of the edited region.";
  readonly schema = EditArgsSchema;

  constructor(
    private readonly config: MeshbotConfigService,
    private readonly fileState: FileStateService,
  ) {}

  async execute(args: EditArgs, ctx: ToolContext): Promise<string> {
    const abs = resolveFilePath(args.file_path, this.config.getWorkspaceDir());
    if (args.old_string === args.new_string) {
      return "Error: old_string and new_string are identical";
    }
    if (!existsSync(abs)) return `Error: ${abs} does not exist`;
    try {
      this.fileState.assertFresh(ctx.sessionId, abs, statSync(abs));
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
    const original = readFileSync(abs, "utf8");
    const count = countOccurrences(original, args.old_string);
    if (count === 0) return `Error: old_string not found in ${abs}`;
    if (count > 1 && !args.replace_all) {
      return `Error: old_string matches ${count} times in ${abs}; add more context to make it unique, or set replace_all=true`;
    }
    const updated = args.replace_all
      ? original.split(args.old_string).join(args.new_string)
      : original.replace(args.old_string, () => args.new_string);
    atomicWrite(abs, updated);
    this.fileState.recordWrite(ctx.sessionId, abs, statSync(abs));
    const n = args.replace_all ? count : 1;
    return `Edited ${abs} (${n} replacement(s))\n\n${snippetAround(updated, args.new_string)}`;
  }
}

/** 数全部非重叠出现次数。 */
function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let n = 0;
  let i = haystack.indexOf(needle, 0);
  while (i !== -1) {
    n++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

/** 定位 marker 首次出现所在行，输出其 ± CONTEXT_LINES 行的 cat -n 片段。 */
function snippetAround(text: string, marker: string): string {
  const idx = marker === "" ? -1 : text.indexOf(marker);
  const markerLine = (idx < 0 ? text : text.slice(0, idx)).split("\n").length;
  const lines = text.split("\n");
  const start = Math.max(0, markerLine - 1 - CONTEXT_LINES);
  const end = Math.min(lines.length, markerLine + CONTEXT_LINES);
  const width = String(end).length;
  const out: string[] = [];
  for (let i = start; i < end; i++) {
    out.push(`${String(i + 1).padStart(width, " ")}\t${lines[i]}`);
  }
  return out.join("\n");
}
