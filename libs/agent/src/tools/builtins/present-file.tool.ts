import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { type PresentFileInput, presentFileSchema } from "@meshbot/types-agent";
import { MeshbotConfigService } from "../../config/meshbot-config.service";
import { Tool } from "../tool.decorator";
import type { MeshbotTool, ToolContext } from "../tool.types";
import { resolveFilePath } from "./file-path.util";

@Tool()
export class PresentFileTool implements MeshbotTool<PresentFileInput, string> {
  readonly name = "present_file";
  readonly description =
    "Present a finished result file (report, web page, chart, PDF, image, etc.) " +
    "to the user as a clickable preview card. Call this AFTER you have produced " +
    "the final artifact in the workspace. Do NOT call it for intermediate/scratch " +
    "files. The path is absolute or relative to the workspace directory.";
  readonly schema = presentFileSchema;

  constructor(private readonly config: MeshbotConfigService) {}

  /**校验文件在 workspace 内且存在，返回相对路径 + 元信息（JSON）。 */
  execute(args: PresentFileInput, _ctx: ToolContext): Promise<string> {
    const workspaceDir = this.config.getWorkspaceDir();
    const abs = resolveFilePath(args.path, workspaceDir);
    if (abs !== workspaceDir && !abs.startsWith(workspaceDir + path.sep)) {
      return Promise.resolve(
        `Error: path is outside the workspace: ${args.path}`,
      );
    }
    if (!existsSync(abs)) {
      return Promise.resolve(`Error: file does not exist: ${args.path}`);
    }
    const rel = path.relative(workspaceDir, abs);
    const result = {
      status: "presented",
      path: rel,
      name: path.basename(abs),
      size: statSync(abs).size,
    };
    return Promise.resolve(JSON.stringify(result));
  }
}
